import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import MarkdownIt from "markdown-it";
import { DAEMON_URL, isPrWorkspace as onPr, isRepo, parsePr, prLabel, sessionsForPr, type Pr, type Workspace } from "./pr";

const NEW_WORKTREE = "__new__";

// html:false renders raw HTML as text, and markdown-it refuses javascript: links; agent text never runs in this page.
const md = new MarkdownIt({ linkify: true });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const agentSelect = $<HTMLSelectElement>("agent-select");
const workspaceSelect = $<HTMLSelectElement>("workspace-select");
const modelSelect = $<HTMLSelectElement>("model-select");
const effortSelect = $<HTMLSelectElement>("effort-select");
const timeline = $<HTMLDivElement>("timeline");
const statusText = $<HTMLSpanElement>("status-text");
const openInPaseo = $<HTMLAnchorElement>("open-in-paseo");
const prompt = $<HTMLTextAreaElement>("prompt");
const sendBtn = $<HTMLButtonElement>("send-btn");
const newBtn = $<HTMLButtonElement>("new-btn");
const unarchiveBtn = $<HTMLButtonElement>("unarchive-btn");

const daemon = new DaemonClient({ url: DAEMON_URL, clientId: "paseo-graphite", clientType: "browser" });
const paseo = createPaseoApi(daemon);

type TimelineEntry = Awaited<ReturnType<ReturnType<typeof paseo.agents.ref>["timeline"]["refetch"]>>["entries"][number];

let pr: Pr | null = null;
let tabUrl: string | undefined;
let workspaces: Workspace[] = [];
let agents: PaseoAgent[] = [];
let selectedId: string | null = null;
let unsubscribeTimeline: (() => void) | null = null;
let refetchTimer: ReturnType<typeof setTimeout> | undefined;

const isPrWorkspace = (w: Workspace) => onPr(w, pr);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function markdown(text: string) {
  const node = el("div", { className: "msg md" });
  node.innerHTML = md.render(text);
  return node;
}

function setStatus(text: string) {
  statusText.textContent = text;
}

const isCreating = () => document.body.classList.contains("creating");

async function loadSessions() {
  if (!pr) {
    agentSelect.replaceChildren(el("option", { textContent: "Open a Graphite PR" }));
    selectAgent(null);
    return;
  }
  ({ workspaces, agents } = await sessionsForPr(paseo, pr));

  const option = (a: PaseoAgent) => el("option", { value: a.id, textContent: `${a.status === "running" ? "● " : ""}${a.title ?? a.id.slice(0, 8)}` });
  const active = agents.filter((a) => !a.archivedAt);
  const archived = agents.filter((a) => a.archivedAt);
  agents = [...active, ...archived];
  agentSelect.replaceChildren(
    ...(agents.length
      ? [...active.map(option), ...(archived.length ? [el("optgroup", { label: "Archived" }, ...archived.map(option))] : [])]
      : [el("option", { textContent: `No sessions for #${pr.number}` })]),
  );
  const keep = agents.find((a) => a.id === selectedId)?.id ?? agents[0]?.id ?? null;
  if (keep) agentSelect.value = keep;
  selectAgent(keep);
}

function selectAgent(id: string | null) {
  if (id === selectedId && unsubscribeTimeline) return;
  unsubscribeTimeline?.();
  unsubscribeTimeline = null;
  selectedId = id;
  document.body.classList.toggle("archived", !!agents.find((a) => a.id === id)?.archivedAt);
  timeline.replaceChildren();
  openInPaseo.hidden = !id;
  if (!id) {
    setStatus(pr ? `PR #${pr.number}` : `Not on a Graphite PR (${tabUrl ?? "tab URL not readable"})`);
    if (pr && !isCreating()) {
      timeline.append(el("div", { className: "empty", textContent: "No Paseo sessions on this PR yet. Start one with ＋ New." }));
    }
    return;
  }
  const serverId = daemon.getLastServerInfoMessage()?.serverId;
  openInPaseo.href = serverId ? `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(id)}` : "#";
  // ponytail: refetch the tail on every live event instead of merging stream deltas; fine at a few hundred items.
  unsubscribeTimeline = paseo.agents.ref(id).timeline.subscribe(() => {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(renderTimeline, 250);
  });
  void renderTimeline();
}

async function renderTimeline() {
  const id = selectedId;
  if (!id) return;
  const page = await paseo.agents.ref(id).timeline.refetch({ direction: "tail", limit: 200 });
  if (id !== selectedId) return;
  const pinned = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;
  const agent = page.agent;
  const blocked = !!agent?.pendingPermissions?.length;
  const busy = agent?.status === "running" || agent?.status === "initializing";
  timeline.replaceChildren(
    ...page.entries.map(renderEntry).filter((n): n is HTMLElement => !!n),
    ...(busy ? [working(blocked ? "Waiting on a permission (Open in Paseo)" : "Working")] : []),
  );
  if (pinned) timeline.scrollTop = timeline.scrollHeight;
  if (agent) {
    const waiting = blocked ? " · waiting on a permission (open in Paseo)" : "";
    setStatus(`${agent.status} · ${agent.model ?? agent.provider} · ${agent.thinkingOptionId ?? "default"}${waiting}`);
  }
  // ponytail: a turn can go quiet (long tool call) without stream events; re-check while busy so the indicator clears.
  if (busy) {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(renderTimeline, 4000);
  }
}

function working(label: string) {
  return el("div", { className: "working" }, el("span", { className: "dots" }, el("i"), el("i"), el("i")), label);
}

function renderEntry({ item }: TimelineEntry): HTMLElement | null {
  switch (item.type) {
    case "user_message":
      return el("div", { className: "msg user", textContent: item.text });
    case "assistant_message":
      return markdown(item.text);
    case "reasoning":
      return el("details", { className: "reasoning" }, el("summary", { textContent: "Thinking" }), markdown(item.text));
    case "tool_call": {
      const detail = JSON.stringify(item.detail, null, 2) ?? "";
      const summary = item.detail && "command" in item.detail ? String(item.detail.command) : detail;
      return el(
        "details",
        { className: "tool" },
        el("summary", { textContent: `${item.name} · ${summary.replace(/\s+/g, " ").slice(0, 120)}` }),
        el("pre", { textContent: detail.slice(0, 4000) }),
      );
    }
    case "error":
      return el("div", { className: "msg error", textContent: item.message });
    default:
      return null;
  }
}

async function openNewForm() {
  document.body.classList.add("creating");
  newBtn.textContent = "Cancel";
  prompt.placeholder = "First message for the new session";
  selectAgent(null);

  const prWs = workspaces.filter(isPrWorkspace);
  const others = workspaces.filter((w) => !isPrWorkspace(w));
  const option = (w: Workspace) => el("option", { value: w.id, textContent: `${w.title ?? w.name} (${w.worktreeSlug ?? w.workspaceDirectory})` });
  workspaceSelect.replaceChildren(
    ...(prWs.length ? [el("optgroup", { label: `On PR #${pr?.number}` }, ...prWs.map(option))] : []),
    el("option", { value: NEW_WORKTREE, textContent: `New worktree checked out to PR #${pr?.number}` }),
    el("optgroup", { label: "Other workspaces" }, ...others.map(option)),
  );
  workspaceSelect.value = prWs[0]?.id ?? NEW_WORKTREE;

  const snapshot = await paseo.providers.snapshot();
  const models = snapshot.entries
    .filter((p) => p.enabled && p.status === "ready")
    .flatMap((p) => (p.models ?? []).map((m) => ({ ...m, key: `${p.provider}/${m.id}`, providerLabel: p.label })));
  modelSelect.replaceChildren(...models.map((m) => el("option", { value: m.key, textContent: `${m.providerLabel} · ${m.label}` })));
  const fillEfforts = () => {
    const model = models.find((m) => m.key === modelSelect.value);
    const opts = model?.thinkingOptions ?? [];
    effortSelect.replaceChildren(...opts.map((o) => el("option", { value: o.id, textContent: o.label })));
    effortSelect.value = model?.defaultThinkingOptionId ?? opts.find((o) => o.isDefault)?.id ?? opts[0]?.id ?? "";
    effortSelect.hidden = !opts.length;
  };
  modelSelect.onchange = fillEfforts;
  const preferred = models.find((m) => m.isDefault && m.key.startsWith("claude/")) ?? models[0];
  if (preferred) modelSelect.value = preferred.key;
  fillEfforts();
}

function closeNewForm() {
  document.body.classList.remove("creating");
  newBtn.textContent = "＋ New";
  prompt.placeholder = "Message this session (⇧↩ for a new line)";
}

async function createSession(text: string) {
  if (!pr) throw new Error("Open a Graphite PR first");
  const config = { provider: modelSelect.value, ...(effortSelect.value ? { thinkingOptionId: effortSelect.value } : {}) };
  let workspace;
  if (workspaceSelect.value === NEW_WORKTREE) {
    const target = pr;
    const repoRoot = workspaces.find((w) => isRepo(w, target))?.projectRootPath;
    if (!repoRoot) throw new Error(`No Paseo project for ${pr.owner}/${pr.repo}`);
    setStatus("Creating worktree…");
    timeline.replaceChildren(el("div", { className: "empty", textContent: `Creating a worktree for PR #${pr.number}. This takes a few seconds.` }));
    workspace = await paseo.workspaces.create({
      source: { kind: "worktree", cwd: repoRoot, action: "checkout", checkoutSource: { kind: "change_request", forge: "github", number: pr.number } },
    });
  } else {
    workspace = paseo.workspaces.ref(workspaceSelect.value);
  }
  setStatus("Starting session…");
  // Tag it now: a new worktree isn't linked to the PR until Paseo resolves its branch, and another workspace never is.
  const labels = { [prLabel(pr)]: new Date().toISOString().slice(0, 10) };
  const agent = await workspace.agents.create({ config, prompt: text, labels });
  closeNewForm();
  selectedId = agent.id;
  unsubscribeTimeline?.();
  unsubscribeTimeline = null;
  await loadSessions();
}

async function send() {
  const text = prompt.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  try {
    if (isCreating()) await createSession(text);
    else if (selectedId) {
      await paseo.agents.ref(selectedId).send(text);
      timeline.append(el("div", { className: "msg user", textContent: text }), working("Working"));
      timeline.scrollTop = timeline.scrollHeight;
    } else return;
    prompt.value = "";
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sendBtn.disabled = false;
  }
}

async function syncActiveTab(force = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabUrl = tab?.url;
  const next = parsePr(tabUrl);
  if (!force && next?.number === pr?.number && next?.repo === pr?.repo) return;
  pr = next;
  closeNewForm();
  newBtn.disabled = !pr;
  await loadSessions();
}

timeline.onclick = (e) => {
  const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  e.preventDefault();
  if (/^https?:/.test(link.href)) void chrome.tabs.create({ url: link.href });
};
agentSelect.onchange = () => selectAgent(agentSelect.value);
newBtn.onclick = () => (isCreating() ? (closeNewForm(), void loadSessions()) : void openNewForm());
sendBtn.onclick = () => void send();
unarchiveBtn.onclick = async () => {
  if (!selectedId) return;
  unarchiveBtn.disabled = true;
  try {
    // Same call as Paseo's own Unarchive button.
    await daemon.refreshAgent(selectedId);
    unsubscribeTimeline?.();
    unsubscribeTimeline = null;
    await loadSessions();
    prompt.focus();
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    unarchiveBtn.disabled = false;
  }
};
prompt.onkeydown = (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  void send();
};
openInPaseo.onclick = (e) => {
  e.preventDefault();
  if (openInPaseo.href.startsWith("paseo:")) void chrome.tabs.update({ url: openInPaseo.href });
};
const connected = () => daemon.getConnectionState().status === "connected";
chrome.tabs.onActivated.addListener(() => {
  if (connected()) void syncActiveTab();
});
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && info.url && connected()) void syncActiveTab();
});

// The browser hides the daemon's 403, so a disallowed origin looks like any other failed connect.
daemon.subscribeConnectionStatus((s) => {
  if (s.status === "connected") void syncActiveTab(true);
  if (s.status === "disconnected")
    setStatus(
      `Can't reach Paseo at ${DAEMON_URL}, retrying. If Paseo is running, allow this extension: node scripts/allow-origin.mjs`,
    );
});
daemon.connect().catch(() => {});
