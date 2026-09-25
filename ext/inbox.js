// A status pill on each PR row with Paseo sessions, on Graphite's inbox and GitHub's PR lists; also answers the panel's
// "inbox-rows" with the visible rows. The background parses rows (rowPr in src/pr.ts) and answers or pushes per-row states.

// ---- Graphite inbox (app.graphite.com/, or wherever the same blocks show up) ----
// Each section has a header with a searchbox named "Search <Section name>" (section names are user-set), followed by a <table>
// with one <tr> per PR when it's expanded and not empty. The title cell holds an <a> with the title, linking to
// /github/pr/<Owner>/<repo>/<n>/<slug>, and under it a line "author · owner/repo #n", which may go on with "1 label" and a
// stack-position button like "1/4". Class names are generated, so only roles, labels and tags are used. The pill goes at the
// start of that subtitle line, so truncated titles and the narrow (560px) layout keep working.
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
    for (const tr of node.querySelectorAll("tr")) {
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
    if (t.data.trim() && !link.contains(t) && !t.parentElement.closest("[data-paseo-pill]")) out.push(t);
  }
  return out;
}

// A PR page is never an inbox, whatever tables it has.
const scan = () => (location.hostname === "github.com" ? githubRows() : /\/(pr|pull)\//.test(location.pathname) ? [] : graphiteRows());

let rows = [];
let sent = "[]";
let seq = Math.floor(Math.random() * 1e9);
let states = [];
const wire = (r) => ({ href: r.href, sub: r.sub, title: r.title, section: r.section, sectionIndex: r.sectionIndex });

const STYLE = "all:initial;display:inline-block;flex:none;vertical-align:middle;box-sizing:border-box;margin:0 6px 0 0;padding:0 7px;" +
  "border-radius:999px;font:600 11px/17px system-ui,sans-serif;white-space:nowrap;cursor:pointer;";

const live = new WeakSet();

function paint() {
  rows.forEach((r, i) => {
    const s = states[i];
    let pill = r.tr.querySelector("[data-paseo-pill]");
    // A copy the page made of our markup has no listeners.
    if (pill && !live.has(pill)) pill = void pill.remove();
    if (!s) return pill?.remove();
    const needs = s.needsYou > 0;
    const text = needs ? "needs you" : s.running ? `● ${s.running > 1 ? `${s.running} ` : ""}running` : `${s.count} session${s.count === 1 ? "" : "s"}`;
    const look = needs ? "background:#d97757;color:#fff;" : s.running ? "background:rgba(45,164,78,.16);color:#2da44e;" : "background:rgba(128,128,128,.18);color:inherit;opacity:.8;";
    if (!pill) {
      pill = Object.assign(document.createElement("button"), { type: "button" });
      pill.dataset.paseoPill = "";
      // Keep Graphite's row (and its keyboard handling) from seeing the press; the click itself only opens the panel.
      for (const type of ["pointerdown", "mousedown", "mouseup", "click", "keydown", "keyup"])
        pill.addEventListener(type, (e) => {
          if (e.type.startsWith("key") && e.key !== "Enter" && e.key !== " ") return;
          e.stopPropagation();
          if (e.type === "click") (e.preventDefault(), chrome.runtime.sendMessage({ type: "open-pr", url: pill.dataset.url }));
        });
      live.add(pill);
      r.place(pill);
    }
    pill.dataset.url = s.url;
    if (pill.textContent !== text) pill.textContent = text;
    const label = `Paseo: ${s.count} session${s.count === 1 ? "" : "s"}${needs ? ", needs you" : s.running ? `, ${s.running} running` : ""}. Open in the side panel`;
    if (pill.getAttribute("aria-label") !== label) pill.setAttribute("aria-label", label);
    if (pill.dataset.look !== look) (pill.dataset.look = look), (pill.style.cssText = STYLE + look);
  });
}

async function update() {
  rows = scan();
  const next = JSON.stringify(rows.map(wire));
  if (next !== sent) {
    sent = next;
    states = [];
    const mine = ++seq;
    const res = await chrome.runtime.sendMessage({ type: "inbox-rows", seq: mine, rows: rows.map(wire) }).catch(() => null);
    if (res?.seq === seq) states = res.states;
  }
  paint();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "inbox-sessions" && msg.seq === seq) (states = msg.states), paint();
  // The panel asks for the rows when this tab becomes the active one. No rows: not an inbox, and it shows all sessions instead.
  if (msg.type === "inbox-rows") reply({ rows: scan().map(wire) });
});

// React re-renders rows on sort, filter and updates; rescan at most twice a second. Painting pills is idempotent, so the
// mutations it causes settle after one extra pass.
let timer = 0;
new MutationObserver(() => (timer ||= setTimeout(() => ((timer = 0), void update()), 500))).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});
void update();
