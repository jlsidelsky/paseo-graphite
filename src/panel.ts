import type { PaseoAgent } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import MarkdownIt from "markdown-it";
import {
  arrange,
  checksText,
  commandArgs,
  commandPreset,
  DEFAULT_PRESETS,
  feedbackPreset,
  isFeedbackCommand,
  isReviewCommand,
  loadStore,
  mergeDraft,
  newDefaultsFor,
  parseHint,
  presetScope,
  presetText,
  prLines,
  prUrl,
  scopeText,
  type ArgValues,
  type DiscoveredCache,
  type Found,
  type NewDefaults,
  type Preset,
} from "./actions";
import { argControls, readArgs } from "./args-form";
import { asKey, connectHosts, conns, hostLabel, hostStatus, isUp, keyOf, LOCAL, listSessions, multiHost, on, splitKey, tagAgent, tagWorkspace, upConns, type Paseo } from "./hosts";
import { diffStrings, parseUnifiedDiff, type DiffLine } from "./diff";
import { sessionMeta, groupInbox, INBOX_DEFAULTS, loadInboxSettings, matches, pageSections, renderInbox, type InboxRow } from "./inbox-view";
import { isAnswered, parseQuestions, questionResponse, showsText, type Question } from "./question";
import {
  agentsOnPr,
  agentsOnTicket,
  groupAll,
  isPrWorkspace as onPr,
  isRepo,
  isTicketWorkspace,
  lightReviewPr,
  parsePr,
  parseTicket,
  prLabel,
  rowPr,
  SETTINGS,
  stackOf,
  ticketBranch,
  ticketLabel,
  ticketTitle,
  type Pr,
  type RowStack,
  type StackPr,
  type Ticket,
  type Workspace,
} from "./pr";

const NEW_WORKTREE = "__new__";
// A light review worktree: the plugin checks out the PR, Paseo adds it as a workspace without running setup.
const LIGHT = "__light__";
const PLUGIN_ID = "paseo-graphite-pr-tags";
const freshPrefix = (v: string) => [NEW_WORKTREE, LIGHT].find((p) => v.startsWith(p));

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
const fullWorktree = $<HTMLAnchorElement>("full-worktree");
let fullWorktreePr: number | null = null;
const prompt = $<HTMLTextAreaElement>("prompt");
const sendBtn = $<HTMLButtonElement>("send-btn");
const newBtn = $<HTMLButtonElement>("new-btn");
const unarchiveBtn = $<HTMLButtonElement>("unarchive-btn");
const suggest = $<HTMLDivElement>("suggest");
const stopBtn = $<HTMLButtonElement>("stop-btn");
const modeSelect = $<HTMLSelectElement>("mode-select");
const sessionMode = $<HTMLSelectElement>("session-mode");
const contextEl = $<HTMLSpanElement>("context");
const attachmentsEl = $<HTMLDivElement>("attachments");
const settingsBtn = $<HTMLButtonElement>("settings-btn");
const settingsBox = $<HTMLDivElement>("settings");
const pinBtn = $<HTMLButtonElement>("pin-btn");
const goTo = $<HTMLAnchorElement>("go-to");
const actionsBar = $<HTMLDivElement>("actions");
const menuBox = $<HTMLDivElement>("menu");
const scopeBtn = $<HTMLButtonElement>("scope-btn");
const reviewBtn = $<HTMLButtonElement>("review-btn");
const fixCiBtn = $<HTMLButtonElement>("fix-ci-btn");
const ciState = $<HTMLSpanElement>("ci-state");
const feedbackBtn = $<HTMLButtonElement>("feedback-btn");
const search = $<HTMLInputElement>("search");
const hostStatusEl = $<HTMLElement>("host-status");

type TimelineEntry = Awaited<ReturnType<ReturnType<Paseo["agents"]["ref"]>["timeline"]["refetch"]>>["entries"][number];
type Permission = PaseoAgent["pendingPermissions"][number];
type RewindMode = "conversation" | "files" | "both";

// What the panel shows: a PR, a Linear ticket, or (neither) every session.
let pr: Pr | null = null;
let ticket: Ticket | null = null;
let pinned = false;
let workspaces: Workspace[] = [];
// Every session the daemon knows, archived included; `agents` is the shown context's.
let everyone: PaseoAgent[] = [];
let agents: PaseoAgent[] = [];
// Sessions on other PRs in the same stack; `agents` stays the current PR's.
let stackGroups: { pr: StackPr; agents: PaseoAgent[] }[] = [];
const stackCache = new Map<string, Promise<StackPr[]>>();
// The whole stack, bottom to top, once loaded; empty when the PR isn't in one.
let stackPrs: StackPr[] = [];
// What a PR action suggests for a new session, if the user opens ＋ New.
let newDefaults: NewDefaults | null = null;
// The actions' scope: the stack PRs picked in the scope control. Back to this PR on every PR switch.
let picked = new Set<number>();
let rewindMenuFor: string | null = null;
let selectedId: string | null = null;
let unsubscribeTimeline: (() => void) | null = null;
let refetchTimer: ReturnType<typeof setTimeout> | undefined;
let images: { data: string; mimeType: string }[] = [];
let prefill = "";
let allTimer: ReturnType<typeof setTimeout> | undefined;
let lastStatus = "";
// The active tab's inbox rows (Graphite inbox, GitHub PR list), shown instead of all sessions; empty elsewhere.
let inbox: InboxRow[] = [];
// The page's inbox rows; `inbox` is these unless the user switched the inbox page's list to all sessions (sync `allSessions`).
let pageInbox: InboxRow[] = [];
let showAll = false;
const setPageInbox = (rows: InboxRow[]) => ((pageInbox = rows), (inbox = showAll ? [] : rows));
let inboxSettings = INBOX_DEFAULTS;
// The inbox's stacks from the background, as indices into the rows they were asked for (kept across row changes until the
// next answer); expanded ones by key, shared with ext/inbox.js.
let inboxStacks: { rows: InboxRow[]; stacks: RowStack[] } = { rows: [], stacks: [] };
let expandedStacks = new Set<string>();

const isPrWorkspace = (w: Workspace) => onPr(w, pr);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function markdown(text: string) {
  const node = el("div", { className: "msg md" });
  node.innerHTML = md.render(text);
  return node;
}

const viewKey = (p = pr, t = ticket) => (p ? prLabel(p) : t ? ticketLabel(t.id) : "all");
const viewName = () => (pr ? `PR #${pr.number}` : ticket ? ticket.id : inbox.length ? "Inbox" : "All sessions");

function setStatus(text: string) {
  lastStatus = text;
  const name = viewName();
  statusText.textContent = !pinned ? text : text === name ? `Pinned · ${name}` : `Pinned · ${name} · ${text}`;
  goTo.hidden = !pinned || (!pr && !ticket);
  goTo.textContent = `↗ ${name}`;
}

// The page the pinned context came from: its open tab if there is one, else a fresh Graphite/Linear tab.
let viewUrl: string | undefined;
goTo.onclick = async (e) => {
  e.preventDefault();
  const key = viewKey();
  const tabs = await chrome.tabs.query({});
  const open = tabs.find((t) => viewKey(parsePr(t.url), parsePr(t.url) ? null : parseTicket(t.url)) === key);
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  const url = pr ? viewUrl ?? `https://app.graphite.com/github/pr/${pr.owner}/${pr.repo}/${pr.number}` : ticket?.url;
  if (url) await chrome.tabs.create({ url });
};

const isCreating = () => document.body.classList.contains("creating");

async function loadSessions() {
  const [target, t] = [pr, ticket];
  const loaded = await listSessions();
  if (pr !== target || ticket !== t) return;
  workspaces = loaded.workspaces;
  everyone = loaded.all;
  const mine = target ? agentsOnPr(workspaces, everyone, target) : t ? agentsOnTicket(workspaces, everyone, t.id) : everyone.filter((a) => !a.archivedAt);
  agents = [...mine.filter((a) => !a.archivedAt), ...mine.filter((a) => a.archivedAt)];
  stackGroups = [];
  stackPrs = [];
  actionsBar.hidden = !target;
  if (target) renderScope();
  renderPicker();
  if (target) void loadStack(target, everyone);
}

async function loadStack(target: Pr, all: PaseoAgent[]) {
  const w = workspaces.find((w) => isRepo(w, target));
  if (!w) return;
  const key = prLabel(target);
  if (!stackCache.has(key)) stackCache.set(key, stackOf(on(w.id).daemon, w.workspaceDirectory, target).catch(() => (stackCache.delete(key), [])));
  const stack = await stackCache.get(key)!;
  if (pr?.number !== target.number || pr.repo !== target.repo) return;
  stackPrs = stack;
  renderScope();
  const seen = new Set(agents.map((a) => a.id));
  stackGroups = stack
    .filter((s) => s.number !== target.number)
    .map((s) => {
      const group = agentsOnPr(workspaces, all, { ...target, number: s.number }).filter((a) => !seen.has(a.id));
      group.forEach((a) => seen.add(a.id));
      return { pr: s, agents: group };
    })
    .filter((g) => g.agents.length);
  if (stackGroups.length) renderPicker();
}

const listed = () => [...agents, ...stackGroups.flatMap((g) => g.agents)];

// With more than one host, a session's name starts with its host's.
const sessionName = (a: PaseoAgent) => a.title ?? splitKey(a.id).id.slice(0, 8);
// With more than one host, which one a session is on: a chip at the end of a row's second line, plain text in the picker.
const hostOf = (a: PaseoAgent) => (multiHost() ? hostLabel(a.id) : undefined);
const optionLabel = (a: PaseoAgent) =>
  `${a.status === "running" ? "● " : ""}${a.archivedAt ? "(archived) " : ""}${sessionName(a)}${hostOf(a) ? ` — ${hostOf(a)}` : ""}`;

function renderPicker() {
  if (!pr && !ticket) return renderAll();
  const option = (a: PaseoAgent) => el("option", { value: a.id, textContent: optionLabel(a) });
  const active = agents.filter((a) => !a.archivedAt);
  const archived = agents.filter((a) => a.archivedAt);
  agentSelect.replaceChildren(
    ...(agents.length ? active.map(option) : [el("option", { value: "", textContent: `No sessions for ${pr ? `#${pr.number}` : ticket?.id}` })]),
    ...(archived.length ? [el("optgroup", { label: "Archived" }, ...archived.map(option))] : []),
    ...stackGroups.map((g) => el("optgroup", { label: `Stack · #${g.pr.number} ${g.pr.title}` }, ...g.agents.map(option))),
  );
  // A PR with no sessions of its own often has the one that built its stack.
  const keep = listed().find((a) => a.id === selectedId)?.id ?? agents[0]?.id ?? stackGroups[0]?.agents[0]?.id ?? null;
  agentSelect.value = keep ?? "";
  if (keep !== selectedId || !unsubscribeTimeline) selectAgent(keep);
}

const groups = (list = agents) => {
  const g = groupAll(list);
  return [["Needs you", g.needs], ["Running", g.running], ["Recently finished", g.finished]] as const;
};

// The PR or ticket a session belongs to, for the all-sessions list.
function whereOf(a: PaseoAgent) {
  const labels = Object.keys(a.labels ?? {});
  const n = workspaces.find((w) => w.id === a.workspaceId)?.githubRuntime?.pullRequest?.number ?? labels.find((l) => l.startsWith("pr:"))?.split("#")[1];
  return [labels.find((l) => l.startsWith("ticket:"))?.slice(7), n && `#${n}`].filter(Boolean).join(" · ");
}

function renderAll() {
  // The picker is hidden behind the new-session form; closing the form reloads it.
  if (isCreating()) return;
  const option = (a: PaseoAgent) => el("option", { value: a.id, textContent: [optionLabel(a), whereOf(a)].filter(Boolean).join(" · ") });
  const listedNow: (readonly [string, PaseoAgent[]])[] = inbox.length ? inboxPicker() : groups().filter(([, list]) => list.length);
  // A session opened from search (archived, or past the finished cap) stays selected across live re-renders.
  const extra = listedNow.some(([, list]) => list.some((a) => a.id === selectedId)) ? undefined : agents.find((a) => a.id === selectedId);
  const shown = extra ? [...listedNow, ["Opened from search", [extra]] as const] : listedNow;
  agentSelect.replaceChildren(
    el("option", { value: "", textContent: inbox.length ? "Inbox" : "All sessions" }),
    ...shown.map(([label, list]) => el("optgroup", { label }, ...list.map(option))),
  );
  const keep = shown.some(([, list]) => list.some((a) => a.id === selectedId)) ? selectedId : null;
  agentSelect.value = keep ?? "";
  if (keep !== selectedId || !unsubscribeTimeline) selectAgent(keep);
}

// What the search field looks in besides the session's title (and, in the Inbox, its PR's number and title).
function searchFields(a: PaseoAgent) {
  const w = workspaces.find((x) => x.id === a.workspaceId);
  return [a.title, whereOf(a), w?.gitRuntime?.currentBranch, w?.githubRuntime?.pullRequest?.headRefName, w?.githubRuntime?.pullRequest?.title];
}

function overview() {
  const row = (a: PaseoAgent) => {
    const btn = el("button", { className: "session-row" }, el("b", { textContent: sessionName(a) }), sessionMeta([whereOf(a), a.archivedAt ? "archived" : a.status].filter(Boolean).join(" · "), hostOf(a)));
    btn.onclick = () => {
      // Search reaches sessions the picker doesn't list (archived, or past the finished cap).
      if (!agents.some((x) => x.id === a.id)) agents.push(a);
      selectAgent(a.id);
      renderAll();
    };
    return btn;
  };
  // A search looks through every session, archived too, newest first.
  const nodes = search.value.trim()
    ? sessionPool()
        .filter((a) => matches(search.value.trim(), searchFields(a)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(row)
    : groups().flatMap(([label, list]) => (list.length ? [el("h4", { textContent: label }), ...list.map(row)] : []));
  return nodes.length
    ? el("div", { className: "overview" }, ...nodes)
    : el("div", { className: "empty", textContent: search.value.trim() ? "No sessions match this search." : "No Paseo sessions yet." });
}

// On an inbox page: the inbox's PRs, or every session.
function viewToggle() {
  const tab = (label: string, all: boolean) => {
    const b = el("button", { textContent: label, className: "seg" + (showAll === all ? " on" : "") });
    b.setAttribute("aria-pressed", String(showAll === all));
    b.onclick = () => void chrome.storage.sync.set({ allSessions: all });
    return b;
  };
  return el("div", { className: "view-toggle" }, tab("Inbox", false), tab("All sessions", true));
}

function selectAgent(id: string | null) {
  if (id === selectedId && unsubscribeTimeline) return;
  const [same, top] = [id === selectedId, timeline.scrollTop];
  unsubscribeTimeline?.();
  unsubscribeTimeline = null;
  selectedId = id;
  rewindMenuFor = null;
  sessionMode.hidden = true;
  contextEl.hidden = true;
  document.body.classList.remove("busy");
  document.body.classList.toggle("archived", !!listed().find((a) => a.id === id)?.archivedAt);
  timeline.replaceChildren();
  openInPaseo.hidden = !id;
  const ws = workspaces.find((w) => w.id === listed().find((a) => a.id === id)?.workspaceId);
  fullWorktreePr = pr && lightReviewPr(ws?.workspaceDirectory) === pr.number ? pr.number : null;
  fullWorktree.hidden = !fullWorktreePr;
  search.hidden = !!(id || pr || ticket);
  if (!id) {
    setStatus(viewName());
    if (isCreating()) return;
    timeline.append(
      ...(!pr && !ticket && pageInbox.length ? [viewToggle()] : []),
      pr || ticket
        ? el("div", { className: "empty", textContent: `No Paseo sessions on this ${pr ? "PR" : "ticket"} yet. Start one with ＋ New.` })
        : inbox.length && !search.value.trim()
          ? inboxList()
          : overview(),
    );
    // Re-rendering the same list on a live update keeps its scroll position.
    if (same) timeline.scrollTop = top;
    return;
  }
  const t = on(id);
  const serverId = t.daemon.getLastServerInfoMessage()?.serverId;
  openInPaseo.href = serverId ? `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(t.id)}` : "#";
  // ponytail: refetch the tail on every live event instead of merging stream deltas; fine at a few hundred items.
  unsubscribeTimeline = t.api.agents.ref(t.id).timeline.subscribe(() => {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(renderTimeline, 250);
  });
  void renderTimeline();
}

// Same math and thresholds as Paseo's own meter; hidden when the provider hasn't reported usage.
function showContext(u: PaseoAgent["lastUsage"]) {
  const max = u?.contextWindowMaxTokens, used = u?.contextWindowUsedTokens;
  const known = max !== undefined && max > 0 && used !== undefined && used >= 0;
  contextEl.hidden = !known;
  if (!known) return;
  const pct = (used / max) * 100;
  contextEl.textContent = `${Math.round(pct)}% context`;
  contextEl.className = pct > 90 ? "full" : pct >= 70 ? "high" : "";
  contextEl.title = `${used.toLocaleString()} / ${max.toLocaleString()} tokens`;
}

async function renderTimeline() {
  const id = selectedId;
  if (!id) return;
  const t = on(id);
  const page = await t.api.agents.ref(t.id).timeline.refetch({ direction: "tail", limit: 200 });
  if (id !== selectedId) return;
  const pinned = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;
  const agent = page.agent;
  const permissions = agent?.pendingPermissions ?? [];
  const blocked = permissions.length > 0;
  const busy = agent?.status === "running" || agent?.status === "initializing";
  document.body.classList.toggle("busy", busy);
  const rewindModes: RewindMode[] = busy || !agent ? [] : (["conversation", "files", "both"] as const).filter((m) => agent.capabilities?.[capability[m]]);
  const focused = document.activeElement;
  timeline.replaceChildren(
    ...page.entries.map((e) => renderEntry(e, id, rewindModes)).filter((n): n is HTMLElement => !!n),
    ...permissionCards(id, permissions),
    ...(busy && !blocked ? [working("Working")] : []),
  );
  // Moving a reused card out and back in drops focus; give it back so typing an answer isn't interrupted.
  if (focused instanceof HTMLElement && focused !== document.activeElement && timeline.contains(focused)) focused.focus({ preventScroll: true });
  if (pinned) timeline.scrollTop = timeline.scrollHeight;
  // Don't rebuild the picker under the user's cursor.
  if (agent && document.activeElement !== sessionMode) {
    sessionMode.replaceChildren(...agent.availableModes.map((m) => el("option", { value: m.id, textContent: m.label, title: m.description ?? "" })));
    sessionMode.value = agent.currentModeId ?? "";
    sessionMode.hidden = !agent.availableModes.length;
  }
  if (agent) {
    showContext(agent.lastUsage);
    const waiting = blocked ? " · waiting on you" : "";
    setStatus(`${agent.status} · ${agent.model ?? agent.provider} · ${agent.thinkingOptionId ?? "default"}${waiting}`);
  }
  // ponytail: a turn can go quiet (long tool call) without stream events; re-check while busy so the indicator clears.
  if (busy) {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(renderTimeline, 4000);
  }
}

async function rewindTo(agentId: string, messageId: string, mode: RewindMode, text: string) {
  try {
    const t = on(agentId);
    await t.daemon.rewindAgent(t.id, messageId, mode);
    // Like Paseo: rewinding the conversation hands the message back to the composer.
    if (mode !== "files") (prompt.value = text), prompt.focus();
  } catch (err) {
    setStatus(`Rewind failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  rewindMenuFor = null;
  void renderTimeline();
}

// One card per pending request, reused across re-renders so half-filled answers and in-flight buttons survive.
const cards = new Map<string, HTMLElement>();

function permissionCards(agentId: string, permissions: Permission[]) {
  for (const id of cards.keys()) if (!permissions.some((p) => p.id === id)) cards.delete(id);
  return permissions.map((p) => {
    let card = cards.get(p.id);
    if (!card) cards.set(p.id, (card = permissionCard(agentId, p)));
    return card;
  });
}

type PermissionResponse = Parameters<DaemonClient["respondToPermission"]>[2];

function permissionCard(agentId: string, p: Permission) {
  const card = el("div", { className: "permission" });
  const respond = async (response: PermissionResponse) => {
    const controls = card.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input");
    controls.forEach((c) => (c.disabled = true));
    try {
      const t = on(agentId);
      await t.daemon.respondToPermission(t.id, p.id, response);
    } catch (err) {
      controls.forEach((c) => (c.disabled = false));
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    void renderTimeline();
  };
  const questions = p.kind === "question" ? parseQuestions(p.input) : null;
  if (questions) return card.append(questionForm(p, questions, respond)), card;

  const plan = p.kind === "plan" ? [p.metadata?.planText, p.input?.plan].find((t) => typeof t === "string") : undefined;
  const detail = p.detail && "command" in p.detail ? String(p.detail.command) : p.input ? JSON.stringify(p.input, null, 2) : "";
  card.append(
    el("b", { textContent: p.kind === "plan" ? "Plan" : (p.title ?? p.name) }),
    ...(p.description ? [el("div", { textContent: p.description })] : []),
    ...(plan ? [markdown(plan)] : detail ? [el("pre", { textContent: detail.slice(0, 4000) })] : []),
  );
  const row = el("div", { className: "row" });
  // A question Paseo can't parse gets no form in Paseo either; hand it over.
  if (p.kind === "question") {
    const open = el("button", { textContent: "Answer in Paseo" });
    open.onclick = () => openInPaseo.click();
    row.append(open);
  } else {
    // Paseo's defaults when a request brings no actions of its own.
    const actions = p.actions?.length
      ? p.actions
      : [
          { id: "accept", label: p.kind === "plan" ? "Implement" : "Allow", behavior: "allow" as const, variant: "primary" as const },
          { id: "reject", label: "Deny", behavior: "deny" as const, variant: "danger" as const },
        ];
    for (const a of actions) {
      const btn = el("button", { textContent: a.label, className: a.variant ?? "" });
      btn.onclick = () =>
        void respond(
          a.behavior === "allow"
            ? { behavior: "allow", selectedActionId: a.id }
            : { behavior: "deny", selectedActionId: a.id, message: "Denied from the Graphite panel" },
        );
      row.append(btn);
    }
  }
  card.append(row);
  return card;
}

// The form's DOM is the draft: the card is reused across re-renders, so reading it back is enough.
function questionForm(p: Permission, questions: Question[], respond: (r: PermissionResponse) => Promise<void>) {
  const form = el("form", { className: "questions" });
  const submit = el("button", { type: "submit", className: "primary", textContent: "Submit" });
  const dismiss = el("button", { type: "button", textContent: questions.find((q) => q.dismissLabel)?.dismissLabel ?? "Dismiss" });
  const fields = questions.map((q, qi) => {
    const choices = q.options.map((o) => el("input", { type: q.multiSelect ? "checkbox" : "radio", name: `${p.id}-${qi}`, value: o.label }));
    const placeholder = q.placeholder ?? (q.options.length ? "Other..." : "Type your answer...");
    const text = showsText(q) ? el("input", { type: "text", placeholder, ariaLabel: q.options.length ? "Other" : q.question }) : null;
    // Picking an option clears typed text and vice versa, as in Paseo.
    for (const c of choices) c.onchange = () => { if (text) text.value = ""; sync(); };
    if (text) text.oninput = () => { if (text.value) for (const c of choices) c.checked = false; sync(); };
    form.append(
      el(
        "fieldset",
        {},
        el("legend", {}, el("small", { textContent: q.header }), el("span", { textContent: q.question })),
        ...q.options.map((o, i) =>
          el("label", {}, choices[i], el("span", {}, o.label, ...(o.description ? [el("small", { textContent: o.description })] : []))),
        ),
        ...(text ? [text] : []),
      ),
    );
    return { choices, text };
  });
  const draft = () => fields.map((f) => ({ picked: f.choices.filter((c) => c.checked).map((c) => c.value), text: f.text?.value ?? "" }));
  const answered = () => draft().every((d, i) => isAnswered(questions[i], d));
  const sync = () => (submit.disabled = !answered());
  sync();
  form.onsubmit = (e) => {
    e.preventDefault();
    if (answered()) void respond(questionResponse(p.input, questions, draft(), false));
  };
  dismiss.onclick = () => void respond(questionResponse(p.input, questions, draft(), true));
  form.append(el("div", { className: "row" }, dismiss, submit));
  return form;
}

function working(label: string) {
  return el("div", { className: "working" }, el("span", { className: "dots" }, el("i"), el("i"), el("i")), label);
}

const capability = { conversation: "supportsRewindConversation", files: "supportsRewindFiles", both: "supportsRewindBoth" } as const;
const rewindLabels: Record<RewindMode, string> = { conversation: "Rewind conversation", files: "Rewind files", both: "Rewind conversation and files" };

function renderEntry({ item }: TimelineEntry, agentId: string, rewindModes: RewindMode[]): HTMLElement | null {
  switch (item.type) {
    case "user_message": {
      const msg = el("div", { className: "msg user", textContent: item.text });
      const messageId = item.messageId;
      if (!messageId || !rewindModes.length) return msg;
      const rewind = el("button", { className: "rewind-btn", title: "Rewind to this message", textContent: "↺" });
      rewind.onclick = () => {
        rewindMenuFor = rewindMenuFor === messageId ? null : messageId;
        void renderTimeline();
      };
      const wrap = el("div", { className: "user-wrap" }, rewind, msg);
      if (rewindMenuFor !== messageId) return wrap;
      const menu = el("div", { className: "rewind-menu" }, el("span", { textContent: "This can't be undone." }));
      for (const mode of rewindModes) {
        const btn = el("button", { textContent: rewindLabels[mode] });
        btn.onclick = () => void rewindTo(agentId, messageId, mode, item.text);
        menu.append(btn);
      }
      const cancel = el("button", { textContent: "Cancel" });
      cancel.onclick = () => ((rewindMenuFor = null), void renderTimeline());
      menu.append(cancel);
      return el("div", {}, wrap, menu);
    }
    case "assistant_message":
      return markdown(item.text);
    case "reasoning":
      return el("details", { className: "reasoning" }, el("summary", { textContent: "Thinking" }), markdown(item.text));
    case "tool_call":
      return toolCall(item);
    case "error":
      return el("div", { className: "msg error", textContent: item.message });
    default:
      return null;
  }
}

type ToolCall = Extract<TimelineEntry["item"], { type: "tool_call" }>;

const clip = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text);

function diffView(lines: DiffLine[]) {
  // ponytail: first 300 lines; a whole-file Write can be thousands.
  const shown = lines.slice(0, 300).map((l) => el("span", { className: `d${l.sign === "@" ? "h" : l.sign === "+" ? "a" : l.sign === "-" ? "r" : "c"}`, textContent: l.sign === "@" ? l.text : l.sign + l.text }));
  if (lines.length > 300) shown.push(el("span", { className: "dh", textContent: `… ${lines.length - 300} more lines` }));
  return el("pre", { className: "diff" }, ...shown);
}

function errorText(error: unknown) {
  if (!error) return "";
  if (typeof error === "string") return error;
  // Claude reports { content }, Codex { message }.
  if (typeof error === "object" && "content" in error && typeof error.content === "string") return error.content;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return JSON.stringify(error);
}

function toolCall(item: ToolCall) {
  const d = item.detail;
  let label = "";
  let body: HTMLElement[] = [];
  const text = (t: string | undefined) => (t ? [el("pre", { textContent: clip(t) })] : []);
  switch (d.type) {
    case "shell":
      label = d.command;
      body = [el("pre", { className: "cmd-line", textContent: `$ ${d.command}` }), ...text(d.output)];
      break;
    case "edit":
      label = d.filePath;
      body = [diffView(d.unifiedDiff ? parseUnifiedDiff(d.unifiedDiff) : diffStrings(d.oldString ?? "", d.newString ?? ""))];
      break;
    case "write":
      label = d.filePath;
      body = d.content ? [diffView(diffStrings("", d.content))] : [];
      break;
    case "read":
      label = d.filePath;
      body = text(d.content);
      break;
    case "search":
      label = d.query;
      body = text(d.content ?? d.filePaths?.join("\n") ?? d.webResults?.map((r) => `${r.title}\n${r.url}`).join("\n\n"));
      break;
    case "fetch":
      label = d.url;
      body = text(d.result);
      break;
    default:
      label = JSON.stringify(d) ?? "";
      body = text(JSON.stringify(d, null, 2));
  }
  const error = item.status === "failed" ? errorText(item.error) : "";
  if (error) body.push(el("pre", { className: "error", textContent: clip(error) }));
  const mark = item.status === "failed" ? "✕ " : item.status === "canceled" ? "⊘ " : item.status === "running" ? "… " : "";
  return el(
    "details",
    { className: `tool ${item.status}` },
    el("summary", { textContent: `${mark}${item.name} · ${label.replace(/\s+/g, " ").slice(0, 160)}` }),
    ...body,
  );
}

async function openNewForm() {
  document.body.classList.add("creating");
  newBtn.textContent = "Cancel";
  prompt.placeholder = "First message for the new session";
  selectAgent(null);
  const text = pr ? `PR #${pr.number}: ${prUrl(pr)}\n\n` : ticket ? await ticketPrefill(ticket) : "";
  // A leftover draft stays, below the PR/ticket context. A slash command has to stay first, and an action's prompt already names the PR.
  if (text && isCreating() && !prompt.value.includes(text.trim()) && !prompt.value.startsWith("/") && !(pr && prompt.value.includes(prUrl(pr)))) {
    prompt.value = prefill = prompt.value.trim() ? `${text}${prompt.value}` : text;
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  }

  // Workspaces, and new worktrees, are on a host: with more than one, each option says which.
  const hostTag = (key: string) => (multiHost() ? ` · ${hostLabel(key)}` : "");
  const option = (w: Workspace) => el("option", { value: w.id, textContent: `${w.title ?? w.name} (${w.worktreeSlug ?? w.workspaceDirectory})${hostTag(w.id)}` });
  const roots = recentRoots();
  const byProject = (list: Workspace[]) =>
    roots.map((r) => list.filter((w) => rootKey(w) === r)).filter((g) => g.length).map((g) => el("optgroup", { label: g[0].projectDisplayName + hostTag(g[0].id) }, ...g.map(option)));
  const d = newDefaults;
  if (pr) {
    const prWs = workspaces.filter(isPrWorkspace);
    const others = workspaces.filter((w) => !isPrWorkspace(w));
    const stacked = stackPrs.filter((s) => s.number !== pr!.number);
    // A new worktree on each host with a workspace in the repo, the first one by default.
    const found = [...new Set(workspaces.filter((w) => isRepo(w, pr!)).map((w) => splitKey(w.id).host))];
    const hosts = found.length ? found : [conns[0]?.host.id ?? LOCAL.id];
    const newAt = (n: number, host = hosts[0], kind = NEW_WORKTREE) => kind + keyOf(host, String(n));
    // Reviews: a new worktree, a light one (opted into on the options page), or a shared review workspace.
    const { reviewWorkspace = "" } = await chrome.storage.local.get<{ reviewWorkspace?: string }>("reviewWorkspace");
    const light = reviewWorkspace === "light";
    const checkout = (n: number, title = "") =>
      hosts.flatMap((h) => [
        el("option", { value: newAt(n, h), textContent: `New worktree checked out to PR #${n}${title && ` ${title}`}${hostTag(keyOf(h, ""))}` }),
        ...(light ? [el("option", { value: newAt(n, h, LIGHT), textContent: `Light worktree on PR #${n}${title && ` ${title}`} (no setup)${hostTag(keyOf(h, ""))}` })] : []),
      ]);
    workspaceSelect.replaceChildren(
      ...(prWs.length ? [el("optgroup", { label: `On PR #${pr.number}` }, ...prWs.map(option))] : []),
      ...checkout(pr.number),
      ...(stacked.length ? [el("optgroup", { label: "Other PRs in the stack" }, ...stacked.flatMap((s) => checkout(s.number, s.title)))] : []),
      el("optgroup", { label: "Other workspaces" }, ...others.map(option)),
    );
    const target = d?.number ?? pr.number;
    const existing = workspaces.find((w) => onPr(w, { ...pr!, number: target }));
    // With no workspace on the PR: per the options page, the one last used for this repo's PRs, a new worktree, or a fixed one.
    const { prWorkspaceMode: mode = "last" } = await chrome.storage.local.get<{ prWorkspaceMode?: string }>("prWorkspaceMode");
    const last = mode === "last" ? (await lastPrWorkspaces())[repoKey(pr)] : mode === "new" ? "" : mode;
    const remembered = last && workspaces.some((w) => w.id === asKey(last)) ? asKey(last) : undefined;
    const reviewWs = d?.review && workspaces.some((w) => w.id === reviewWorkspace) ? reviewWorkspace : d?.review && light ? newAt(target, hosts[0], LIGHT) : undefined;
    workspaceSelect.value = d?.reuse === false ? reviewWs || newAt(target) : existing?.id || remembered || newAt(target);
  } else if (ticket) {
    const id = ticket.id;
    const onTicket = workspaces.filter((w) => isTicketWorkspace(w, id));
    const name = (root: string) => (workspaces.find((w) => rootKey(w) === root)?.projectDisplayName ?? splitKey(root).id) + hostTag(root);
    workspaceSelect.replaceChildren(
      ...(onTicket.length ? [el("optgroup", { label: `On ${id}` }, ...onTicket.map(option))] : []),
      ...roots.map((r) => el("option", { value: NEW_WORKTREE + r, textContent: `New worktree for ${id} in ${name(r)} (${ticketBranch(ticket!)})` })),
      ...byProject(workspaces.filter((w) => !onTicket.includes(w))),
    );
    workspaceSelect.value = onTicket[0]?.id ?? NEW_WORKTREE + (roots[0] ?? "");
  } else {
    workspaceSelect.replaceChildren(...byProject(workspaces));
    const ids = new Set(workspaces.map((w) => w.id));
    workspaceSelect.value = byRecency(everyone).find((a) => a.workspaceId && ids.has(a.workspaceId))?.workspaceId ?? workspaces[0]?.id ?? "";
  }
  await fillModels();
}

// The chosen workspace's (or new worktree's) host.
const chosenHost = () => {
  const v = workspaceSelect.value;
  return on(v.slice(freshPrefix(v)?.length ?? 0));
};

// Models, efforts and modes from the chosen workspace's host. `keep`: the model picked so far, where that host has it.
async function fillModels(keep = false) {
  const [choice, current, d] = [workspaceSelect.value, modelSelect.value, newDefaults];
  const snapshot = await chosenHost().api.providers.snapshot();
  if (workspaceSelect.value !== choice) return;
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
  // Default to the provider's own default mode (Auto for Claude), or the last one picked here.
  const fillModes = () => {
    const provider = snapshot.entries.find((p) => p.provider === modelSelect.value.split("/")[0]);
    const modes = provider?.modes ?? [];
    modeSelect.replaceChildren(...modes.map((m) => el("option", { value: m.id, textContent: m.label, title: m.description ?? "" })));
    const saved = localStorage.getItem(`mode:${provider?.provider}`);
    modeSelect.value = modes.some((m) => m.id === saved) ? saved! : (provider?.defaultModeId ?? modes[0]?.id ?? "");
    modeSelect.hidden = !modes.length;
  };
  modeSelect.onchange = () => localStorage.setItem(`mode:${modelSelect.value.split("/")[0]}`, modeSelect.value);
  modelSelect.onchange = () => (fillEfforts(), fillModes());
  const of = (p: string) => models.find((m) => m.isDefault && m.key.startsWith(`${p}/`)) ?? models.find((m) => m.key.startsWith(`${p}/`));
  const preferred =
    (keep && models.find((m) => m.key === current)) || (d?.model && models.find((m) => m.key === d.model)) || (d?.provider && of(d.provider)) || of("claude") || models[0];
  if (preferred) modelSelect.value = preferred.key;
  // A preset's effort and mode, where this model and provider offer them.
  const pick = (select: HTMLSelectElement, value?: string) => value && [...select.options].some((o) => o.value === value) && (select.value = value);
  fillEfforts();
  pick(effortSelect, d?.effort);
  fillModes();
  pick(modeSelect, d?.mode);
}
workspaceSelect.onchange = () => void fillModels(true);

const byRecency = (list: PaseoAgent[]) => [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

// Project roots, host-qualified, most recently used first.
const rootKey = (w: Workspace) => (w.projectRootPath ? keyOf(splitKey(w.id).host, w.projectRootPath) : undefined);
function recentRoots() {
  const rootOf = new Map(workspaces.map((w) => [w.id, rootKey(w)]));
  const roots = [...byRecency(everyone).map((a) => rootOf.get(a.workspaceId ?? "")), ...workspaces.map(rootKey)];
  return [...new Set(roots.filter((r): r is string => !!r))];
}

async function ticketPrefill(t: Ticket) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const title = t.title || (parseTicket(tab?.url)?.id === t.id ? ticketTitle(tab?.title, t.id) : "");
  const body = t.description?.trim() ? `${t.description.trim()}\n\n` : "";
  return `Work on Linear ticket ${t.id}${title ? `: ${title}` : ""}\n${t.url}\n\n${body}`;
}

function closeNewForm() {
  document.body.classList.remove("creating");
  newBtn.textContent = "＋ New";
  prompt.placeholder = "Message this session (⇧↩ for a new line)";
  if (prefill && prompt.value === prefill) prompt.value = "";
  prefill = "";
}

// The workspace last picked for a PR session, per repo (chrome.storage.local `prWorkspace`); "" for a new worktree.
const repoKey = (p: Pr) => `${p.owner}/${p.repo}`;
const lastPrWorkspaces = async () => (await chrome.storage.local.get<{ prWorkspace?: Record<string, string> }>("prWorkspace")).prWorkspace ?? {};

// Optional (chrome.storage.local `reviewLabel`): a new review worktree gets Paseo's workspace label "review", keeping its colour if
// the label exists. Best effort: the session starts either way.
async function labelReview(daemon: DaemonClient, workspaceId: string) {
  const { reviewLabel } = await chrome.storage.local.get<{ reviewLabel?: boolean }>("reviewLabel");
  if (!reviewLabel) return;
  const color = (await daemon.listWorkspaceLabels().catch(() => null))?.labels.find((l) => l.name === "review")?.color ?? "violet";
  await daemon.setWorkspaceLabel({ workspaceId, label: { name: "review", color }, assigned: true }).catch(() => {});
}

// A light review worktree through the plugin, added to Paseo as a plain directory, so the repo's worktree setup doesn't run.
// Null when the plugin can't (not installed or too old on that host, say): the caller makes a normal worktree instead,
// and the status line says so once per host.
const lightFallbackShown = new Set<string>();
let lightFallback = "";
async function lightWorktree(api: Paseo, daemon: DaemonClient, hostId: string, repoRoot: string, projectId: string, number: number) {
  setStatus("Checking out the PR…");
  timeline.replaceChildren(el("div", { className: "empty", textContent: `Checking out PR #${number} in a light worktree.` }));
  try {
    const { path } = (await daemon.invokePluginRpc(PLUGIN_ID, "review.worktree.create", { repoRoot, number })) as { path: string };
    return await api.workspaces.create({ source: { kind: "directory", path, projectId } });
  } catch (err) {
    if (!lightFallbackShown.has(hostId)) {
      lightFallbackShown.add(hostId);
      lightFallback = `No light worktree (${err instanceof Error ? err.message.replace(/ requestType=.*$/, "") : String(err)}), so a full one. Is the plugin installed and reloaded?`;
    }
    return null;
  }
}

async function createSession(text: string, imgs: typeof images) {
  const config = {
    provider: modelSelect.value,
    ...(effortSelect.value ? { thinkingOptionId: effortSelect.value } : {}),
    ...(modeSelect.value && !modeSelect.hidden ? { modeId: modeSelect.value } : {}),
  };
  // A new worktree's value is NEW_WORKTREE (or LIGHT) + <host>:<PR number or project root>; a workspace's is its id.
  const prefix = freshPrefix(workspaceSelect.value);
  const fresh = !!prefix;
  const { host, api, daemon, id } = chosenHost();
  let workspace;
  if (pr && fresh) {
    const target = pr;
    const number = Number(id);
    const repoWs = workspaces.find((w) => splitKey(w.id).host === host.id && isRepo(w, target));
    if (!repoWs?.projectRootPath) throw new Error(`No Paseo project for ${pr.owner}/${pr.repo}`);
    const repoRoot = repoWs.projectRootPath;
    if (prefix === LIGHT) workspace = await lightWorktree(api, daemon, host.id, repoRoot, repoWs.projectId, number);
    if (!workspace) {
      setStatus("Creating worktree…");
      timeline.replaceChildren(el("div", { className: "empty", textContent: `Creating a worktree for PR #${number}. This takes a few seconds.` }));
      workspace = await api.workspaces.create({
        source: { kind: "worktree", cwd: repoRoot, action: "checkout", checkoutSource: { kind: "change_request", forge: "github", number } },
      });
    }
  } else if (ticket && fresh) {
    const branchName = ticketBranch(ticket);
    setStatus("Creating worktree…");
    timeline.replaceChildren(el("div", { className: "empty", textContent: `Creating a worktree on ${branchName}. This takes a few seconds.` }));
    // Branches off the default branch. If the branch already exists, Paseo branches off it under a new name instead.
    workspace = await api.workspaces.create({ source: { kind: "worktree", cwd: id, action: "branch-off", branchName } });
  } else {
    workspace = api.workspaces.ref(id);
  }
  if (pr && fresh && newDefaults?.review) void labelReview(chosenHost().daemon, workspace.id);
  if (pr) {
    const choice = fresh ? "" : workspaceSelect.value;
    void lastPrWorkspaces().then((all) => chrome.storage.local.set({ prWorkspace: { ...all, [repoKey(pr!)]: choice } }));
  }
  setStatus("Starting session…");
  // Tag it now: a new worktree isn't linked to the PR until Paseo resolves its branch, and another workspace never is.
  const label = pr ? prLabel(pr) : ticket ? ticketLabel(ticket.id) : null;
  const labels = label ? { [label]: new Date().toISOString().slice(0, 10) } : {};
  const agent = await workspace.agents.create({ config, prompt: text, labels, ...(imgs.length ? { images: imgs } : {}) });
  closeNewForm();
  newDefaults = null;
  selectedId = keyOf(host.id, agent.id);
  unsubscribeTimeline?.();
  unsubscribeTimeline = null;
  await loadSessions();
  if (lightFallback) setStatus(lightFallback), (lightFallback = "");
}

// ponytail: 5 MB of base64 per image is Claude's API cap; the Paseo schema sets none, and other providers may allow more.
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;

function addImages(files: ArrayLike<File>) {
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(",")[1] ?? "";
      if (data.length > MAX_IMAGE_BASE64) return setStatus(`${file.name || "Image"} is too large (5 MB max)`);
      images.push({ data, mimeType: file.type });
      renderImages();
    };
    reader.readAsDataURL(file);
  }
}

function renderImages() {
  attachmentsEl.hidden = !images.length;
  attachmentsEl.replaceChildren(
    ...images.map((img) => {
      const remove = el("button", { textContent: "×", title: "Remove image" });
      remove.onclick = () => ((images = images.filter((i) => i !== img)), renderImages());
      return el("div", { className: "thumb" }, el("img", { src: `data:${img.mimeType};base64,${img.data}`, alt: "" }), remove);
    }),
  );
}

async function send() {
  const text = prompt.value.trim();
  const sent = images;
  if (!text && !sent.length) return;
  sendBtn.disabled = true;
  try {
    if (isCreating()) await createSession(text, sent);
    else if (selectedId) {
      const t = on(selectedId);
      await t.api.agents.ref(t.id).send(text, sent.length ? { images: sent } : undefined);
      timeline.append(el("div", { className: "msg user", textContent: text }), working("Working"));
      document.body.classList.add("busy");
      timeline.scrollTop = timeline.scrollHeight;
    } else return;
    prompt.value = "";
    images = images.filter((i) => !sent.includes(i));
    renderImages();
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sendBtn.disabled = false;
  }
}

type Command = Awaited<ReturnType<DaemonClient["listCommands"]>>["commands"][number];
const commandCache = new Map<string, Promise<Command[]>>();
let suggestions: Command[] = [];

function commandsOf(id: string) {
  const t = on(id);
  if (!commandCache.has(id)) commandCache.set(id, t.daemon.listCommands(t.id).then((r) => r.commands, () => []));
  return commandCache.get(id)!;
}
let suggestIndex = 0;

// Paseo returns nothing before a session exists, so a new session's first message gets no suggestions.
async function updateSuggestions() {
  const query = prompt.value.match(/^\/(\S*)$/)?.[1];
  const id = selectedId;
  if (query === undefined || !id || isCreating()) return closeSuggestions();
  const commands = await commandsOf(id);
  if (prompt.value.match(/^\/(\S*)$/)?.[1] !== query) return;
  const q = query.toLowerCase();
  suggestions = commands
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, 50);
  suggestIndex = 0;
  if (!suggestions.length) return closeSuggestions();
  renderSuggestions();
}

function renderSuggestions() {
  suggest.hidden = false;
  suggest.replaceChildren(
    ...suggestions.map((c, i) => {
      const row = el("div", { className: `cmd${i === suggestIndex ? " active" : ""}`, title: c.description }, el("b", { textContent: `/${c.name}` }), el("span", { textContent: c.argumentHint || c.description }));
      // mousedown, not click: click would blur the prompt and close the list first.
      row.onmousedown = (e) => (e.preventDefault(), pickSuggestion(i));
      return row;
    }),
  );
  suggest.children[suggestIndex]?.scrollIntoView({ block: "nearest" });
}

function pickSuggestion(i: number) {
  const c = suggestions[i];
  if (!c) return;
  prompt.value = `/${c.name} `;
  closeSuggestions();
  prompt.focus();
}

function closeSuggestions() {
  suggest.hidden = true;
  suggestions = [];
}

// ---- PR actions: each one only fills the composer; ＋ New picks up the workspace and model it suggests. ----

function fillComposer(text: string) {
  prompt.value = mergeDraft(prompt.value, text);
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
}

// `fresh`: open ＋ New with the text and the action's defaults, so starting it is one Send.
function act(text: string, defaults: NewDefaults | null, fresh = false) {
  closeMenu();
  newDefaults = defaults;
  // No defaults: the preset targets the selected session, so leave the new-session form.
  if (!fresh && !defaults && isCreating()) closeNewForm(), void loadSessions();
  fillComposer(text);
  // Re-run the form so an open one takes the new defaults.
  if (fresh || (defaults && isCreating())) void openNewForm();
}

// Fill composer, and the same into a new session.
function goButtons(run: (fresh: boolean) => void) {
  const fill = el("button", { className: "primary", textContent: "Fill composer" });
  const fresh = el("button", { textContent: "New session", title: "Open ＋ New with this, ready to send" });
  fill.onclick = () => run(false);
  fresh.onclick = () => run(true);
  return el("div", { className: "go-row" }, fresh, fill);
}

const loadPresets = () => loadStore(chrome.storage.sync);

type Discovered = Found & { providerLabel: string };

// Commands are per session, and a session only exists once started, so ask one per ready provider: this PR's first, else the latest.
// A provider ready on several hosts is asked on the first one with a session of it.
async function discover(): Promise<Discovered[]> {
  const snapshots = await Promise.all(upConns().map(async (c) => ({ host: c.host.id, entries: (await c.api.providers.snapshot().catch(() => null))?.entries ?? [] })));
  const pool = [...listed(), ...byRecency(everyone)].filter((a) => !a.archivedAt);
  const asked = new Set<string>();
  const picks = snapshots.flatMap(({ host, entries }) =>
    entries
      .filter((p) => p.enabled && p.status === "ready" && !asked.has(p.provider))
      .flatMap((p) => {
        const a = pool.find((x) => x.provider === p.provider && splitKey(x.id).host === host);
        return a ? (asked.add(p.provider), [{ p, a }]) : [];
      }),
  );
  const lists = await Promise.all(
    picks.map(async ({ p, a }) => (await commandsOf(a.id)).map((c) => ({ ...c, provider: p.provider, providerLabel: p.label ?? p.provider }))),
  );
  const found = lists.flat();
  void cacheDiscovered(found);
  return found;
}

// The options page lists the last review and feedback commands seen per provider, to rename, hide or favorite them.
async function cacheDiscovered(found: Discovered[]) {
  const fresh: DiscoveredCache = {};
  for (const c of found) {
    const kind = isReviewCommand(c) ? "review" : isFeedbackCommand(c) ? "feedback" : null;
    if (kind) (fresh[c.provider] ??= { label: c.providerLabel, commands: [] }).commands.push({ name: c.name, description: c.description ?? "", argumentHint: c.argumentHint ?? "", kind });
  }
  const { discovered } = await chrome.storage.local.get<{ discovered: DiscoveredCache }>({ discovered: {} });
  await chrome.storage.local.set({ discovered: { ...discovered, ...fresh } });
}

// The GitHub data of a workspace on PR `n`, if one has its checks.
const ghPr = (n: number) =>
  workspaces
    .filter((w) => onPr(w, { ...pr!, number: n }))
    .map((w) => w.githubRuntime?.pullRequest)
    .find((p) => p?.checks?.length);

// The whole stack bottom to top, or just this PR; and the part of it the actions cover.
const stackNumbers = () => (stackPrs.length > 1 ? stackPrs.map((s) => s.number) : [pr!.number]);
const scopePrs = () => presetScope({}, stackNumbers(), picked, pr!.number);

function updateFixCi() {
  const passing = scopePrs().every((n) => ghPr(n)?.checksStatus === "success");
  fixCiBtn.disabled = passing;
  fixCiBtn.title = passing ? "All checks pass" : "Ask a session to fix the failing checks";
  // This PR's checks, whatever the scope.
  const status = workspaces.filter(isPrWorkspace).map((w) => w.githubRuntime?.pullRequest?.checksStatus).find((s) => s && s !== "none") ?? "none";
  const label = { success: "passing", pending: "pending", failure: "failing", none: "" }[status];
  ciState.hidden = !label;
  ciState.className = status;
  ciState.textContent = `CI ${label}`;
}

function renderScope() {
  const [all, prs, current] = [stackNumbers(), scopePrs(), pr!.number];
  const stacked = all.length > 1;
  scopeBtn.disabled = !stacked;
  scopeBtn.title = stacked ? "Which PRs Review, Fix CI and Feedback cover" : "This PR isn't in a stack";
  scopeBtn.textContent = !stacked
    ? "This PR (no stack)"
    : prs.length === all.length
      ? `Whole stack (${all.length}) ▾`
      : prs.length > 1
        ? `${prs.length} PRs ▾`
        : prs[0] === current
          ? "This PR ▾"
          : `#${prs[0]} ▾`;
  updateFixCi();
}

async function commentPrompt(intent: "evaluate" | "address", comment: string, fresh: boolean) {
  const [store, found] = await Promise.all([loadPresets(), discover()]);
  // A skill only helps if the session it's sent to has it; with no session chosen yet, ＋ New preselects its provider.
  const target = fresh || isCreating() ? undefined : listed().find((a) => a.id === selectedId)?.provider;
  const x = feedbackPreset(`feedback-${intent}`, store, found.filter((c) => !target || c.provider === target));
  const vars = pr ? { pr: `#${pr.number}`, url: prUrl(pr), prs: prLines(pr, [pr.number]), comment } : { comment };
  if (pr) newDefaults = newDefaultsFor(x, [pr.number]);
  return presetText(x, vars, comment || (pr ? `#${pr.number}` : ""));
}

let menuFor: HTMLElement | null = null;

function closeMenu() {
  menuFor = null;
  menuBox.hidden = true;
}

async function openMenu(anchor: HTMLElement, build: () => Promise<Node[]>, customize = true) {
  if (menuFor === anchor) return closeMenu();
  menuFor = anchor;
  menuBox.style.left = `${anchor.offsetLeft}px`;
  menuBox.replaceChildren(el("div", { className: "menu-note", textContent: "Loading…" }));
  menuBox.hidden = false;
  const nodes = await build().catch((err) => [el("div", { className: "menu-note", textContent: String(err) })]);
  const link = el("button", { className: "menu-link", textContent: "Customize…" });
  link.onclick = () => (closeMenu(), void chrome.runtime.openOptionsPage());
  if (menuFor !== anchor) return;
  menuBox.replaceChildren(...nodes, ...(customize ? [link] : []));
  // Keep it inside a narrow panel: shift left rather than overflow the right edge.
  const room = menuBox.parentElement!.clientWidth - menuBox.offsetWidth - 10;
  menuBox.style.left = `${Math.max(10, Math.min(anchor.offsetLeft, room))}px`;
}

function menuItem(label: string, sub: string | undefined, onPick: () => void, title = "") {
  const b = el("button", { className: "menu-item", title }, el("b", { textContent: label }), ...(sub ? [el("span", { textContent: sub })] : []));
  b.onclick = onPick;
  return b;
}

const heading = (text: string) => el("h4", { textContent: text });

// This PR, the whole stack, or the PRs ticked, bottom to top. `then` is an action waiting on the choice.
function scopeMenu(then?: (fresh: boolean) => void) {
  const current = pr!.number;
  const set = (numbers: number[]) => () => ((picked = new Set(numbers)), renderScope(), then ? then(false) : closeMenu());
  const boxes = stackPrs.map((s) => {
    const box = el("input", { type: "checkbox", checked: picked.has(s.number) });
    box.onchange = () => {
      if (!box.checked && scopePrs().length === 1) return void (box.checked = true);
      box.checked ? picked.add(s.number) : picked.delete(s.number);
      renderScope();
    };
    return el("label", { title: s.title }, box, el("span", { textContent: `#${s.number}${s.number === current ? " (this PR)" : ""} ${s.title}` }));
  });
  return [
    menuItem("This PR", `#${current}`, set([current])),
    menuItem("Whole stack", `${stackPrs.length} PRs`, set(stackNumbers())),
    el("div", { className: "scope" }, heading("Choose PRs, bottom to top"), ...boxes, ...(then ? [goButtons(then)] : [])),
  ];
}

scopeBtn.onclick = () => void openMenu(scopeBtn, async () => scopeMenu(), false);

type MenuPreset = Preset & { description?: string; argumentHint?: string };

// Fills the composer with a preset over its scope, and points ＋ New at the topmost PR in it.
// A command first opens its form in the menu, under `anchor`; the form comes back with its `args`.
function runPreset(x: MenuPreset, anchor: HTMLElement, args?: string, fresh = false) {
  const p = pr!;
  if (x.scope === "ask" && stackNumbers().length > 1)
    return void openMenu(scopeBtn, async () => [heading(`${x.label}: which PRs?`), ...scopeMenu((f) => runPreset({ ...x, scope: undefined }, scopeBtn, undefined, f))], false);
  const prs = presetScope(x, stackNumbers(), picked, p.number);
  picked = new Set(prs);
  renderScope();
  if (x.command && args === undefined) return closeMenu(), void openMenu(anchor, () => commandForm(x, anchor, prs), false);
  const checks = checksText(prs.map((n) => ({ number: n, checks: ghPr(n)?.checks })));
  act(presetText(x, { pr: `#${p.number}`, url: prUrl(p), prs: prLines(p, prs), checks }, args ?? scopeText(prs)), newDefaultsFor(x, prs), fresh);
}

// A command's arguments as controls, the target scope resolves to, a preview of the command line, and Fill composer.
// The values used last per menu entry come back next time (chrome.storage.local), over the preset's saved ones.
async function commandForm(x: MenuPreset, anchor: HTMLElement, prs: number[]) {
  const key = `args:${x.id}`;
  const last = (await chrome.storage.local.get<Record<string, ArgValues>>(key))[key];
  const spec = parseHint(x.argumentHint);
  const target = el("div", { className: "menu-note" });
  const note = el("div", { className: "menu-note" });
  const preview = el("code", { className: "preview" });
  const read = () => {
    const r = commandArgs(x.command!, spec, readArgs(controls), stackPrs, prs);
    target.textContent = r.target ? `Target: ${r.target}` : `No PR target in /${x.command}'s arguments`;
    note.textContent = r.note ?? "";
    note.hidden = !r.note;
    preview.textContent = `/${x.command} ${r.args}`.trim();
    return r.args;
  };
  const controls = argControls(spec, { ...x.args, ...last }, read);
  const go = goButtons((fresh) => {
    void chrome.storage.local.set({ [key]: readArgs(controls) });
    runPreset({ ...x, scope: undefined }, anchor, read(), fresh);
  });
  read();
  return [heading(x.label), el("div", { className: "cmd-form", title: x.argumentHint ?? "" }, controls, target, note, preview, go)];
}

// Favorites, presets and commands alike, on top; then the presets; then the other commands.
function presetMenu(anchor: HTMLElement, own: MenuPreset[], commands: MenuPreset[]) {
  const item = (x: MenuPreset) => {
    const fresh = el("button", { className: "menu-new", textContent: "＋ New", title: "In a new session" });
    fresh.onclick = () => runPreset(x, anchor, undefined, true);
    return el("div", { className: "menu-row" }, menuItem(`${x.favorite ? "★ " : ""}${x.label}`, x.provider, () => runPreset(x, anchor), x.description), fresh);
  };
  const [mine, found] = [arrange(own), arrange(commands)];
  const rest = found.filter((x) => !x.favorite);
  return [
    ...[...mine.filter((x) => x.favorite), ...found.filter((x) => x.favorite), ...mine.filter((x) => !x.favorite)].map(item),
    ...(rest.length ? [heading("Commands")] : []),
    ...rest.map(item),
  ];
}

// A preset naming a command takes that command's argument hint, from its provider's session if it names one.
const withHint = (x: Preset, found: Found[]): MenuPreset =>
  x.command ? { ...x, argumentHint: found.find((c) => c.name === x.command && (!x.provider || c.provider === x.provider))?.argumentHint } : x;

const openReview = () =>
  openMenu(reviewBtn, async () => {
    const [found, store] = await Promise.all([discover(), loadPresets()]);
    return presetMenu(
      reviewBtn,
      store.presets.filter((x) => x.kind === "review").map((x) => withHint(x, found)),
      found.filter(isReviewCommand).map((c) => commandPreset(c, "review", store.overrides)),
    );
  });
reviewBtn.onclick = () => void openReview();

// One CI preset runs straight away; several get a menu.
async function openFixCi() {
  const ci = arrange((await loadPresets()).presets.filter((x) => x.kind === "ci"));
  // Always a menu, so every preset offers the composer or a new session.
  void openMenu(fixCiBtn, async () => presetMenu(fixCiBtn, ci.length ? ci : DEFAULT_PRESETS.filter((x) => x.kind === "ci"), []));
}
fixCiBtn.onclick = openFixCi;

const openFeedback = () =>
  openMenu(feedbackBtn, async () => {
    const [found, store] = await Promise.all([discover(), loadPresets()]);
    return presetMenu(
      feedbackBtn,
      store.presets.filter((x) => x.kind.startsWith("feedback-")).map((x) => withHint(x, found)),
      found.filter(isFeedbackCommand).map((c) => commandPreset(c, "feedback-address", store.overrides)),
    );
  });
feedbackBtn.onclick = () => void openFeedback();

// By path, not containment: picking an item can replace it (an "ask" preset swaps in the scope picker).
document.addEventListener("click", (e) => {
  if (menuFor && !e.composedPath().some((n) => n === menuBox || n === menuFor)) closeMenu();
});

async function syncActiveTab(force = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Opening the panel counts as looking at the tab.
  if (tab?.id !== undefined) void chrome.tabs.sendMessage(tab.id, { type: "unmark" }).catch(() => {});
  if (pinned) return force ? loadSessions() : undefined;
  viewUrl = tab?.url;
  const nextPr = parsePr(tab?.url);
  const nextTicket = nextPr ? null : parseTicket(tab?.url);
  const had = inbox.length;
  setPageInbox(nextPr || nextTicket || tab?.id === undefined ? [] : await inboxOf(tab.id));
  void loadStacks();
  await switchTo(nextPr, nextTicket, force);
  // Inbox and all sessions share the "all" context, so switchTo doesn't re-render between them.
  if (!pr && !ticket && (had || inbox.length)) renderAll();
}

async function switchTo(nextPr: Pr | null, nextTicket: Ticket | null, force = false) {
  const [from, to] = [viewKey(), viewKey(nextPr, nextTicket)];
  if (!force && from === to) return;
  closeNewForm();
  pr = nextPr;
  ticket = nextTicket;
  if (from !== to) (newDefaults = null), (picked = new Set(nextPr ? [nextPr.number] : [])), closeMenu();
  // Drafts belong to the context they were typed in: park this one, bring back the next one's.
  if (from !== to) {
    void chrome.storage.session.set({ [`ctxdraft:${from}`]: prompt.value });
    const saved = (await chrome.storage.session.get(`ctxdraft:${to}`))[`ctxdraft:${to}`];
    prompt.value = typeof saved === "string" ? saved : "";
  }
  await loadSessions();
}

// ---- Inbox view (src/inbox-view.ts): asked of the tab's ext/inbox.js, which also sends its rows whenever they change. ----

const inboxRows = (raw: unknown): InboxRow[] =>
  (Array.isArray(raw) ? raw : []).flatMap((r) => {
    const p = rowPr(r?.href, r?.sub);
    return p ? [{ pr: p, title: String(r.title ?? ""), section: String(r.section ?? ""), sectionIndex: Number(r.sectionIndex) || 0, href: r.href, sub: r.sub }] : [];
  });

const inboxOf = async (tabId: number) => inboxRows((await chrome.tabs.sendMessage(tabId, { type: "inbox-rows" }).catch(() => null))?.rows);

// Archived sessions are only in `everyone`; sessions started since loading only in `agents`.
const sessionPool = () => [...new Map([...everyone, ...agents].map((a) => [a.id, a])).values()];
const inboxSessions = (p: Pr) => agentsOnPr(workspaces, sessionPool(), p);

const inboxPicker = () =>
  groupInbox(inbox, inboxSessions, inboxSettings, currentStacks()).flatMap((g) =>
    g.prs.filter((x) => x.sessions.length).map((x) => [`#${x.row.pr.number} ${x.row.title}`, x.sessions] as const),
  );

const inboxList = () =>
  renderInbox(inbox, inboxSessions, inboxSettings, {
    pick: (a) => {
      // Keeps the picker's selection (and the archived state) for sessions outside the all-sessions groups.
      if (!agents.some((x) => x.id === a.id)) agents.push(a);
      agentSelect.value = a.id;
      selectAgent(a.id);
    },
    open: (p) => void openPr(p),
    name: sessionName,
    host: hostOf,
    toggle: (key, open) => void toggleStack(key, open),
  }, currentStacks(), expandedStacks, { q: search.value, fields: searchFields });

const rowKey = (r: InboxRow) => `${r.section}\n${prLabel(r.pr)}`;
function currentStacks(): RowStack[] {
  const at = new Map(inbox.map((r, i) => [rowKey(r), i]));
  return inboxStacks.stacks.map(({ key, rows }) => ({ key, rows: rows.flatMap((i) => at.get(rowKey(inboxStacks.rows[i])) ?? []) }));
}

let stacksAsked = "";
async function loadStacks() {
  const asked = inboxSettings.groupStacks ? inbox : [];
  const ask = JSON.stringify(asked.map(({ href, sub, title, section }) => ({ href, sub, title, section })));
  if (ask === stacksAsked) return;
  stacksAsked = ask;
  if (!asked.length) return void (inboxStacks = { rows: [], stacks: [] });
  const res = await chrome.runtime.sendMessage({ type: "inbox-stacks", rows: JSON.parse(ask) }).catch(() => null);
  if (ask !== stacksAsked) return;
  // No answer (Paseo not reachable yet): ask again next time.
  if (!Array.isArray(res?.stacks)) return void (stacksAsked = "");
  inboxStacks = { rows: asked, stacks: res.stacks };
  if (!pr && !ticket) renderAll();
}

// chrome.storage.local `stacks`: { [stack key]: true } for each expanded stack.
// ponytail: keys of stacks that are gone stay; a few bytes each.
async function toggleStack(key: string, open: boolean) {
  const { stacks } = await chrome.storage.local.get("stacks");
  const next: Record<string, true> = { ...(stacks as Record<string, true> | undefined) };
  if (open) next[key] = true;
  else delete next[key];
  await chrome.storage.local.set({ stacks: next });
}
const setExpanded = (stacks: unknown) => (expandedStacks = new Set(Object.keys(stacks ?? {})));
void chrome.storage.local.get("stacks").then(({ stacks }) => setExpanded(stacks));

// A PR from the inbox (its pill or its row in the Inbox view): show it here, pinned, without navigating the tab.
async function openPr(p: Pr, url?: string) {
  viewUrl = url;
  pinned = true;
  pinBtn.setAttribute("aria-pressed", "true");
  await switchTo(p, null, true);
}

let knownSections = "";
function setInbox(rows: InboxRow[]) {
  setPageInbox(rows);
  void loadStacks();
  // For the options page, which can't see the page.
  const names = JSON.stringify(pageSections(rows));
  if (rows.length && names !== knownSections) (knownSections = names), void chrome.storage.local.set({ inboxSections: JSON.parse(names) });
  if (!pr && !ticket) renderAll();
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "inbox-rows" || !Array.isArray(msg.rows) || pinned || !sender.tab?.active) return;
  const from = sender.tab.windowId;
  void windowId.then((id) => from === id && setInbox(inboxRows(msg.rows)));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.inbox) void loadInboxSettings().then((s) => ((inboxSettings = s), void loadStacks(), inbox.length && !pr && !ticket && renderAll()));
  if (area === "local" && changes.stacks) (setExpanded(changes.stacks.newValue), inbox.length && !pr && !ticket && renderAll());
});
void loadInboxSettings().then((s) => (inboxSettings = s));
const setShowAll = (v: unknown) => {
  showAll = v === true;
  setPageInbox(pageInbox);
  void loadStacks();
  if (!pr && !ticket) renderAll();
};
void chrome.storage.sync.get("allSessions").then(({ allSessions }) => setShowAll(allSessions));
chrome.storage.onChanged.addListener((changes, area) => area === "sync" && changes.allSessions && setShowAll(changes.allSessions.newValue));

pinBtn.onclick = () => {
  pinned = !pinned;
  pinBtn.setAttribute("aria-pressed", String(pinned));
  setStatus(lastStatus);
  if (!pinned && connected()) void syncActiveTab();
};

timeline.onclick = (e) => {
  const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  e.preventDefault();
  if (/^https?:/.test(link.href)) void chrome.tabs.create({ url: link.href });
};
agentSelect.onchange = () => selectAgent(agentSelect.value || null);
search.oninput = () => selectAgent(null);
search.onkeydown = (e) => {
  if (e.key !== "Escape" || !search.value) return;
  e.preventDefault();
  search.value = "";
  selectAgent(null);
};
newBtn.onclick = () => (isCreating() ? (closeNewForm(), void loadSessions()) : void openNewForm());
sendBtn.onclick = () => void send();
sessionMode.onchange = async () => {
  if (!selectedId) return;
  try {
    const t = on(selectedId);
    await t.daemon.setAgentMode(t.id, sessionMode.value);
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  sessionMode.blur();
  void renderTimeline();
};
stopBtn.onclick = async () => {
  if (!selectedId) return;
  stopBtn.disabled = true;
  try {
    const t = on(selectedId);
    await t.daemon.cancelAgent(t.id);
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    stopBtn.disabled = false;
  }
  void renderTimeline();
};
unarchiveBtn.onclick = async () => {
  if (!selectedId) return;
  unarchiveBtn.disabled = true;
  try {
    // Same call as Paseo's own Unarchive button.
    const t = on(selectedId);
    await t.daemon.refreshAgent(t.id);
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
  if (e.isComposing) return;
  if (!suggest.hidden) {
    const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (move) {
      e.preventDefault();
      suggestIndex = (suggestIndex + move + suggestions.length) % suggestions.length;
      renderSuggestions();
      return;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      pickSuggestion(suggestIndex);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSuggestions();
      return;
    }
  }
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  void send();
};
prompt.oninput = () => void updateSuggestions();
prompt.onblur = () => closeSuggestions();
prompt.onpaste = (e) => {
  const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  addImages(files);
};
prompt.ondragover = (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
};
prompt.ondrop = (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  addImages(e.dataTransfer.files);
};
// A light worktree can't get the repo's setup afterwards (Paseo only runs setup on demand for blocked fork PRs), so this
// opens ＋ New on a full worktree for the PR instead.
fullWorktree.onclick = (e) => {
  e.preventDefault();
  if (!fullWorktreePr) return;
  newDefaults = { number: fullWorktreePr, reuse: false };
  void openNewForm();
};
openInPaseo.onclick = (e) => {
  e.preventDefault();
  if (openInPaseo.href.startsWith("paseo:")) void chrome.tabs.update({ url: openInPaseo.href });
};
const windowId = chrome.windows.getCurrent().then((w) => w.id);
const draftKey = windowId.then((id) => `draft:${id}`);
const startKey = windowId.then((id) => `start:${id}`);
const openKey = windowId.then((id) => `open:${id}`);
// ext/review.js hands over comments and diff lines; `intent` asks to evaluate or address a comment instead of just quoting it,
// `fresh` (shift-click) to start a new session with it, like the actions bar's New session.
async function takeDraft() {
  const key = await draftKey;
  const drafts = (await chrome.storage.session.get(key))[key];
  if (!Array.isArray(drafts) || !drafts.length) return;
  await chrome.storage.session.remove(key);
  for (const { text, intent, fresh } of drafts as { text: string; intent?: "evaluate" | "address"; fresh?: boolean }[]) {
    const full = intent ? await commentPrompt(intent, text, !!fresh) : text;
    if (fresh) act(full, newDefaults, true);
    else fillComposer(full);
  }
}
// The Linear page's ▶ Paseo button: switch to that ticket, even when pinned elsewhere, and open its new-session form.
async function takeStart() {
  const key = await startKey;
  const start = (await chrome.storage.session.get<Record<string, Partial<Ticket>>>(key))[key];
  if (!start) return;
  await chrome.storage.session.remove(key);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const t = parseTicket(tab?.url);
  if (!t || t.id !== start.id?.toUpperCase()) return;
  const title = typeof start.title === "string" ? ticketTitle(start.title, t.id) : undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  await switchTo(null, { ...t, title, branch: str(start.branch), description: str(start.description) }, true);
  // Reopen so a second click refreshes the prefill.
  if (isCreating()) closeNewForm();
  await openNewForm();
}
// An inbox pill (ext/inbox.js → background "open-pr"), a CI alert or the PR page's actions bar (ext/content.js → "pr-action"):
// switch to that PR, pinned unless it came from the PR's own page, and open the action's menu.
// A request the panel was too late for is dropped.
const ACTION_MENUS: Record<string, () => Promise<unknown>> = { review: openReview, fixci: openFixCi, feedback: openFeedback };
async function takeOpen() {
  const key = await openKey;
  const open = (await chrome.storage.session.get<Record<string, { url?: string; at?: number; action?: string; pin?: boolean }>>(key))[key];
  if (!open) return;
  await chrome.storage.session.remove(key);
  const p = parsePr(open.url);
  if (!p || Date.now() - (open.at ?? 0) >= 60_000) return;
  if (open.pin === false) await switchTo(p, null, true);
  else await openPr(p, open.url);
  await ACTION_MENUS[open.action ?? ""]?.();
}
chrome.storage.session.onChanged.addListener(async (changes) => {
  if (changes[await openKey]?.newValue && connected()) void takeOpen();
  if (changes[await draftKey]?.newValue) void takeDraft();
  if (changes[await startKey]?.newValue && connected()) void takeStart();
});
void takeDraft();
settingsBtn.onclick = () => (settingsBox.hidden = !settingsBox.hidden);
$<HTMLButtonElement>("customize-btn").onclick = () => void chrome.runtime.openOptionsPage();
void chrome.storage.sync.get<Record<string, boolean>>(SETTINGS).then((saved) => {
  for (const input of settingsBox.querySelectorAll("input")) {
    input.checked = saved[input.name];
    input.onchange = () => void chrome.storage.sync.set({ [input.name]: input.checked });
  }
});

// Checks change without the sessions changing: keep the CI state and Fix CI current.
function onWorkspace(w: Workspace) {
  const i = workspaces.findIndex((x) => x.id === w.id);
  if (i < 0) return;
  workspaces[i] = w;
  if (pr) updateFixCi();
}

// Relabel picker options in place so the running dots stay live without touching the selection or timeline.
function onAgent(agent: PaseoAgent) {
  for (const list of [everyone, agents, ...stackGroups.map((g) => g.agents)]) {
    const i = list.findIndex((a) => a.id === agent.id);
    if (i >= 0) list[i] = agent;
  }
  // The all-sessions view regroups (and picks up new sessions) instead.
  if (!pr && !ticket) {
    if (!agents.some((a) => a.id === agent.id)) agents.push(agent);
    clearTimeout(allTimer);
    allTimer = setTimeout(renderPicker, 300);
    return;
  }
  const option = [...agentSelect.options].find((o) => o.value === agent.id);
  if (option) option.textContent = optionLabel(agent);
}

const connected = () => conns.some(isUp);
chrome.tabs.onActivated.addListener(() => {
  if (connected()) void syncActiveTab();
});
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && info.url && connected()) void syncActiveTab();
});

// Per host: whether its agents and workspaces subscriptions are up.
const live = new Map<string, Promise<unknown>>();
const subscribeOnce = (key: string, start: () => Promise<unknown>) => {
  if (!live.has(key)) live.set(key, start().catch(() => live.delete(key)));
};

// One client per host. A host that's down shows as "<host>: can't reach" while the others work, and keeps being retried.
// The browser hides the daemon's 403, so a disallowed origin looks like any other failed connect.
void connectHosts("paseo-graphite").then((list) => {
  for (const c of list) {
    const host = c.host.id;
    c.api.workspaces.subscribe((u) => u.kind === "upsert" && onWorkspace(tagWorkspace(host, u.workspace)));
    c.api.agents.subscribe((u) => u.kind === "upsert" && onAgent(tagAgent(host, u.agent)));
    let wasUp = false;
    c.daemon.subscribeConnectionStatus((s) => {
      const down = hostStatus();
      hostStatusEl.textContent = down ?? "";
      hostStatusEl.hidden = !down;
      if (s.status === "connected") {
        wasUp = true;
        void syncActiveTab(true).then(takeStart).then(takeOpen);
        // The daemon only sends agent updates once asked; the subscription re-subscribes after reconnects by itself.
        subscribeOnce(`${host}:agents`, () => c.api.agents.list({ subscribe: {} }));
        subscribeOnce(`${host}:workspaces`, () => c.api.workspaces.list({ subscribe: {} }));
      }
      if (s.status !== "disconnected") return;
      // Another host is still up: drop this one's sessions until it's back.
      if (connected()) return void (wasUp && ((wasUp = false), syncActiveTab(true)));
      setStatus(
        `Can't reach Paseo at ${conns.map((x) => x.host.url).join(", ")}, retrying. If Paseo is running, allow this extension: node scripts/allow-origin.mjs`,
      );
    });
    void c.daemon.connect().catch(() => {});
  }
});

// Lets the background hide the pages' floating session button while this panel is open; reconnects if the worker restarts.
function holdPanelPort() {
  void chrome.windows.getCurrent().then((w) => {
    chrome.runtime.connect({ name: `panel:${w.id}` }).onDisconnect.addListener(() => setTimeout(holdPanelPort, 1000));
  });
}
holdPanelPort();
