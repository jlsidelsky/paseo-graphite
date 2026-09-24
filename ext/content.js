let lastUrl = "";
let pill = null;
// { title, marked, icon, links: [[link, originalHref]], added } while the tab is marked.
let marked = null;

function render(res) {
  if (!res?.count) {
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

// Graphite may have replaced the title or icons since; leave its newer ones alone.
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

async function pull() {
  render(await chrome.runtime.sendMessage({ type: "pr-sessions", url: location.href }).catch(() => null));
}

// The background pushes counts as sessions change, and marks the tab when one finishes or needs you.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "pr-sessions") render(msg);
  if (msg.type === "mark") void mark();
  if (msg.type === "unmark") unmark();
});
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && unmark());
window.addEventListener("focus", unmark);

// ponytail: Graphite is an SPA, so poll for URL changes; the Navigation API's navigate event could replace this.
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    void pull();
  }
}, 1000);
