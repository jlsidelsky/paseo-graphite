// The panel's Inbox view (active tab is a Graphite inbox or GitHub PR list): the page's PRs by section, each with its sessions,
// plus the inbox settings form shared with the options page. Only type imports, so scripts/inbox.check.ts can load it in Node.
import type { PaseoAgent as Agent } from "@getpaseo/client";
import type { Pr, RowStack } from "./pr";

// `href` and `sub` as the page sent them, for the background's stack lookup.
export type InboxRow = { pr: Pr; title: string; section: string; sectionIndex: number; href?: string; sub?: string };
type Status = "needs" | "running" | "idle" | "archived";
export type InboxSettings = { hidden: string[]; order: string[]; sort: "page" | "urgency"; onlyWithSessions: boolean; groupStacks: boolean; show: Record<Status, boolean> };
// A stack's shown members sit together, bottom to top, where its first one would be; `pos` counts from the bottom.
export type InboxGroup = { section: string; prs: { row: InboxRow; sessions: Agent[]; stack?: { key: string; pos: number; size: number } }[] };

// chrome.storage.sync key `inbox`.
export const INBOX_DEFAULTS: InboxSettings = {
  hidden: [],
  order: [],
  sort: "page",
  onlyWithSessions: false,
  groupStacks: true,
  show: { needs: true, running: true, idle: true, archived: false },
};

export async function loadInboxSettings(): Promise<InboxSettings> {
  const saved = (await chrome.storage.sync.get("inbox")).inbox as Partial<InboxSettings> | undefined;
  return { ...INBOX_DEFAULTS, ...saved, show: { ...INBOX_DEFAULTS.show, ...saved?.show } };
}
const save = (s: InboxSettings) => void chrome.storage.sync.set({ inbox: s });

const statusOf = (a: Agent): Status =>
  a.archivedAt ? "archived" : a.pendingPermissions?.length ? "needs" : a.status === "running" || a.status === "initializing" ? "running" : "idle";
const RANK: Record<Status, number> = { needs: 0, running: 1, idle: 2, archived: 3 };
const STATUS_LABELS: Record<Status, string> = { needs: "Needs you", running: "Running", idle: "Idle", archived: "Archived" };

// Section names in page order.
export const pageSections = (rows: InboxRow[]) => [...new Set([...rows].sort((a, b) => a.sectionIndex - b.sectionIndex).map((r) => r.section))];

// The user's order first, then sections they haven't placed (new ones) in page order.
export function orderSections(names: string[], s: InboxSettings) {
  const at = (n: string) => (s.order.includes(n) ? s.order.indexOf(n) : s.order.length + names.indexOf(n));
  return [...names].sort((a, b) => at(a) - at(b));
}

// The search field: every word of `q` somewhere in `fields`, case-insensitive, so "123", "#123" and "#123 fix" all find PR #123 "Fix…".
export function matches(q: string, fields: (string | null | undefined)[]) {
  const hay = fields.filter(Boolean).join("\n").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}
// A PR that matches keeps all its sessions; otherwise only the sessions that match (with the PR's fields) keep it listed.
export type InboxFind = { q: string; fields: (a: Agent) => (string | null | undefined)[] };

// `sessionsOf` gives a PR's sessions newest first (agentsOnPr); `stacks` index into `rows` (groupStacks).
export function groupInbox(rows: InboxRow[], sessionsOf: (pr: Pr) => Agent[], s: InboxSettings, stacks: RowStack[] = [], find?: InboxFind): InboxGroup[] {
  const inStack = new Map(s.groupStacks ? stacks.flatMap((st) => st.rows.map((i, order) => [rows[i], { key: st.key, order }] as const)) : []);
  const gather = (prs: InboxGroup["prs"]) => {
    const done = new Set<string>();
    return prs.flatMap((p) => {
      const key = inStack.get(p.row)?.key;
      if (!key) return [p];
      if (done.has(key)) return [];
      done.add(key);
      const members = prs.filter((x) => inStack.get(x.row)?.key === key).sort((a, b) => inStack.get(a.row)!.order - inStack.get(b.row)!.order);
      return members.length < 2 ? members : members.map((x, pos) => ({ ...x, stack: { key, pos, size: members.length } }));
    });
  };
  const rank = (p: InboxGroup["prs"][number]) => (p.sessions.length ? RANK[statusOf(p.sessions[0])] : 4);
  return orderSections(pageSections(rows), s)
    .filter((section) => !s.hidden.includes(section))
    .map((section) => {
      const prs = rows
        .filter((r) => r.section === section)
        .map((row) => ({ row, sessions: sessionsOf(row.pr).filter((a) => s.show[statusOf(a)]).sort((a, b) => RANK[statusOf(a)] - RANK[statusOf(b)]) }))
        .filter((p) => !s.onlyWithSessions || p.sessions.length)
        .flatMap((p) => {
          const own = [`#${p.row.pr.number}`, p.row.title];
          if (!find?.q.trim() || matches(find.q, own)) return [p];
          const sessions = p.sessions.filter((a) => matches(find.q, [...own, ...find.fields(a)]));
          return sessions.length ? [{ ...p, sessions }] : [];
        });
      // Needs you, then running, then most recently active; PRs without sessions keep the page's order at the end.
      if (s.sort === "urgency") prs.sort((a, b) => rank(a) - rank(b) || (b.sessions[0]?.updatedAt ?? "").localeCompare(a.sessions[0]?.updatedAt ?? ""));
      return { section, prs: gather(prs) };
    })
    .filter((g) => g.prs.length);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Fills `box` with the inbox settings; `sections` in display order. Rebuilt in place on reorder, keeping focus on the moved control.
export function fillSettings(box: HTMLElement, sections: string[], s: InboxSettings) {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.k : undefined;
  const keyed = <T extends HTMLElement>(node: T, k: string) => ((node.dataset.k = k), node);
  const check = (k: string, label: string, checked: boolean, set: (v: boolean) => void) => {
    const input = keyed(el("input", { type: "checkbox", checked }), k);
    input.onchange = () => (set(input.checked), save(s));
    return el("label", {}, input, label);
  };
  const move = (i: number, d: number) => {
    const order = [...sections];
    [order[i], order[i + d]] = [order[i + d], order[i]];
    s.order = order;
    save(s);
    fillSettings(box, order, s);
  };
  const arrow = (i: number, d: number) => {
    const b = keyed(el("button", { type: "button", textContent: d < 0 ? "↑" : "↓", disabled: !sections[i + d], ariaLabel: `Move ${sections[i]} ${d < 0 ? "up" : "down"}` }), `${d}:${sections[i]}`);
    b.onclick = () => move(i, d);
    return b;
  };
  const sort = keyed(el("select", {}, el("option", { value: "page", textContent: "Graphite's order" }), el("option", { value: "urgency", textContent: "Needs you, running, recent" })), "sort");
  sort.value = s.sort;
  sort.onchange = () => ((s.sort = sort.value === "urgency" ? "urgency" : "page"), save(s));
  box.replaceChildren(
    el("b", { textContent: "Sections" }),
    ...(sections.length
      ? sections.map((n, i) =>
          el("div", { className: "inbox-section-row" }, check(`show:${n}`, n, !s.hidden.includes(n), (v) => (s.hidden = v ? s.hidden.filter((h) => h !== n) : [...s.hidden, n])), arrow(i, -1), arrow(i, 1)),
        )
      : [el("small", { textContent: "Open the Graphite inbox with the side panel once to list its sections here." })]),
    el("label", {}, "Sort PRs ", sort),
    check("only", "Only PRs with sessions", s.onlyWithSessions, (v) => (s.onlyWithSessions = v)),
    check("stacks", "Group stacks in the inbox", s.groupStacks, (v) => (s.groupStacks = v)),
    el("b", { textContent: "Show sessions that are" }),
    el("div", { className: "inbox-statuses" }, ...(Object.keys(STATUS_LABELS) as Status[]).map((st) => check(`st:${st}`, STATUS_LABELS[st], s.show[st], (v) => (s.show[st] = v)))),
  );
  // A section moved to the end has its arrow disabled; focus the other one.
  const target = focused ? box.querySelector<HTMLButtonElement>(`[data-k="${CSS.escape(focused)}"]`) : null;
  (target?.disabled ? target.parentElement?.querySelector<HTMLElement>("button:not(:disabled)") : target)?.focus();
}

const CSS_TEXT = `
.inbox-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; }
.inbox details { font-size: 12px; }
.inbox summary { cursor: pointer; color: var(--muted); list-style: none; }
.inbox details[open] { flex-basis: 100%; }
.inbox-settings, .inbox-options { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; margin: 4px 0; background: var(--card); border: 1px solid var(--border); border-radius: 8px; }
.inbox-settings label, .inbox-options label { display: flex; align-items: center; gap: 6px; }
.inbox-section-row { display: flex; align-items: center; gap: 4px; }
.inbox-section-row label { flex: 1; min-width: 0; }
.inbox-section-row button { padding: 0 6px; }
.inbox-statuses { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.inbox-pr { border: 0; background: none; padding: 4px 0 0; text-align: left; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inbox-pr:hover { color: var(--accent); }
.inbox .session-row { margin-left: 10px; }
.inbox-stack { display: block; width: 100%; border: 0; background: none; padding: 4px 0 0; text-align: left; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inbox-stack span { color: var(--muted); font-weight: 400; }
.inbox-stack-members { border-left: 2px solid var(--accent); padding-left: 8px; margin: 2px 0 0 3px; }
.inbox .none { color: var(--muted); font-size: 12px; margin-left: 10px; }
.session-row .dot-needs { color: var(--accent); } .session-row .dot-running { color: #2da44e; }
`;
let styled = false;
export function inboxStyles() {
  if (!styled) (styled = true), document.head.append(el("style", { textContent: CSS_TEXT }));
}

// Kept across re-renders so the settings stay open, and only rebuilt when they or the sections change.
let settings: { details: HTMLDetailsElement; box: HTMLDivElement; key: string } | undefined;

export function renderInbox(
  rows: InboxRow[],
  sessionsOf: (pr: Pr) => Agent[],
  s: InboxSettings,
  on: { pick: (a: Agent) => void; open: (pr: Pr) => void; toggle: (stack: string, open: boolean) => void },
  stacks: RowStack[] = [],
  expanded = new Set<string>(),
  find?: InboxFind,
) {
  inboxStyles();
  if (!settings) {
    const box = el("div", { className: "inbox-settings" });
    settings = { details: el("details", {}, el("summary", { textContent: "⚙ Customize", title: "Inbox settings" }), box), box, key: "" };
  }
  const sections = orderSections(pageSections(rows), s);
  const key = JSON.stringify([sections, s]);
  if (key !== settings.key) (settings.key = key), fillSettings(settings.box, sections, s);
  const session = (a: Agent) => {
    const st = statusOf(a);
    const btn = el(
      "button",
      { className: "session-row" },
      el("b", {}, el("span", { className: `dot-${st}`, textContent: st === "idle" ? "○ " : st === "archived" ? "▫ " : "● " }), a.title ?? a.id.slice(0, 8)),
      el("span", { textContent: st === "needs" ? "needs you" : st === "archived" ? "archived" : a.status }),
    );
    btn.onclick = () => on.pick(a);
    return btn;
  };
  const prNodes = ({ row, sessions }: InboxGroup["prs"][number]) => {
    const pr = el("button", { className: "inbox-pr", textContent: `#${row.pr.number} ${row.title}`, title: `Show ${row.pr.owner}/${row.pr.repo} #${row.pr.number} here, pinned` });
    pr.onclick = () => on.open(row.pr);
    return [pr, ...(sessions.length ? sessions.map(session) : [el("div", { className: "none", textContent: "No sessions" })])];
  };
  const groups = groupInbox(rows, sessionsOf, s, stacks, find);
  const nodes = groups.flatMap((g) => [
    el("h4", { textContent: `${g.section} · ${g.prs.length}` }),
    ...g.prs.flatMap((p) => {
      if (!p.stack) return prNodes(p);
      if (p.stack.pos) return [];
      const { key, size } = p.stack;
      const members = g.prs.filter((x) => x.stack?.key === key);
      const top = members[size - 1].row;
      const open = expanded.has(key);
      const head = el("button", { className: "inbox-stack", title: open ? "Collapse this stack" : "Expand this stack" }, `${open ? "▾" : "▸"} Stack · ${size} PRs `, el("span", { textContent: `#${top.pr.number} ${top.title}` }));
      head.setAttribute("aria-expanded", String(open));
      head.onclick = () => on.toggle(key, !open);
      return open ? [head, el("div", { className: "inbox-stack-members" }, ...members.flatMap(prNodes))] : [head];
    }),
  ]);
  return el(
    "div",
    { className: "overview inbox" },
    el("div", { className: "inbox-head" }, el("h4", { textContent: "Inbox" }), settings.details),
    ...(nodes.length ? nodes : [el("div", { className: "empty", textContent: `No inbox PRs match ${find?.q.trim() ? "this search" : "these settings"}.` })]),
  );
}
