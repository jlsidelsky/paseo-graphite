// A status pill on each PR row with Paseo sessions, on Graphite's inbox and GitHub's PR lists; also answers the panel's
// "inbox-rows" with the visible rows. The background parses rows (rowPr in src/pr.ts) and answers or pushes per-row states.
// On Graphite, PRs in one stack within a section group under a header row (see "Stacks" below).

// ---- Graphite inbox (app.graphite.com/, or wherever the same blocks show up) ----
// Each section has a header with a searchbox named "Search <Section name>" (section names are user-set), followed by a <table>
// with one <tr> per PR when it's expanded and not empty. The title cell holds an <a> with the title, linking to
// /github/pr/<Owner>/<repo>/<n>/<slug>, and under it a line "author · owner/repo #n", which may go on with "1 label" and a
// stack-position button like "1/4". Class names are generated, so only roles, labels and tags are used. The pill goes at the
// start of that subtitle line, so truncated titles and the narrow (560px) layout keep working. Rows are React's: we only add
// attributes and children to them, our own header <tr>s between them, and reorder them within their <tbody> (never remove them).
const SECTION = 'input[aria-label^="Search "], [role="searchbox"][aria-label^="Search "], input[placeholder^="Search "]';

function graphiteRows() {
  const rows = [];
  let section = null;
  let search = "";
  let sectionIndex = -1;
  for (const node of document.querySelectorAll(`${SECTION}, table`)) {
    if (node.tagName !== "TABLE") {
      section = (node.getAttribute("aria-label") || node.getAttribute("placeholder")).slice(7).trim();
      search = node.value?.trim() ?? "";
      sectionIndex++;
      continue;
    }
    if (!section) continue;
    for (const tr of node.querySelectorAll("tr:not([data-paseo-stack-head])")) {
      const link = [...tr.querySelectorAll("a[href]")].find((a) => a.textContent.trim());
      const cell = link?.closest("td, th");
      if (!cell) continue;
      // The subtitle line: the topmost element holding the first text after the title that doesn't also hold the title.
      const first = texts(cell, link)[0];
      let line = first?.parentElement;
      while (line && line !== cell && !line.parentElement.contains(link)) line = line.parentElement;
      const sub = texts(cell, link).map((t) => t.data).join(" ");
      const place = (pill) => (line && line !== cell ? line.prepend(pill) : link.after(pill));
      rows.push({ tr, href: link.href, title: link.textContent.trim(), sub, section, sectionIndex, search, place });
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
    if (t.data.trim() && !link.contains(t) && !t.parentElement.closest("[data-paseo-pill]")) out.push(t);
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
// Graphite's section API gives each PR `stack: { stackId, position, height }`, which the rows don't show. The app fetches it
// from a worker we can't see into, so we ask for each shown section again (same origin, the user's cookies), with its sort,
// search and at least as many rows as it shows. Within a section (one <tbody>), a stack with 2+ rows gets our header row
// where its first row was: chevron, color, the top PR's title and "N PRs · stack of H". Graphite's own rows follow it, top
// of the stack first, hidden (by attribute and a stylesheet) while it's collapsed. Collapsed by default; expanded stacks
// are kept in chrome.storage.local `stacks` by stackId (the panel keeps its own keys there); "Group stacks in the inbox" (sync `inbox.groupStacks`)
// turns it off.
let grouping = false;
let expanded = new Set();
const stackOf = new Map(); // "owner/repo#n" -> { stackId, position, height, title }
const COLORS = ["#e05d5d", "#3d8bfd", "#2eaf7d", "#c06fd4", "#e0a13f", "#3fb8c4", "#8f7ce0", "#d46f9d"];
const colorFor = (id) => COLORS[Math.abs([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % COLORS.length];
// Graphite's /github/pr/<owner>/<repo>/<n> links and the API's github.com/<owner>/<repo>/pull/<n> urls.
const prKey = (url) => url?.match(/(?:\/github\/pr|github\.com)\/([^/]+)\/([^/]+)\/(?:pull\/)?(\d+)/)?.slice(1, 4).join("/").toLowerCase().replace(/\/(\d+)$/, "#$1");
// "feat(api): verify webhook signatures (ABC-123)" -> "verify webhook signatures"
const stackLabel = (t) => t.replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/\s*\(?\[?[A-Z]{2,}-\d+\]?\)?\s*$/, "") || t;
const CSS = `tr[data-paseo-stack="hidden"] { display: none !important; }
tr[data-paseo-stack="open"] > :first-child { box-shadow: inset 3px 0 0 var(--paseo-stack); }`;

let defs = null;
let defsAt = 0;
const asked = new Map(); // section URL -> when
async function loadStacks() {
  if (!grouping || location.hostname === "github.com" || !rows.length) return;
  if (!defs || Date.now() - defsAt > 5 * 60_000) {
    defsAt = Date.now();
    defs = fetch("/api/v1/graphite/sections").then((r) => r.json()).then((d) => d?.root?.sectionIds ?? []).catch(() => []);
  }
  const sections = await defs;
  for (const [name, list] of Map.groupBy(rows, (r) => r.section)) {
    const def = sections.find((d) => d.name === name);
    if (!def) continue;
    const q = { sectionId: def.sectionId, sortMethod: def.sortOrderType, sortOrder: def.sortOrderDirection, __first: String(Math.max(10, list.length)) };
    if (list[0].search) q.searchText = list[0].search;
    const url = `/api/v1/graphite/section/prs?${new URLSearchParams(q)}`;
    // Again after 5 minutes (stacks change rarely), or 30s when a shown row isn't known yet.
    const missing = list.some((r) => !stackOf.has(prKey(r.href)));
    if (Date.now() - (asked.get(url) ?? 0) < (missing ? 30_000 : 5 * 60_000)) continue;
    asked.set(url, Date.now());
    void fetch(url).then((r) => r.json()).then((d) => {
      for (const { payload: p } of d?.root?.items ?? [])
        if (p?.stack?.stackId) stackOf.set(prKey(p.url), { stackId: p.stack.stackId, position: p.stack.position, height: p.stack.height, title: p.metadata?.title ?? "" });
      refresh();
    }).catch(() => {});
  }
}

function toggleStack(key) {
  const open = !expanded.has(key);
  open ? expanded.add(key) : expanded.delete(key);
  refresh();
  void chrome.storage.local.get("stacks").then(({ stacks: saved }) => {
    const next = { ...saved };
    if (open) next[key] = true;
    else delete next[key];
    return chrome.storage.local.set({ stacks: next });
  });
}

// Every write goes through here: skipped when it's a no-op, so a quiet DOM stays quiet, and counted for the breaker.
let wrote = 0;
const put = (el, name, value) => {
  if (value == null ? !el.hasAttribute(name) : el.getAttribute(name) === value) return;
  value == null ? el.removeAttribute(name) : el.setAttribute(name, value);
  wrote++;
};
const text = (el, t) => el.textContent !== t && ((el.textContent = t), wrote++);

function header(key) {
  const tr = document.createElement("tr");
  tr.dataset.paseoStackHead = key;
  tr.tabIndex = 0;
  tr.style.cursor = "pointer";
  // Not a React row, but Graphite's row handlers up the tree could still see our clicks and keys.
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "keydown", "keyup"])
    tr.addEventListener(type, (e) => {
      if (e.type.startsWith("key") && e.key !== "Enter" && e.key !== " ") return;
      e.stopPropagation();
      if (e.type === "click" || e.type === "keydown") (e.preventDefault(), toggleStack(tr.dataset.paseoStackHead));
    });
  const td = tr.insertCell();
  td.style.cssText = "padding:6px 12px;border-bottom:1px solid rgba(127,127,127,.15);";
  const line = document.createElement("div");
  line.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;line-height:20px;";
  const span = (css) => Object.assign(document.createElement("span"), { style: `flex:none;${css}` });
  tr.parts = {
    chevron: span("width:10px;font-size:10px;opacity:.5;"),
    square: span("width:8px;height:8px;border-radius:2px;"),
    label: span("flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;"),
    chip: span("border-radius:10px;padding:1px 8px;font-size:11px;background:rgba(127,127,127,.18);opacity:.8;"),
  };
  tr.parts.slot = span("display:contents;");
  line.append(...Object.values(tr.parts));
  td.append(line);
  return tr;
}

let writes = [];
let paused = 0;
function paintStacks() {
  if (paused > Date.now()) return;
  wrote = 0;
  const mine = new Set();
  const done = new Set();
  if (grouping && rows.length) {
    if (!document.querySelector("style[data-paseo-stacks]")) {
      const style = Object.assign(document.createElement("style"), { textContent: CSS });
      style.dataset.paseoStacks = "";
      document.head.append(style);
    }
    const byTr = new Map(rows.map((r) => [r.tr, r]));
    for (const tbody of new Set(rows.map((r) => r.tr.parentElement).filter((n) => n?.tagName === "TBODY"))) {
      const theirs = [...tbody.rows].filter((tr) => tr.dataset.paseoStackHead === undefined);
      const infos = theirs.map((tr) => ({ tr, r: byTr.get(tr), s: stackOf.get(prKey(byTr.get(tr)?.href)) }));
      const groups = Map.groupBy(infos.filter((i) => i.s?.height > 1), (i) => i.s.stackId);
      for (const [id, g] of groups) if (g.length < 2) groups.delete(id);
      if (!groups.size) continue;
      const heads = new Map([...tbody.querySelectorAll(":scope > tr[data-paseo-stack-head]")].map((h) => [h.dataset.paseoStackHead, h]));
      // Only the columns showing: a span over columns Graphite hid at this width adds empty ones and squeezes the table.
      const span = [...theirs[0].cells].reduce((n, c) => n + (getComputedStyle(c).display === "none" ? 0 : c.colSpan), 0);
      const seq = [];
      for (const i of infos) {
        const g = i.s && groups.get(i.s.stackId);
        if (!g) {
          seq.push(i.tr);
          continue;
        }
        if (done.has(g)) continue;
        done.add(g);
        const id = i.s.stackId;
        const open = expanded.has(id);
        const members = g.sort((a, b) => b.s.position - a.s.position);
        const head = heads.get(id) ?? header(id);
        const top = members[0].s;
        const color = colorFor(id);
        if (head.cells[0].colSpan !== span) (head.cells[0].colSpan = span), wrote++;
        put(head, "aria-expanded", String(open));
        put(head, "aria-label", `Stack: ${top.title}, ${members.length} PRs. ${open ? "Collapse" : "Expand"}`);
        text(head.parts.chevron, open ? "▼" : "▶");
        put(head.parts.square, "style", `flex:none;width:8px;height:8px;border-radius:2px;background:${color};`);
        text(head.parts.label, stackLabel(top.title) || `#${prKey(members[0].r.href)?.split("#")[1]}`);
        text(head.parts.chip, `${members.length} PRs · stack of ${top.height}`);
        // The members' Paseo sessions, summed, so a collapsed stack still says it needs you.
        const states = members.map((m) => stateBy.get(rowKey(m.r))).filter(Boolean);
        const sum = (k) => states.reduce((n, s) => n + (s[k] ?? 0), 0);
        const lead = states.find((s) => s.needsYou > 0) ?? states.find((s) => s.running) ?? states[0];
        syncPill(head, states.length ? { url: lead.url, count: sum("count"), running: sum("running"), needsYou: sum("needsYou") } : null, (p) => head.parts.slot.append(p));
        mine.add(head);
        seq.push(head, ...members.map((m) => m.tr));
        for (const m of members) {
          put(m.tr, "data-paseo-stack", open ? "open" : "hidden");
          if (m.tr.style.getPropertyValue("--paseo-stack") !== color) (m.tr.style.setProperty("--paseo-stack", color), wrote++);
          mine.add(m.tr);
        }
      }
      const cur = [...tbody.rows];
      if (seq.length !== cur.length || seq.some((n, k) => n !== cur[k])) (tbody.append(...seq), wrote++);
    }
  }
  // Whatever isn't a current stack's: drop our headers, restore Graphite's rows.
  for (const n of document.querySelectorAll("tr[data-paseo-stack-head], tr[data-paseo-stack]"))
    if (!mine.has(n)) n.dataset.paseoStackHead !== undefined ? (n.remove(), wrote++) : (put(n, "data-paseo-stack", null), n.style.removeProperty("--paseo-stack"));
  // A fight with React (it undoes what we write, we write it again): back off for 5s after 20 writing passes in 10s.
  if (!wrote) return;
  const now = Date.now();
  writes = writes.filter((t) => now - t < 10_000);
  writes.push(now);
  if (writes.length >= 20) (paused = now + 5_000), (writes = []), console.warn("[paseo] inbox stacks keep changing; pausing");
}
// Rescan and repaint from what we already know; cheap enough to run on every React row change. Our own writes happen with
// the observer off, so they never feed it.
function refresh() {
  mo.disconnect();
  try {
    rows = scan();
    paint();
    paintStacks();
  } finally {
    mo.takeRecords();
    observe();
  }
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
    refresh();
  }
  void loadStacks();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "inbox-sessions" && msg.seq === seq) setStates(msg.states), refresh();
  // The panel asks for the rows when this tab becomes the active one. No rows: not an inbox, and it shows all sessions instead.
  if (msg.type === "inbox-rows") reply({ rows: scan().map(wire) });
});

addEventListener("resize", () => document.querySelector("tr[data-paseo-stack-head]") && refresh());
const setGrouping = (inbox) => (grouping = inbox?.groupStacks !== false);
const setExpanded = (saved) => (expanded = new Set(Object.keys(saved ?? {})));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.inbox) setGrouping(changes.inbox.newValue), refresh(), void loadStacks();
  if (area === "local" && changes.stacks) setExpanded(changes.stacks.newValue), refresh();
});

// React re-renders rows on sort, filter and updates; rescan at most twice a second. New React rows repaint at once, so a
// collapsed stack's rows don't flash. Runs at document_start, so it sees the inbox from its first render.
const rowish = (n) => n.nodeType === 1 && (n.nodeName === "TR" || n.querySelector("tr"));
let timer = 0;
const mo = new MutationObserver((records) => {
  if (grouping && stackOf.size && records.some((r) => [...r.addedNodes].some(rowish))) refresh();
  timer ||= setTimeout(() => ((timer = 0), void update()), 500);
});
const observe = () => mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
observe();
void Promise.all([chrome.storage.sync.get("inbox"), chrome.storage.local.get("stacks")]).then(([{ inbox }, { stacks: saved }]) => {
  setGrouping(inbox);
  setExpanded(saved);
  void update();
});
