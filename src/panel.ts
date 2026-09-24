import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import MarkdownIt from "markdown-it";
import { diffStrings, parseUnifiedDiff, type DiffLine } from "./diff";
import { agentsOnPr, DAEMON_URL, isPrWorkspace as onPr, isRepo, parsePr, prLabel, sessionsForPr, SETTINGS, stackOf, type Pr, type StackPr, type Workspace } from "./pr";

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
const attachmentsEl = $<HTMLDivElement>("attachments");
const settingsBtn = $<HTMLButtonElement>("settings-btn");
const settingsBox = $<HTMLDivElement>("settings");

const daemon = new DaemonClient({ url: DAEMON_URL, clientId: "paseo-graphite", clientType: "browser" });
const paseo = createPaseoApi(daemon);

type TimelineEntry = Awaited<ReturnType<ReturnType<typeof paseo.agents.ref>["timeline"]["refetch"]>>["entries"][number];
type Permission = PaseoAgent["pendingPermissions"][number];
type RewindMode = "conversation" | "files" | "both";

let pr: Pr | null = null;
let tabUrl: string | undefined;
let workspaces: Workspace[] = [];
let agents: PaseoAgent[] = [];
// Sessions on other PRs in the same stack; `agents` stays the current PR's.
let stackGroups: { pr: StackPr; agents: PaseoAgent[] }[] = [];
const stackCache = new Map<string, Promise<StackPr[]>>();
let rewindMenuFor: string | null = null;
let selectedId: string | null = null;
let unsubscribeTimeline: (() => void) | null = null;
let refetchTimer: ReturnType<typeof setTimeout> | undefined;
let images: { data: string; mimeType: string }[] = [];
let prPrefill = "";
let agentsLive: Promise<unknown> | undefined;

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
  const target = pr;
  const loaded = await sessionsForPr(paseo, target);
  workspaces = loaded.workspaces;
  agents = [...loaded.agents.filter((a) => !a.archivedAt), ...loaded.agents.filter((a) => a.archivedAt)];
  stackGroups = [];
  renderPicker();
  void loadStack(target, loaded.all);
}

async function loadStack(target: Pr, all: PaseoAgent[]) {
  const cwd = workspaces.find((w) => isRepo(w, target))?.workspaceDirectory;
  if (!cwd) return;
  const key = prLabel(target);
  if (!stackCache.has(key)) stackCache.set(key, stackOf(daemon, cwd, target).catch(() => (stackCache.delete(key), [])));
  const stack = await stackCache.get(key)!;
  if (pr?.number !== target.number || pr.repo !== target.repo) return;
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
  if (!pr) return;
  const option = (a: PaseoAgent) => el("option", { value: a.id, textContent: optionLabel(a) });
  const active = agents.filter((a) => !a.archivedAt);
  const archived = agents.filter((a) => a.archivedAt);
  agentSelect.replaceChildren(
    ...(agents.length ? active.map(option) : [el("option", { value: "", textContent: `No sessions for #${pr.number}` })]),
    ...(archived.length ? [el("optgroup", { label: "Archived" }, ...archived.map(option))] : []),
    ...stackGroups.map((g) => el("optgroup", { label: `Stack · #${g.pr.number} ${g.pr.title}` }, ...g.agents.map(option))),
  );
  // A PR with no sessions of its own often has the one that built its stack.
  const keep = listed().find((a) => a.id === selectedId)?.id ?? agents[0]?.id ?? stackGroups[0]?.agents[0]?.id ?? null;
  agentSelect.value = keep ?? "";
  if (keep !== selectedId || !unsubscribeTimeline) selectAgent(keep);
}

function selectAgent(id: string | null) {
  if (id === selectedId && unsubscribeTimeline) return;
  unsubscribeTimeline?.();
  unsubscribeTimeline = null;
  selectedId = id;
  rewindMenuFor = null;
  sessionMode.hidden = true;
  document.body.classList.remove("busy");
  document.body.classList.toggle("archived", !!listed().find((a) => a.id === id)?.archivedAt);
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
  const permissions = agent?.pendingPermissions ?? [];
  const blocked = permissions.length > 0;
  const busy = agent?.status === "running" || agent?.status === "initializing";
  document.body.classList.toggle("busy", busy);
  const rewindModes: RewindMode[] = busy || !agent ? [] : (["conversation", "files", "both"] as const).filter((m) => agent.capabilities?.[capability[m]]);
  timeline.replaceChildren(
    ...page.entries.map((e) => renderEntry(e, id, rewindModes)).filter((n): n is HTMLElement => !!n),
    ...permissions.map((p) => permissionCard(id, p)),
    ...(busy && !blocked ? [working("Working")] : []),
  );
  if (pinned) timeline.scrollTop = timeline.scrollHeight;
  // Don't rebuild the picker under the user's cursor.
  if (agent && document.activeElement !== sessionMode) {
    sessionMode.replaceChildren(...agent.availableModes.map((m) => el("option", { value: m.id, textContent: m.label, title: m.description ?? "" })));
    sessionMode.value = agent.currentModeId ?? "";
    sessionMode.hidden = !agent.availableModes.length;
  }
  if (agent) {
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

function permissionCard(agentId: string, p: Permission) {
  const detail = p.detail && "command" in p.detail ? String(p.detail.command) : p.input ? JSON.stringify(p.input, null, 2) : "";
  const card = el(
    "div",
    { className: "permission" },
    el("b", { textContent: p.title ?? p.name }),
    ...(p.description ? [el("div", { textContent: p.description })] : []),
    ...(detail ? [el("pre", { textContent: detail.slice(0, 4000) })] : []),
  );
  const respond = async (response: Parameters<typeof daemon.respondToPermission>[2]) => {
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await daemon.respondToPermission(agentId, p.id, response);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    void renderTimeline();
  };
  const row = el("div", { className: "row" });
  // ponytail: questions need typed answers; send those to Paseo rather than rebuilding its question form.
  if (p.kind === "question") {
    const open = el("button", { textContent: "Answer in Paseo" });
    open.onclick = () => openInPaseo.click();
    row.append(open);
  } else {
    const actions = p.actions?.length
      ? p.actions
      : [
          { id: "", label: "Allow", behavior: "allow" as const, variant: "primary" as const },
          { id: "", label: "Deny", behavior: "deny" as const, variant: "danger" as const },
        ];
    for (const a of actions) {
      const btn = el("button", { textContent: a.label, className: a.variant ?? "" });
      btn.onclick = () =>
        void respond(
          a.behavior === "allow"
            ? { behavior: "allow", ...(a.id ? { selectedActionId: a.id } : {}) }
            : { behavior: "deny", ...(a.id ? { selectedActionId: a.id } : {}), message: "Denied from the Graphite panel" },
        );
      row.append(btn);
    }
  }
  card.append(row);
  return card;
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
  if (pr && !prompt.value.trim()) {
    prompt.value = prPrefill = `PR #${pr.number}: https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}\n\n`;
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  }

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
  const preferred = models.find((m) => m.isDefault && m.key.startsWith("claude/")) ?? models[0];
  if (preferred) modelSelect.value = preferred.key;
  fillEfforts();
  fillModes();
}

function closeNewForm() {
  document.body.classList.remove("creating");
  newBtn.textContent = "＋ New";
  prompt.placeholder = "Message this session (⇧↩ for a new line)";
  if (prPrefill && prompt.value === prPrefill) prompt.value = "";
  prPrefill = "";
}

async function createSession(text: string, imgs: typeof images) {
  if (!pr) throw new Error("Open a Graphite PR first");
  const config = {
    provider: modelSelect.value,
    ...(effortSelect.value ? { thinkingOptionId: effortSelect.value } : {}),
    ...(modeSelect.value && !modeSelect.hidden ? { modeId: modeSelect.value } : {}),
  };
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
  const agent = await workspace.agents.create({ config, prompt: text, labels, ...(imgs.length ? { images: imgs } : {}) });
  closeNewForm();
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
let suggestIndex = 0;

// Paseo returns nothing before a session exists, so a new session's first message gets no suggestions.
async function updateSuggestions() {
  const query = prompt.value.match(/^\/(\S*)$/)?.[1];
  const id = selectedId;
  if (query === undefined || !id || isCreating()) return closeSuggestions();
  if (!commandCache.has(id)) commandCache.set(id, daemon.listCommands(id).then((r) => r.commands, () => []));
  const commands = await commandCache.get(id)!;
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

async function syncActiveTab(force = false) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Opening the panel counts as looking at the tab.
  if (tab?.id !== undefined) void chrome.tabs.sendMessage(tab.id, { type: "unmark" }).catch(() => {});
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
const draftKey = chrome.windows.getCurrent().then((w) => `draft:${w.id}`);
async function takeDraft() {
  const key = await draftKey;
  const draft = (await chrome.storage.session.get(key))[key];
  if (typeof draft !== "string" || !draft) return;
  await chrome.storage.session.remove(key);
  prompt.value = prompt.value.trim() ? `${prompt.value.trimEnd()}\n\n${draft}` : draft;
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
}
chrome.storage.session.onChanged.addListener(async (changes) => {
  if (changes[await draftKey]?.newValue) void takeDraft();
});
void takeDraft();
settingsBtn.onclick = () => (settingsBox.hidden = !settingsBox.hidden);
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
  for (const list of [agents, ...stackGroups.map((g) => g.agents)]) {
    const i = list.findIndex((a) => a.id === agent.id);
    if (i >= 0) list[i] = agent;
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
    void syncActiveTab(true);
    // The daemon only sends agent updates once asked; the subscription re-subscribes after reconnects by itself.
    agentsLive ??= paseo.agents.list({ subscribe: {} }).catch(() => (agentsLive = undefined));
  }
  if (s.status === "disconnected")
    setStatus(
      `Can't reach Paseo at ${DAEMON_URL}, retrying. If Paseo is running, allow this extension: node scripts/allow-origin.mjs`,
    );
});
daemon.connect().catch(() => {});
