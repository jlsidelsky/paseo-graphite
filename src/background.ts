import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { agentsOnPr, alertFor, ciAlertFor, DAEMON_URL, groupStacks, isRepo, parsePr, rowAuthor, rowPr, SETTINGS, type Alert, type Pr, type Workspace } from "./pr";

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// The daemon client pings every 10s while connected, which keeps this worker alive (Chrome 116+).
// The alarm restarts it if Chrome stops it anyway; waking up is all the handler needs to do.
void chrome.alarms.create("wake", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});

const daemon = new DaemonClient({ url: DAEMON_URL, clientId: "paseo-graphite-bg", clientType: "browser" });
const paseo = createPaseoApi(daemon);

// ponytail: stays connected while Chrome runs, even with no Graphite tab open; gate on PR tabs if that matters.
// ponytail: state is in memory, so a change that lands while the worker is restarting doesn't alert.
let agents = new Map<string, PaseoAgent>();
let workspaces = new Map<string, Workspace>();
let agentsLive: Promise<unknown> | undefined;
let workspacesLive: Promise<unknown> | undefined;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

function trackWorkspace(w: Workspace, prev: Workspace | undefined) {
  workspaces.set(w.id, w);
  const gh = w.githubRuntime?.pullRequest;
  const pr = parsePr(gh?.url ?? undefined);
  if (gh && pr && ciAlertFor(prev?.githubRuntime?.pullRequest, gh) && onPr([...agents.values()], pr).length) void ciAlert(pr, gh.title ?? "");
}

function track(agent: PaseoAgent, prev: PaseoAgent | undefined) {
  agents.set(agent.id, agent);
  const kind = alertFor(prev, agent);
  if (kind) void alert(agent, kind);
}

// Owned subscriptions re-subscribe and re-snapshot after a reconnect on their own; this only retries a failed first request.
function subscribe() {
  agentsLive ??= paseo.agents
    .list({ subscribe: {} })
    .then((r) => {
      r.subscription.subscribe({
        snapshot: (s) => {
          const prev = agents;
          agents = new Map();
          for (const { agent } of s.entries) track(agent, prev.get(agent.id));
          changed();
        },
        update: (m) => {
          if (m.type !== "agent_update") return;
          if (m.payload.kind === "upsert") track(m.payload.agent, agents.get(m.payload.agent.id));
          else agents.delete(m.payload.agentId);
          changed();
        },
      });
      return true;
    })
    .catch(() => (agentsLive = undefined));
  workspacesLive ??= paseo.workspaces
    .list({ subscribe: {} })
    .then((r) => {
      r.subscription.subscribe({
        snapshot: (s) => {
          const prev = workspaces;
          workspaces = new Map();
          for (const w of s.entries) trackWorkspace(w, prev.get(w.id));
          changed();
        },
        update: (m) => {
          if (m.type !== "workspace_update") return;
          if (m.payload.kind === "upsert") trackWorkspace(m.payload.workspace, workspaces.get(m.payload.workspace.id));
          else workspaces.delete(m.payload.id);
          changed();
        },
      });
      return true;
    })
    .catch(() => (workspacesLive = undefined));
}

const connected = () => daemon.getConnectionState().status === "connected";

daemon.subscribeConnectionStatus((s) => {
  if (s.status === "connected") subscribe();
});
daemon.connect().catch(() => {});

// The worker may have just woken up, so give the daemon a moment before answering.
function ready() {
  return new Promise<boolean>((resolve) => {
    if (connected()) return resolve(true);
    const timer = setTimeout(() => (off(), resolve(false)), 5000);
    const off = daemon.subscribeConnectionStatus((s) => {
      if (s.status === "connected") (clearTimeout(timer), off(), resolve(true));
    });
  });
}

const onPr = (list: PaseoAgent[], pr: Pr) => agentsOnPr([...workspaces.values()], list, pr).filter((a) => !a.archivedAt);

function counts(pr: Pr) {
  const on = onPr([...agents.values()], pr);
  return { count: on.length, running: on.filter((a) => a.status === "running").length, needsYou: on.filter((a) => a.pendingPermissions?.length).length };
}

// Inbox and PR-list tabs (ext/inbox.js): the rows they last sent, to push each row's counts as sessions change.
// ponytail: in memory, so after a worker restart a tab gets no pushes until its rows change.
const inboxTabs = new Map<number, { seq: number; rows: { pr: Pr | null; url?: string }[] }>();
chrome.tabs.onRemoved.addListener((id) => inboxTabs.delete(id));

// Aligned with the rows; null for a row with no sessions. `url` is what the pill hands to "open-pr".
const rowStates = ({ seq, rows }: { seq: number; rows: { pr: Pr | null; url?: string }[] }) => ({
  seq,
  states: rows.map(({ pr, url }) => {
    const c = pr && counts(pr);
    return pr && c?.count ? { ...c, url: parsePr(url) ? url : `https://app.graphite.com/github/pr/${pr.owner}/${pr.repo}/${pr.number}` } : null;
  }),
});

// Inbox stacks: each row's base and head branch, from GitHub via Paseo, in a workspace of that repo (none: not grouped).
// One search per author and repo covers most rows; a row it misses gets its own. Kept 5 minutes, or until the row changes.
type Branches = { base: string; head: string } | null;
type ForgePr = { number: number; baseRefName?: string; headRefName?: string };
const FRESH = 5 * 60_000;
const branchCache = new Map<string, { at: number; sig: string; p: Promise<Branches> }>();
const authorCache = new Map<string, { at: number; p: Promise<ForgePr[]> }>();

function cached<T>(cache: Map<string, { at: number; p: Promise<T> }>, key: string, load: () => Promise<T>, extra = {}) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH) return hit.p;
  // A failed search isn't kept.
  const p: Promise<T> = load().catch((e) => (cache.get(key)?.p === p && cache.delete(key), Promise.reject(e)));
  cache.set(key, { at: Date.now(), p, ...extra });
  return p;
}

// Rows as ext/inbox.js sends them; `stacks[].rows` index into them.
async function inboxStacks(raw: { href?: string; sub?: string; title?: string; section?: string }[]) {
  if (!(await ready()) || !(await workspacesLive)) return null;
  const started = Date.now();
  const rows = raw.map((r) => ({ pr: rowPr(r?.href, r?.sub), author: rowAuthor(r?.sub), sig: `${r?.title}\n${r?.sub}`, section: String(r?.section ?? "") }));
  const search = (cwd: string, query: string, limit: number) =>
    daemon.searchForge({ cwd, query, limit, kinds: ["pr"] }).then((r) => r.items as ForgePr[]);
  const branches = async ({ pr, author, sig }: (typeof rows)[number]): Promise<Branches> => {
    const cwd = pr && [...workspaces.values()].find((w) => isRepo(w, pr))?.workspaceDirectory;
    if (!pr || !cwd) return null;
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    const byAuthor = `${pr.owner}/${pr.repo}:${author}`;
    // A changed row (new title, labels, stack position) refetches its author's PRs too.
    const hit = branchCache.get(key);
    if (hit && hit.sig !== sig) {
      branchCache.delete(key);
      if ((authorCache.get(byAuthor)?.at ?? started) < started) authorCache.delete(byAuthor);
    }
    return cached(branchCache, key, async () => {
      // The search caps at 50; an author with more open PRs falls back per PR.
      const mine = author ? await cached(authorCache, byAuthor, () => search(cwd, `is:pr is:open author:${author}`, 50)) : [];
      const i = mine.find((i) => i.number === pr.number) ?? (await search(cwd, String(pr.number), 10)).find((i) => i.number === pr.number);
      return i?.baseRefName && i.headRefName ? { base: i.baseRefName, head: i.headRefName } : null;
    }, { sig });
  };
  const info = await Promise.all(rows.map((r) => branches(r).catch(() => null)));
  return { stacks: groupStacks(rows.map((r, i) => (r.pr && info[i] ? { ...r.pr, section: r.section, ...info[i] } : null))) };
}

// Chained so quick successive sends append instead of overwriting each other.
let drafting = Promise.resolve();

// ext/review.js text for the panel's composer, per window; the panel takes it on load or on change.
function queueDraft(windowId: number, draft: { text: string; intent?: string; fresh: boolean }) {
  const key = `draft:${windowId}`;
  drafting = drafting
    .then(async () => {
      const prev = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.set({ [key]: [...(Array.isArray(prev) ? prev : []), draft] });
    })
    .catch(() => {});
}

async function prTabs() {
  return (await chrome.tabs.query({})).flatMap((tab) => {
    const pr = parsePr(tab.url);
    return pr && tab.id !== undefined ? [{ tab, id: tab.id, pr }] : [];
  });
}

const send = (tabId: number, msg: object) => chrome.tabs.sendMessage(tabId, msg).catch(() => {});

// Sessions update many times a turn; push once things settle.
// Windows with the side panel open; the panel holds a port for as long as it's open.
const openPanels = new Set<number>();
chrome.runtime.onConnect.addListener((port) => {
  const windowId = Number(port.name.match(/^panel:(\d+)$/)?.[1]);
  if (!windowId) return;
  openPanels.add(windowId);
  changed();
  port.onDisconnect.addListener(() => (openPanels.delete(windowId), changed()));
});

function changed() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    for (const { id, pr, tab } of await prTabs()) void send(id, { type: "pr-sessions", ...counts(pr), panelOpen: openPanels.has(tab.windowId) });
    for (const [id, tab] of inboxTabs) void send(id, { type: "inbox-sessions", ...rowStates(tab) });
  }, 300);
}

async function alert(agent: PaseoAgent, kind: Alert) {
  const tabs = (await prTabs()).filter(({ pr }) => onPr([agent], pr).length);
  if (!tabs.length) return;
  const [win, settings] = await Promise.all([chrome.windows.getLastFocused().catch(() => undefined), chrome.storage.sync.get(SETTINGS)]);
  // Already looking at it.
  if (tabs.some(({ tab }) => tab.active && win?.focused && tab.windowId === win.id)) return;
  if (settings.markTab) for (const { id } of tabs) void send(id, { type: "mark" });
  if (!settings.notify) return;
  const { tab, pr } = tabs[0];
  chrome.notifications.create(`${tab.windowId}:${tab.id}:${agent.id}`, {
    type: "basic",
    iconUrl: "icons/128.png",
    title: `${kind === "done" ? "Finished" : "Needs you"} · PR #${pr.number}`,
    message: agent.title ?? "Paseo session",
  });
}

// With no tab on the PR, still notify: the panel opens it pinned in the last focused window.
// ponytail: two workspaces on the same PR flipping together show one notification (same id), but may sound twice.
async function ciAlert(pr: Pr, title: string) {
  const [tabs, win, settings] = await Promise.all([prTabs(), chrome.windows.getLastFocused().catch(() => undefined), chrome.storage.sync.get(SETTINGS)]);
  if (!settings.ciAlerts) return;
  const on = tabs.filter((t) => t.pr.owner === pr.owner && t.pr.repo === pr.repo && t.pr.number === pr.number);
  if (on.some(({ tab }) => tab.active && win?.focused && tab.windowId === win.id)) return;
  if (settings.markTab) for (const { id } of on) void send(id, { type: "mark" });
  const windowId = on[0]?.tab.windowId ?? win?.id;
  if (!settings.notify || windowId === undefined) return;
  chrome.notifications.create(`ci|${windowId}|https://app.graphite.com/github/pr/${pr.owner}/${pr.repo}/${pr.number}`, {
    type: "basic",
    iconUrl: "icons/128.png",
    title: `CI failing · PR #${pr.number}`,
    message: title || "Checks failed",
    buttons: [{ title: "Fix CI" }],
  });
}

// The panel reads the key, shows the PR pinned and, for Fix CI, opens its Fix CI menu.
function openCi(id: string, fixCi: boolean) {
  const [, windowId, url] = id.split("|");
  void chrome.sidePanel.open({ windowId: Number(windowId) });
  void chrome.windows.update(Number(windowId), { focused: true }).catch(() => {});
  void chrome.storage.session.set({ [`open:${windowId}`]: { url, at: Date.now(), fixCi } });
  chrome.notifications.clear(id);
}

chrome.notifications.onButtonClicked.addListener((id) => {
  if (id.startsWith("ci|")) openCi(id, true);
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("ci|")) return openCi(id, false);
  const [windowId, tabId] = id.split(":").map(Number);
  // sidePanel.open needs the click's user gesture, so it goes first and unawaited.
  void chrome.sidePanel.open({ windowId });
  void chrome.tabs.update(tabId, { active: true }).catch(() => {});
  void chrome.windows.update(windowId, { focused: true }).catch(() => {});
  chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "to-paseo" && sender.tab && typeof msg.text === "string") {
    void chrome.sidePanel.open({ windowId: sender.tab.windowId });
    const intent = msg.intent === "evaluate" || msg.intent === "address" ? msg.intent : undefined;
    queueDraft(sender.tab.windowId, { text: msg.text, intent, fresh: msg.fresh === true });
    return;
  }
  // From ext/linear.js; the panel reads the key, opens its new-session form for the ticket, and removes it.
  if (msg.type === "start-session" && sender.tab && typeof msg.ticket?.id === "string") {
    void chrome.sidePanel.open({ windowId: sender.tab.windowId });
    void chrome.storage.session.set({ [`start:${sender.tab.windowId}`]: { ...msg.ticket, at: Date.now() } });
    return;
  }
  if (msg.type === "open-panel" && sender.tab) {
    void chrome.sidePanel.open({ windowId: sender.tab.windowId });
    return;
  }
  // A pill on an inbox row: open the panel on that PR, pinned, without navigating the page. The panel reads the key and removes it.
  if (msg.type === "open-pr" && sender.tab && parsePr(msg.url)) {
    void chrome.sidePanel.open({ windowId: sender.tab.windowId });
    void chrome.storage.session.set({ [`open:${sender.tab.windowId}`]: { url: msg.url, at: Date.now() } });
    return;
  }
  if (msg.type === "inbox-rows" && sender.tab?.id !== undefined && Array.isArray(msg.rows)) {
    const tab = { seq: Number(msg.seq), rows: (msg.rows as { href?: string; sub?: string }[]).map((r) => ({ pr: rowPr(r.href, r.sub), url: r.href })) };
    const id = sender.tab.id;
    if (tab.rows.length) inboxTabs.set(id, tab);
    else inboxTabs.delete(id);
    const live = async () => (await ready()) && (await Promise.all([agentsLive, workspacesLive])).every(Boolean) ? rowStates(tab) : null;
    live().then(reply, () => reply(null));
    return true;
  }
  if (msg.type === "inbox-stacks" && Array.isArray(msg.rows)) {
    inboxStacks(msg.rows).then(reply, () => reply(null));
    return true;
  }
  if (msg.type === "pr-sessions") {
    const pr = parsePr(msg.url);
    const panelOpen = sender.tab ? openPanels.has(sender.tab.windowId) : false;
    const live = async () => pr && (await ready()) && (await Promise.all([agentsLive, workspacesLive])).every(Boolean) ? { ...counts(pr), panelOpen } : null;
    live().then(reply, () => reply(null));
    return true;
  }
});
