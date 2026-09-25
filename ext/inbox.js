// A status pill on each PR row with Paseo sessions, on Graphite's inbox and GitHub's PR lists; also answers the panel's
// "inbox-rows" with the visible rows. The background parses rows (rowPr in src/pr.ts) and answers or pushes per-row states.
// On Graphite, PRs in one stack within a section fold into their first row (see "Stacks" below).

// ---- Graphite inbox (app.graphite.com/, or wherever the same blocks show up) ----
// Each section has a header with a searchbox named "Search <Section name>" (section names are user-set), followed by a <table>
// with one <tr> per PR when it's expanded and not empty. The title cell holds an <a> with the title, linking to
// /github/pr/<Owner>/<repo>/<n>/<slug>, and under it a line "author · owner/repo #n", which may go on with "1 label" and a
// stack-position button like "1/4". Class names are generated, so only roles, labels and tags are used. The pill goes at the
// start of that subtitle line, so truncated titles and the narrow (560px) layout keep working. Rows are React's: we only add
// attributes and children to them, and our own <tr>s between them (never move or remove theirs).
const SECTION = 'input[aria-label^="Search "], [role="searchbox"][aria-label^="Search "], input[placeholder^="Search "]';

function graphiteRows() {
  const rows = [];
  let section = null;
  let sectionIndex = -1;
  for (const node of document.querySelectorAll(`${SECTION}, table`)) {
    if (node.tagName !== "TABLE") {
      section = (node.getAttribute("aria-label") || node.getAttribute("placeholder")).slice(7).trim();
      sectionIndex++;
      continue;
    }
    if (!section) continue;
    for (const tr of node.querySelectorAll("tr:not([data-paseo-stack-row])")) {
      const link = [...tr.querySelectorAll("a[href]")].find((a) => a.textContent.trim());
      const cell = link?.closest("td, th");
      if (!cell) continue;
      // The subtitle line: the topmost element holding the first text after the title that doesn't also hold the title.
      const first = texts(cell, link)[0];
      let line = first?.parentElement;
      while (line && line !== cell && !line.parentElement.contains(link)) line = line.parentElement;
      const sub = texts(cell, link).map((t) => t.data).join(" ");
      const place = (pill) => (line && line !== cell ? line.prepend(pill) : link.after(pill));
      rows.push({ tr, href: link.href, title: link.textContent.trim(), sub, section, sectionIndex, place });
    }
  }
  return rows;
}

// ---- GitHub PR lists (github.com/<owner>/<repo>/pulls, github.com/pulls) ----
// Each row's title is an <a> to /<owner>/<repo>/pull/<n>, marked as a PR hovercard. The pill goes right after it.
// ponytail: not checked against GitHub's newer React list; add its title selector here if rows go missing.
function githubRows() {
  if (!/^\/(?:[^/]+\/[^/]+\/)?pulls\/?$/.test(location.pathname)) return [];
  return [...document.querySelectorAll('a[data-hovercard-type="pull_request"], a[id^="issue_"][id$="_link"]')]
    .filter((a) => /\/pull\/\d+$/.test(a.pathname) && a.textContent.trim())
    .map((a) => ({ tr: a.parentElement, href: a.href, title: a.textContent.trim(), sub: "", section: "Pull requests", sectionIndex: 0, place: (pill) => a.after(pill) }));
}

// Text nodes in the cell outside the title link and our own pill.
function texts(cell, link) {
  const out = [];
  const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const t = walk.currentNode;
    if (t.data.trim() && !link.contains(t) && !t.parentElement.closest("[data-paseo-pill], [data-paseo-stack-toggle]")) out.push(t);
  }
  return out;
}

// A PR page is never an inbox, whatever tables it has.
const scan = () => (location.hostname === "github.com" ? githubRows() : /\/(pr|pull)\//.test(location.pathname) ? [] : graphiteRows());

let rows = [];
let sent = "[]";
let seq = Math.floor(Math.random() * 1e9);
// Session states by row, from the rows last sent, so a rescan that React reordered still paints the right rows.
let sentKeys = [];
let stateBy = new Map();
const wire = (r) => ({ href: r.href, sub: r.sub, title: r.title, section: r.section, sectionIndex: r.sectionIndex });
const rowKey = (r) => `${r.section}\n${r.href}`;
const setStates = (list) => (stateBy = new Map(sentKeys.map((k, i) => [k, list?.[i]])));

const STYLE = "all:initial;display:inline-block;flex:none;vertical-align:middle;box-sizing:border-box;margin:0 6px 0 0;padding:0 7px;" +
  "border-radius:999px;font:600 11px/17px system-ui,sans-serif;white-space:nowrap;cursor:pointer;";

const live = new WeakSet();

// Keep Graphite's row (and its keyboard handling) from seeing presses on our controls; `click` is what they do.
function guard(button, click) {
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "keydown", "keyup"])
    button.addEventListener(type, (e) => {
      if (e.type.startsWith("key") && e.key !== "Enter" && e.key !== " ") return;
      e.stopPropagation();
      if (e.type === "click") (e.preventDefault(), click());
    });
  live.add(button);
  return button;
}

// The pill in `host` (a row), made, updated or removed for state `s`.
function syncPill(host, s, place) {
  let pill = host.querySelector("[data-paseo-pill]");
  // A copy the page made of our markup has no listeners.
  if (pill && !live.has(pill)) pill = void pill.remove();
  if (!s) return pill?.remove();
  const needs = s.needsYou > 0;
  const text = needs ? "needs you" : s.running ? `● ${s.running > 1 ? `${s.running} ` : ""}running` : `${s.count} session${s.count === 1 ? "" : "s"}`;
  const look = needs ? "background:#d97757;color:#fff;" : s.running ? "background:rgba(45,164,78,.16);color:#2da44e;" : "background:rgba(128,128,128,.18);color:inherit;opacity:.8;";
  if (!pill) {
    pill = guard(Object.assign(document.createElement("button"), { type: "button" }), () => chrome.runtime.sendMessage({ type: "open-pr", url: pill.dataset.url }));
    pill.dataset.paseoPill = "";
    place(pill);
  }
  pill.dataset.url = s.url;
  if (pill.textContent !== text) pill.textContent = text;
  const label = `Paseo: ${s.count} session${s.count === 1 ? "" : "s"}${needs ? ", needs you" : s.running ? `, ${s.running} running` : ""}. Open in the side panel`;
  if (pill.getAttribute("aria-label") !== label) pill.setAttribute("aria-label", label);
  if (pill.dataset.look !== look) (pill.dataset.look = look), (pill.style.cssText = STYLE + look);
}

const paint = () => rows.forEach((r) => syncPill(r.tr, stateBy.get(rowKey(r)), r.place));

// ---- Stacks (Graphite only) ----
// The background finds stacks among the rows (inbox-stacks: branches from GitHub, grouped per section by groupStacks in
// src/pr.ts). A stack folds into its first row in the page's order, so the group ranks where Graphite's sort puts its best
// member. That row gets a "▸ Stack · N" toggle; the other members' rows are hidden by attribute and a stylesheet, so React
// keeps owning them. Expanded, our own rows follow it, listing the whole stack bottom to top. Expanded stacks are kept in
// chrome.storage.local `stacks` (shared with the panel); "Group stacks in the inbox" (sync `inbox.groupStacks`) turns it off.
let grouping = false;
let expanded = new Set();
let stacks = []; // { key, members: rowKey[] bottom to top }
let stacksSent = "";
let stackSeq = 0;
const ACCENT = "rgba(139,124,246,.85)";
const CSS = `tr[data-paseo-stack="hidden"] { display: none !important; }
tr[data-paseo-stack="anchor"] > :first-child, tr[data-paseo-stack-row] > td { box-shadow: inset 3px 0 0 ${ACCENT}; }
tr[data-paseo-stack-row] > td { background: rgba(139,124,246,.07); }`;

function toggleStack(key) {
  const open = !expanded.has(key);
  open ? expanded.add(key) : expanded.delete(key);
  paintStacks();
  void chrome.storage.local.get("stacks").then(({ stacks: saved }) => {
    const next = { ...saved };
    if (open) next[key] = true;
    else delete next[key];
    return chrome.storage.local.set({ stacks: next });
  });
}

function stackRow(key, r, pos, size) {
  const tr = document.createElement("tr");
  tr.dataset.paseoStackRow = key;
  tr.dataset.href = r.href;
  // Not a React row, but its handlers up the tree could still see our clicks.
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) tr.addEventListener(type, (e) => e.stopPropagation());
  const td = document.createElement("td");
  td.style.cssText = "padding:3px 12px 3px 28px;border:0;";
  const line = document.createElement("div");
  line.style.cssText = "all:initial;display:flex;align-items:center;gap:8px;min-width:0;font:inherit;font-size:13px;line-height:20px;color:inherit;";
  const text = (t, css) => Object.assign(document.createElement("span"), { textContent: t, style: `all:initial;flex:none;font:inherit;color:inherit;${css}` });
  const link = Object.assign(document.createElement("a"), { href: r.href, textContent: r.title, title: r.title });
  link.style.cssText = "all:initial;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;font-weight:500;color:inherit;cursor:pointer;";
  const pillSlot = text("", "display:contents;");
  line.append(text(`${pos}/${size}`, "opacity:.55;font-variant-numeric:tabular-nums;min-width:2.2em;"), link, text(`#${r.sub.match(/#(\d+)/)?.[1] ?? ""}`, "opacity:.55;"), pillSlot);
  td.append(line);
  tr.append(td);
  tr.pillSlot = pillSlot;
  return tr;
}

function paintStacks() {
  const mine = new Set();
  if (grouping) {
    if (!document.querySelector("style[data-paseo-stacks]")) {
      const style = Object.assign(document.createElement("style"), { textContent: CSS });
      style.dataset.paseoStacks = "";
      document.head.append(style);
    }
    const byKey = new Map(rows.map((r) => [rowKey(r), r]));
    for (const { key, members: keys } of stacks) {
      const members = keys.map((k) => byKey.get(k)).filter(Boolean);
      if (members.length < 2) continue;
      const anchor = members.reduce((a, b) => (b.tr.compareDocumentPosition(a.tr) & Node.DOCUMENT_POSITION_FOLLOWING ? b : a));
      const open = expanded.has(key);
      for (const m of members) {
        const want = m === anchor ? "anchor" : "hidden";
        if (m.tr.dataset.paseoStack !== want) m.tr.dataset.paseoStack = want;
        mine.add(m.tr);
      }
      let toggle = anchor.tr.querySelector("[data-paseo-stack-toggle]");
      if (toggle && !live.has(toggle)) toggle = void toggle.remove();
      if (!toggle) {
        toggle = guard(Object.assign(document.createElement("button"), { type: "button" }), () => toggleStack(toggle.dataset.paseoStackToggle));
        toggle.style.cssText = STYLE + `background:rgba(139,124,246,.18);color:inherit;`;
        const pill = anchor.tr.querySelector("[data-paseo-pill]");
        pill ? pill.after(toggle) : anchor.place(toggle);
      }
      const text = `${open ? "▾" : "▸"} Stack · ${members.length}`;
      if (toggle.textContent !== text) toggle.textContent = text;
      toggle.dataset.paseoStackToggle = key;
      if (toggle.getAttribute("aria-expanded") !== String(open)) toggle.setAttribute("aria-expanded", String(open));
      const label = `${open ? "Collapse" : "Expand"} this stack of ${members.length} PRs`;
      if (toggle.getAttribute("aria-label") !== label) toggle.setAttribute("aria-label", label);
      mine.add(toggle);
      if (!open) continue;
      // Ours, right after the anchor, one per member; rebuilt whenever React moved or dropped any of them.
      let ours = [];
      for (let n = anchor.tr.nextElementSibling; n?.dataset.paseoStackRow === key; n = n.nextElementSibling) ours.push(n);
      if (ours.length !== members.length || ours.some((n, i) => n.dataset.href !== members[i].href || !n.pillSlot)) {
        ours.forEach((n) => n.remove());
        ours = members.map((m, i) => stackRow(key, m, i + 1, members.length));
        anchor.tr.after(...ours);
      }
      // Only the columns showing: a span over columns Graphite hid at this width adds empty ones and squeezes the table.
      const span = [...anchor.tr.cells].reduce((n, c) => n + (getComputedStyle(c).display === "none" ? 0 : c.colSpan), 0);
      ours.forEach((n, i) => {
        if (n.cells[0].colSpan !== span) n.cells[0].colSpan = span;
        syncPill(n, stateBy.get(rowKey(members[i])), (pill) => n.pillSlot.append(pill));
        mine.add(n);
      });
    }
  }
  // Whatever isn't a current stack's: restore React's rows, drop our rows and toggles.
  for (const n of document.querySelectorAll("tr[data-paseo-stack], tr[data-paseo-stack-row], [data-paseo-stack-toggle]"))
    if (!mine.has(n)) n.dataset.paseoStackRow !== undefined || n.dataset.paseoStackToggle !== undefined ? n.remove() : delete n.dataset.paseoStack;
}

async function loadStacks() {
  const graphite = location.hostname !== "github.com";
  const next = grouping && graphite ? JSON.stringify(rows.map(wire)) : "";
  if (next === stacksSent) return;
  stacksSent = next;
  const mine = ++stackSeq;
  if (!next) return (stacks = []), paintStacks();
  const sentRows = rows;
  const res = await chrome.runtime.sendMessage({ type: "inbox-stacks", rows: sentRows.map(wire) }).catch(() => null);
  if (mine !== stackSeq) return;
  // No answer (Paseo not reachable yet): keep what we had, and ask again on the next rescan.
  if (!Array.isArray(res?.stacks)) return void (stacksSent = "");
  stacks = res.stacks.map((st) => ({ key: st.key, members: st.rows.map((i) => rowKey(sentRows[i])) }));
  paintStacks();
}

// Rescan and repaint from what we already know; cheap enough to run on every React row change.
function refresh() {
  rows = scan();
  paint();
  paintStacks();
}

async function update() {
  refresh();
  const next = JSON.stringify(rows.map(wire));
  if (next !== sent) {
    sent = next;
    sentKeys = rows.map(rowKey);
    setStates([]);
    const mine = ++seq;
    const res = await chrome.runtime.sendMessage({ type: "inbox-rows", seq: mine, rows: rows.map(wire) }).catch(() => null);
    if (res?.seq === seq) setStates(res.states);
    paint();
    paintStacks();
  }
  void loadStacks();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "inbox-sessions" && msg.seq === seq) setStates(msg.states), paint(), paintStacks();
  // The panel asks for the rows when this tab becomes the active one. No rows: not an inbox, and it shows all sessions instead.
  if (msg.type === "inbox-rows") reply({ rows: scan().map(wire) });
});

addEventListener("resize", () => stacks.length && paintStacks());
const setGrouping = (inbox) => (grouping = inbox?.groupStacks !== false);
const setExpanded = (saved) => (expanded = new Set(Object.keys(saved ?? {})));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.inbox) setGrouping(changes.inbox.newValue), paintStacks(), void loadStacks();
  if (area === "local" && changes.stacks) setExpanded(changes.stacks.newValue), paintStacks();
});

// React re-renders rows on sort, filter and updates; rescan at most twice a second. Painting is idempotent, so the mutations
// it causes settle after one extra pass. New React rows (or our rows dropped) repaint at once, so hidden rows don't flash.
const rowish = (n) => n.nodeType === 1 && (n.nodeName === "TR" || n.querySelector("tr"));
let timer = 0;
new MutationObserver((records) => {
  if (stacks.length && records.some((r) => [...r.addedNodes].some((n) => rowish(n) && n.dataset.paseoStackRow === undefined) || [...r.removedNodes].some((n) => n.dataset?.paseoStackRow !== undefined)))
    refresh();
  timer ||= setTimeout(() => ((timer = 0), void update()), 500);
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
void Promise.all([chrome.storage.sync.get("inbox"), chrome.storage.local.get("stacks")]).then(([{ inbox }, { stacks: saved }]) => {
  setGrouping(inbox);
  setExpanded(saved);
  void update();
});
