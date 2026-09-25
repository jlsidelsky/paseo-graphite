import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import MarkdownIt from "markdown-it";
import {
  arrange,
  checksText,
  commandPreset,
  DEFAULT_PRESETS,
  feedbackPreset,
  isFeedbackCommand,
  isReviewCommand,
  loadStore,
  mergeDraft,
  newDefaultsFor,
  presetScope,
  presetText,
  prLines,
  prUrl,
  scopeText,
  type DiscoveredCache,
  type Found,
  type NewDefaults,
  type Preset,
} from "./actions";
import { diffStrings, parseUnifiedDiff, type DiffLine } from "./diff";
import { isAnswered, parseQuestions, questionResponse, showsText, type Question } from "./question";
import {
  agentsOnPr,
  agentsOnTicket,
  DAEMON_URL,
  groupAll,
  isPrWorkspace as onPr,
  isRepo,
  isTicketWorkspace,
  listSessions,
  parsePr,
  parseTicket,
  prLabel,
  SETTINGS,
  stackOf,
  ticketBranch,
  ticketLabel,
  ticketTitle,
  type Pr,
  type StackPr,
  type Ticket,
  type Workspace,
} from "./pr";

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
const feedbackBtn = $<HTMLButtonElement>("feedback-btn");

const daemon = new DaemonClient({ url: DAEMON_URL, clientId: "paseo-graphite", clientType: "browser" });
const paseo = createPaseoApi(daemon);

type TimelineEntry = Awaited<ReturnType<ReturnType<typeof paseo.agents.ref>["timeline"]["refetch"]>>["entries"][number];
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
let agentsLive: Promise<unknown> | undefined;
let allTimer: ReturnType<typeof setTimeout> | undefined;
let lastStatus = "";

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
const viewName = () => (pr ? `PR #${pr.number}` : ticket ? ticket.id : "All sessions");

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
  const loaded = await listSessions(paseo);
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
  const cwd = workspaces.find((w) => isRepo(w, target))?.workspaceDirectory;
  if (!cwd) return;
  const key = prLabel(target);
  if (!stackCache.has(key)) stackCache.set(key, stackOf(daemon, cwd, target).catch(() => (stackCache.delete(key), [])));
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

const optionLabel = (a: PaseoAgent) => `${a.status === "running" ? "● " : ""}${a.archivedAt ? "(archived) " : ""}${a.title ?? a.id.slice(0, 8)}`;

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

const groups = () => {
  const g = groupAll(agents);
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
  const shown = groups().filter(([, list]) => list.length);
  agentSelect.replaceChildren(
    el("option", { value: "", textContent: "All sessions" }),
    ...shown.map(([label, list]) => el("optgroup", { label }, ...list.map(option))),
  );
  const keep = shown.some(([, list]) => list.some((a) => a.id === selectedId)) ? selectedId : null;
  agentSelect.value = keep ?? "";
  if (keep !== selectedId || !unsubscribeTimeline) selectAgent(keep);
}

function overview() {
  const row = (a: PaseoAgent) => {
    const btn = el("button", { className: "session-row" }, el("b", { textContent: a.title ?? a.id.slice(0, 8) }), el("span", { textContent: [whereOf(a), a.status].filter(Boolean).join(" · ") }));
    btn.onclick = () => ((agentSelect.value = a.id), selectAgent(a.id));
    return btn;
  };
  const nodes = groups().flatMap(([label, list]) => (list.length ? [el("h4", { textContent: label }), ...list.map(row)] : []));
  return nodes.length ? el("div", { className: "overview" }, ...nodes) : el("div", { className: "empty", textContent: "No Paseo sessions yet." });
}

function selectAgent(id: string | null) {
  if (id === selectedId && unsubscribeTimeline) return;
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
  if (!id) {
    setStatus(viewName());
    if (isCreating()) return;
    timeline.append(
      pr || ticket
        ? el("div", { className: "empty", textContent: `No Paseo sessions on this ${pr ? "PR" : "ticket"} yet. Start one with ＋ New.` })
        : overview(),
    );
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
  const page = await paseo.agents.ref(id).timeline.refetch({ direction: "tail", limit: 200 });
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
    await daemon.rewindAgent(agentId, messageId, mode);
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

type PermissionResponse = Parameters<typeof daemon.respondToPermission>[2];

function permissionCard(agentId: string, p: Permission) {
  const card = el("div", { className: "permission" });
  const respond = async (response: PermissionResponse) => {
    const controls = card.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input");
    controls.forEach((c) => (c.disabled = true));
    try {
      await daemon.respondToPermission(agentId, p.id, response);
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

  const option = (w: Workspace) => el("option", { value: w.id, textContent: `${w.title ?? w.name} (${w.worktreeSlug ?? w.workspaceDirectory})` });
  const roots = recentRoots();
  const byProject = (list: Workspace[]) =>
    roots.map((r) => list.filter((w) => w.projectRootPath === r)).filter((g) => g.length).map((g) => el("optgroup", { label: g[0].projectDisplayName }, ...g.map(option)));
  const d = newDefaults;
  if (pr) {
    const prWs = workspaces.filter(isPrWorkspace);
    const others = workspaces.filter((w) => !isPrWorkspace(w));
    const stacked = stackPrs.filter((s) => s.number !== pr!.number);
    const checkout = (n: number, title = "") => el("option", { value: NEW_WORKTREE + n, textContent: `New worktree checked out to PR #${n}${title && ` ${title}`}` });
    workspaceSelect.replaceChildren(
      ...(prWs.length ? [el("optgroup", { label: `On PR #${pr.number}` }, ...prWs.map(option))] : []),
      checkout(pr.number),
      ...(stacked.length ? [el("optgroup", { label: "Other PRs in the stack" }, ...stacked.map((s) => checkout(s.number, s.title)))] : []),
      el("optgroup", { label: "Other workspaces" }, ...others.map(option)),
    );
    const target = d?.number ?? pr.number;
    const existing = workspaces.find((w) => onPr(w, { ...pr!, number: target }));
    workspaceSelect.value = (d?.reuse !== false && existing?.id) || NEW_WORKTREE + target;
  } else if (ticket) {
    const id = ticket.id;
    const onTicket = workspaces.filter((w) => isTicketWorkspace(w, id));
    const name = (root: string) => workspaces.find((w) => w.projectRootPath === root)?.projectDisplayName ?? root;
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
  const preferred = (d?.model && models.find((m) => m.key === d.model)) || (d?.provider && of(d.provider)) || of("claude") || models[0];
  if (preferred) modelSelect.value = preferred.key;
  // A preset's effort and mode, where this model and provider offer them.
  const pick = (select: HTMLSelectElement, value?: string) => value && [...select.options].some((o) => o.value === value) && (select.value = value);
  fillEfforts();
  pick(effortSelect, d?.effort);
  fillModes();
  pick(modeSelect, d?.mode);
}

const byRecency = (list: PaseoAgent[]) => [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

// Project roots, most recently used first.
function recentRoots() {
  const rootOf = new Map(workspaces.map((w) => [w.id, w.projectRootPath]));
  const roots = [...byRecency(everyone).map((a) => rootOf.get(a.workspaceId ?? "")), ...workspaces.map((w) => w.projectRootPath)];
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

async function createSession(text: string, imgs: typeof images) {
  const config = {
    provider: modelSelect.value,
    ...(effortSelect.value ? { thinkingOptionId: effortSelect.value } : {}),
    ...(modeSelect.value && !modeSelect.hidden ? { modeId: modeSelect.value } : {}),
  };
  let workspace;
  if (pr && workspaceSelect.value.startsWith(NEW_WORKTREE)) {
    const target = pr;
    const number = Number(workspaceSelect.value.slice(NEW_WORKTREE.length));
    const repoRoot = workspaces.find((w) => isRepo(w, target))?.projectRootPath;
    if (!repoRoot) throw new Error(`No Paseo project for ${pr.owner}/${pr.repo}`);
    setStatus("Creating worktree…");
    timeline.replaceChildren(el("div", { className: "empty", textContent: `Creating a worktree for PR #${number}. This takes a few seconds.` }));
    workspace = await paseo.workspaces.create({
      source: { kind: "worktree", cwd: repoRoot, action: "checkout", checkoutSource: { kind: "change_request", forge: "github", number } },
    });
  } else if (ticket && workspaceSelect.value.startsWith(NEW_WORKTREE)) {
    const branchName = ticketBranch(ticket);
    setStatus("Creating worktree…");
    timeline.replaceChildren(el("div", { className: "empty", textContent: `Creating a worktree on ${branchName}. This takes a few seconds.` }));
    // Branches off the default branch. If the branch already exists, Paseo branches off it under a new name instead.
    workspace = await paseo.workspaces.create({
      source: { kind: "worktree", cwd: workspaceSelect.value.slice(NEW_WORKTREE.length), action: "branch-off", branchName },
    });
  } else {
    workspace = paseo.workspaces.ref(workspaceSelect.value);
  }
  setStatus("Starting session…");
  // Tag it now: a new worktree isn't linked to the PR until Paseo resolves its branch, and another workspace never is.
  const label = pr ? prLabel(pr) : ticket ? ticketLabel(ticket.id) : null;
  const labels = label ? { [label]: new Date().toISOString().slice(0, 10) } : {};
  const agent = await workspace.agents.create({ config, prompt: text, labels, ...(imgs.length ? { images: imgs } : {}) });
  closeNewForm();
  newDefaults = null;
  selectedId = agent.id;
  unsubscribeTimeline?.();
  unsubscribeTimeline = null;
  await loadSessions();
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
      await paseo.agents.ref(selectedId).send(text, sent.length ? { images: sent } : undefined);
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

type Command = Awaited<ReturnType<typeof daemon.listCommands>>["commands"][number];
const commandCache = new Map<string, Promise<Command[]>>();
let suggestions: Command[] = [];

function commandsOf(id: string) {
  if (!commandCache.has(id)) commandCache.set(id, daemon.listCommands(id).then((r) => r.commands, () => []));
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

function act(text: string, defaults: NewDefaults | null) {
  closeMenu();
  newDefaults = defaults;
  // No defaults: the preset targets the selected session, so leave the new-session form.
  if (!defaults && isCreating()) closeNewForm(), void loadSessions();
  fillComposer(text);
  // Re-run the form so an open one takes the new defaults.
  if (defaults && isCreating()) void openNewForm();
}

const loadPresets = () => loadStore(chrome.storage.sync);

type Discovered = Found & { providerLabel: string };

// Commands are per session, and a session only exists once started, so ask one per ready provider: this PR's first, else the latest.
async function discover(): Promise<Discovered[]> {
  const snapshot = await paseo.providers.snapshot();
  const pool = [...listed(), ...byRecency(everyone)].filter((a) => !a.archivedAt);
  const lists = await Promise.all(
    snapshot.entries
      .filter((p) => p.enabled && p.status === "ready")
      .map(async (p) => {
        const a = pool.find((x) => x.provider === p.provider);
        return a ? (await commandsOf(a.id)).map((c) => ({ ...c, provider: p.provider, providerLabel: p.label ?? p.provider })) : [];
      }),
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
    if (kind) (fresh[c.provider] ??= { label: c.providerLabel, commands: [] }).commands.push({ name: c.name, description: c.description ?? "", kind });
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

async function commentPrompt(intent: "evaluate" | "address", comment: string) {
  const [store, found] = await Promise.all([loadPresets(), discover()]);
  // A skill only helps if the session it's sent to has it; with no session chosen yet, ＋ New preselects its provider.
  const target = isCreating() ? undefined : listed().find((a) => a.id === selectedId)?.provider;
  const x = feedbackPreset(`feedback-${intent}`, store, found.filter((c) => !target || c.provider === target));
  const vars = pr ? { pr: `#${pr.number}`, url: prUrl(pr), prs: prLines(pr, [pr.number]), comment } : { comment };
  if (pr) newDefaults = newDefaultsFor(x, [pr.number]);
  return presetText(x, vars, comment || vars.url);
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
  if (menuFor === anchor) menuBox.replaceChildren(...nodes, ...(customize ? [link] : []));
}

function menuItem(label: string, sub: string | undefined, onPick: () => void, title = "") {
  const b = el("button", { className: "menu-item", title }, el("b", { textContent: label }), ...(sub ? [el("span", { textContent: sub })] : []));
  b.onclick = onPick;
  return b;
}

const heading = (text: string) => el("h4", { textContent: text });

// This PR, the whole stack, or the PRs ticked, bottom to top. `then` is an action waiting on the choice.
function scopeMenu(then?: () => void) {
  const current = pr!.number;
  const set = (numbers: number[]) => () => ((picked = new Set(numbers)), renderScope(), then ? then() : closeMenu());
  const boxes = stackPrs.map((s) => {
    const box = el("input", { type: "checkbox", checked: picked.has(s.number) });
    box.onchange = () => {
      if (!box.checked && scopePrs().length === 1) return void (box.checked = true);
      box.checked ? picked.add(s.number) : picked.delete(s.number);
      renderScope();
    };
    return el("label", { title: s.title }, box, el("span", { textContent: `#${s.number}${s.number === current ? " (this PR)" : ""} ${s.title}` }));
  });
  const go = el("button", { className: "primary", textContent: "Fill composer" });
  go.onclick = () => then?.();
  return [
    menuItem("This PR", `#${current}`, set([current])),
    menuItem("Whole stack", `${stackPrs.length} PRs`, set(stackNumbers())),
    el("div", { className: "scope" }, heading("Choose PRs, bottom to top"), ...boxes, ...(then ? [go] : [])),
  ];
}

scopeBtn.onclick = () => void openMenu(scopeBtn, async () => scopeMenu(), false);

// Fills the composer with a preset over its scope, and points ＋ New at the topmost PR in it.
function runPreset(x: Preset) {
  const p = pr!;
  if (x.scope === "ask" && stackNumbers().length > 1)
    return void openMenu(scopeBtn, async () => [heading(`${x.label}: which PRs?`), ...scopeMenu(() => runPreset({ ...x, scope: undefined }))], false);
  const prs = presetScope(x, stackNumbers(), picked, p.number);
  picked = new Set(prs);
  renderScope();
  const checks = checksText(prs.map((n) => ({ number: n, checks: ghPr(n)?.checks })));
  act(presetText(x, { pr: `#${p.number}`, url: prUrl(p), prs: prLines(p, prs), checks }, scopeText(p, prs)), newDefaultsFor(x, prs));
}

// Favorites, presets and commands alike, on top; then the presets; then the other commands.
function presetMenu(own: Preset[], commands: (Preset & { description?: string })[]) {
  const item = (x: Preset & { description?: string }) => menuItem(`${x.favorite ? "★ " : ""}${x.label}`, x.provider, () => runPreset(x), x.description);
  const [mine, found] = [arrange(own), arrange(commands)];
  const rest = found.filter((x) => !x.favorite);
  return [
    ...[...mine.filter((x) => x.favorite), ...found.filter((x) => x.favorite), ...mine.filter((x) => !x.favorite)].map(item),
    ...(rest.length ? [heading("Commands")] : []),
    ...rest.map(item),
  ];
}

reviewBtn.onclick = () =>
  void openMenu(reviewBtn, async () => {
    const [found, store] = await Promise.all([discover(), loadPresets()]);
    return presetMenu(
      store.presets.filter((x) => x.kind === "review"),
      found.filter(isReviewCommand).map((c) => commandPreset(c, "review", store.overrides)),
    );
  });

// One CI preset runs straight away; several get a menu.
fixCiBtn.onclick = async () => {
  const ci = arrange((await loadPresets()).presets.filter((x) => x.kind === "ci"));
  if (ci.length > 1) return void openMenu(fixCiBtn, async () => presetMenu(ci, []));
  runPreset(ci[0] ?? DEFAULT_PRESETS.find((x) => x.kind === "ci")!);
};

feedbackBtn.onclick = () =>
  void openMenu(feedbackBtn, async () => {
    const [found, store] = await Promise.all([discover(), loadPresets()]);
    return presetMenu(
      store.presets.filter((x) => x.kind.startsWith("feedback-")),
      found.filter(isFeedbackCommand).map((c) => commandPreset(c, "feedback-address", store.overrides)),
    );
  });

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
  await switchTo(nextPr, nextPr ? null : parseTicket(tab?.url), force);
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
newBtn.onclick = () => (isCreating() ? (closeNewForm(), void loadSessions()) : void openNewForm());
sendBtn.onclick = () => void send();
sessionMode.onchange = async () => {
  if (!selectedId) return;
  try {
    await daemon.setAgentMode(selectedId, sessionMode.value);
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
    await daemon.cancelAgent(selectedId);
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
openInPaseo.onclick = (e) => {
  e.preventDefault();
  if (openInPaseo.href.startsWith("paseo:")) void chrome.tabs.update({ url: openInPaseo.href });
};
const windowId = chrome.windows.getCurrent().then((w) => w.id);
const draftKey = windowId.then((id) => `draft:${id}`);
const startKey = windowId.then((id) => `start:${id}`);
// ext/review.js hands over comments and diff lines; `intent` asks to evaluate or address a comment instead of just quoting it.
async function takeDraft() {
  const key = await draftKey;
  const drafts = (await chrome.storage.session.get(key))[key];
  if (!Array.isArray(drafts) || !drafts.length) return;
  await chrome.storage.session.remove(key);
  for (const { text, intent } of drafts as { text: string; intent?: "evaluate" | "address" }[])
    fillComposer(intent ? await commentPrompt(intent, text) : text);
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
chrome.storage.session.onChanged.addListener(async (changes) => {
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

// Relabel picker options in place so the running dots stay live without touching the selection or timeline.
paseo.agents.subscribe((update) => {
  if (update.kind !== "upsert") return;
  const agent = update.agent;
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
});

const connected = () => daemon.getConnectionState().status === "connected";
chrome.tabs.onActivated.addListener(() => {
  if (connected()) void syncActiveTab();
});
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && info.url && connected()) void syncActiveTab();
});

// The browser hides the daemon's 403, so a disallowed origin looks like any other failed connect.
daemon.subscribeConnectionStatus((s) => {
  if (s.status === "connected") {
    void syncActiveTab(true).then(takeStart);
    // The daemon only sends agent updates once asked; the subscription re-subscribes after reconnects by itself.
    agentsLive ??= paseo.agents.list({ subscribe: {} }).catch(() => (agentsLive = undefined));
  }
  if (s.status === "disconnected")
    setStatus(
      `Can't reach Paseo at ${DAEMON_URL}, retrying. If Paseo is running, allow this extension: node scripts/allow-origin.mjs`,
    );
});
daemon.connect().catch(() => {});
