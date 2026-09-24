let lastUrl = "";
let pill = null;

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "pr-sessions", url: location.href }).catch(() => null);
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

// ponytail: Graphite is an SPA, so poll for URL changes and refresh counts every 15s; push updates if this feels laggy.
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    void refresh();
  }
}, 1000);
setInterval(refresh, 15000);
