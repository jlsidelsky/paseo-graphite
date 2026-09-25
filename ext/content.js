let lastUrl = "";
let pill = null;
// { title, marked, icon, links: [[link, originalHref]], added } while the tab is marked.
let marked = null;

// Hidden while the side panel is open in this window: it already shows these sessions.
function render(res) {
  if (!res?.count || res.panelOpen) {
    pill?.remove();
    pill = null;
    return;
  }
  if (!pill) {
    pill = document.createElement("button");
    pill.style.cssText =
      "all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;display:flex;align-items:center;gap:8px;" +
      "padding:8px 14px 8px 10px;border-radius:999px;background:#1f2023;color:#e8e8ea;border:1px solid #3a3b40;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.35);font:500 13px system-ui,sans-serif;cursor:pointer;";
    pill.onclick = () => chrome.runtime.sendMessage({ type: "open-panel" });
    document.body.append(pill);
  }
  const icon = Object.assign(document.createElement("img"), { src: chrome.runtime.getURL("icons/32.png") });
  icon.style.cssText = "width:18px;height:18px;";
  const label = `${res.count} Paseo session${res.count === 1 ? "" : "s"}${res.running ? ` · ${res.running} running` : ""}`;
  pill.replaceChildren(icon, label);
}

// The page's favicon with an accent dot; a plain dark circle stands in when it can't be drawn (no CORS, no icon).
function dotted(href) {
  const canvas = Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
  const ctx = canvas.getContext("2d");
  const finish = (drawn) => {
    if (!drawn) {
      ctx.clearRect(0, 0, 32, 32);
      ctx.fillStyle = "#1f2023";
      ctx.beginPath();
      ctx.arc(16, 16, 15, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.fillStyle = "#d97757";
    ctx.beginPath();
    ctx.arc(24, 24, 8, 0, 2 * Math.PI);
    ctx.fill();
    return canvas.toDataURL();
  };
  return new Promise((resolve) => {
    if (!href) return resolve(finish(false));
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        ctx.drawImage(img, 0, 0, 32, 32);
        resolve(finish(true));
      } catch {
        resolve(finish(false));
      }
    };
    img.onerror = () => resolve(finish(false));
    img.src = href;
  });
}

async function mark() {
  if (marked) return;
  const links = [...document.querySelectorAll('link[rel~="icon"]')];
  const state = (marked = { title: document.title, links: links.map((l) => [l, l.getAttribute("href")]), icon: null, added: null });
  document.title = state.marked = `● ${state.title}`;
  const icon = await dotted(links.at(-1)?.href);
  if (marked !== state) return;
  state.icon = icon;
  if (links.length) for (const l of links) l.href = icon;
  else document.head.append((state.added = Object.assign(document.createElement("link"), { rel: "icon", href: icon })));
}

// The page may have replaced the title or icons since; leave its newer ones alone.
function unmark() {
  const state = marked;
  if (!state) return;
  marked = null;
  if (document.title === state.marked) document.title = state.title;
  for (const [l, href] of state.links) {
    if (l.href !== state.icon) continue;
    if (href === null) l.removeAttribute("href");
    else l.setAttribute("href", href);
  }
  state.added?.remove();
}

// ---- PR page actions bar: fix anchors here. ----
// Graphite: before Review Changes in the header's action row, found by its CSS-module prefix (the hash changes per deploy).
// GitHub: the end of the React header's author/branches row, or the classic header's actions.
const BAR_ANCHOR = location.hostname === "github.com"
  ? '[data-component="PageHeader.Description"] > div, .gh-header-actions'
  : '[class*="ReviewChangesAction_reviewChangesAction__"]';
let bar = null;
let ci = null;

// Each button opens the panel on this PR with that action's menu open, as the panel's actions bar does.
function makeBar() {
  const root = document.createElement("span");
  root.setAttribute("data-paseo-bar", "");
  root.style.cssText =
    "all:initial;display:inline-flex;align-items:stretch;flex:none;height:32px;box-sizing:border-box;border:1px solid rgba(127,127,127,.35);" +
    "border-radius:6px;overflow:hidden;font:500 12px system-ui,sans-serif;color:inherit;";
  const icon = Object.assign(document.createElement("img"), { src: chrome.runtime.getURL("icons/32.png"), alt: "Paseo", title: "Paseo" });
  icon.style.cssText = "width:16px;height:16px;align-self:center;margin:0 2px 0 8px;";
  root.append(icon);
  for (const [action, text, title] of [
    ["review", "Review ▾", "Review this PR or its stack in a Paseo session"],
    ["fixci", "Fix CI ▾", "Ask a Paseo session to fix the failing checks"],
    ["feedback", "Feedback ▾", "Evaluate or address review feedback in a Paseo session"],
  ]) {
    const b = document.createElement("button");
    b.dataset.action = action;
    b.textContent = text;
    b.title = title;
    b.style.cssText = "all:initial;cursor:pointer;padding:0 8px;font:inherit;color:inherit;border-left:1px solid rgba(127,127,127,.25);";
    b.onmouseenter = () => (b.style.background = "rgba(127,127,127,.12)");
    b.onmouseleave = () => (b.style.background = "none");
    b.onfocus = () => (b.style.outline = "2px solid #d97757");
    b.onblur = () => (b.style.outline = "none");
    b.onclick = () => chrome.runtime.sendMessage({ type: "pr-action", url: location.href, action }).catch(() => {});
    root.append(b);
  }
  root.firstElementChild.nextElementSibling.style.borderLeft = "none";
  return root;
}

// Muted, still clickable: Paseo only knows the checks of PRs a workspace is on, and the panel's menu covers the whole scope.
function paintCi() {
  const b = bar?.querySelector('[data-action="fixci"]');
  if (!b) return;
  b.style.opacity = ci === "success" ? ".5" : "1";
  b.title = ci === "success" ? "All checks pass" : ci === "failure" ? "Checks are failing: ask a Paseo session to fix them" : "Ask a Paseo session to fix the failing checks";
}

// Re-attached on every tick: Graphite and GitHub re-render the header on navigation.
function placeBar() {
  if (!/\/(?:pr\/[^/]+\/[^/]+|pull)\/\d+/.test(location.pathname)) return bar?.remove();
  const anchor = document.querySelector(BAR_ANCHOR);
  if (!anchor || bar?.isConnected && (anchor.previousElementSibling === bar || anchor.lastElementChild === bar)) return;
  bar ??= makeBar();
  paintCi();
  if (location.hostname === "github.com") anchor.append(bar);
  else anchor.before(bar);
}
// ---- end PR page actions bar ----

async function pull() {
  const res = await chrome.runtime.sendMessage({ type: "pr-sessions", url: location.href }).catch(() => null);
  render(res);
  ci = res?.ci ?? null;
  paintCi();
}

// The background pushes counts as sessions change, and marks the tab when one finishes or needs you.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "pr-sessions") render(msg), (ci = msg.ci ?? null), paintCi();
  if (msg.type === "mark") void mark();
  if (msg.type === "unmark") unmark();
});
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && unmark());
window.addEventListener("focus", unmark);

// ponytail: Graphite and GitHub are SPAs, so poll for URL changes; the Navigation API's navigate event could replace this.
setInterval(() => {
  placeBar();
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    void pull();
  }
}, 1000);
