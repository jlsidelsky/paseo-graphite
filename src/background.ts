import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { agentsOnPr, alertFor, DAEMON_URL, parsePr, SETTINGS, type Alert, type Pr, type Workspace } from "./pr";

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
        snapshot: (s) => ((workspaces = new Map(s.entries.map((w) => [w.id, w]))), changed()),
        update: (m) => {
          if (m.type !== "workspace_update") return;
          if (m.payload.kind === "upsert") workspaces.set(m.payload.workspace.id, m.payload.workspace);
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
  return { count: on.length, running: on.filter((a) => a.status === "running").length };
}

// Chained so quick successive sends append instead of overwriting each other.
let drafting = Promise.resolve();

// ext/review.js text for the panel's composer, per window; the panel takes it on load or on change.
function queueDraft(windowId: number, text: string) {
  const key = `draft:${windowId}`;
  drafting = drafting
    .then(async () => {
      const prev = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.set({ [key]: typeof prev === "string" && prev ? `${prev}\n\n${text}` : text });
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
function changed() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    for (const { id, pr } of await prTabs()) void send(id, { type: "pr-sessions", ...counts(pr) });
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

chrome.notifications.onClicked.addListener((id) => {
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
    queueDraft(sender.tab.windowId, msg.text);
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
  if (msg.type === "pr-sessions") {
    const pr = parsePr(msg.url);
    const live = async () => pr && (await ready()) && (await Promise.all([agentsLive, workspacesLive])).every(Boolean) ? counts(pr) : null;
    live().then(reply, () => reply(null));
    return true;
  }
});
