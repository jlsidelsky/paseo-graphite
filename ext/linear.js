// "▶ Paseo" on Linear issue pages: opens the panel's new-session form for the ticket.
{
  // ---- Linear DOM knowledge: fix selectors here. All guesses; Linear's class names are generated. ----
  // The icon buttons at the top right of an issue (copy issue URL / ID / git branch name). The button goes before the first.
  const TOOLBAR_BUTTON =
    'button[aria-label*="git branch" i], button[aria-label*="Copy issue" i], button[aria-label*="Copy link" i], button[aria-label*="Copy ID" i]';
  const BRANCH_BUTTON = 'button[aria-label*="git branch" i]';
  const HEADING = '[aria-label="Issue title"], h1';
  // document.title is "ENG-123 Issue title", maybe with a " - Linear"-style suffix.
  const TITLE_SUFFIX = /\s+[-–|·]\s+Linear$/;
  // ---- end Linear DOM knowledge ----

  const issueId = () => location.pathname.match(/^\/[^/]+\/issue\/([a-z][a-z0-9]*-\d+)/i)?.[1].toUpperCase();

  function ticket(id) {
    const fromTitle = document.title.replace(TITLE_SUFFIX, "");
    const title = fromTitle.toUpperCase().startsWith(`${id} `)
      ? fromTitle.slice(id.length + 1).trim()
      : document.querySelector(HEADING)?.textContent?.trim() || fromTitle;
    // Only if Linear shows the branch itself (title/label text shaped like a branch); usually it doesn't.
    const b = document.querySelector(BRANCH_BUTTON);
    const branch = [b?.title, b?.getAttribute("aria-label")].find((s) => s && /^[\w.-]+\/[\w./-]+$/.test(s));
    return { id, title, url: location.href.split(/[?#]/)[0], ...(branch && { branch }) };
  }

  const btn = document.createElement("button");
  btn.setAttribute("aria-label", "Start a Paseo session for this issue");
  btn.title = "Start a Paseo session for this issue";
  const icon = Object.assign(document.createElement("img"), { src: chrome.runtime.getURL("icons/32.png"), alt: "" });
  icon.style.cssText = "all:initial;width:14px;height:14px;";
  btn.append(icon, "▶ Paseo");
  btn.onclick = () => {
    const id = issueId();
    if (id) chrome.runtime.sendMessage({ type: "start-session", ticket: ticket(id) }).catch(() => {});
  };
  btn.onfocus = () => (btn.style.outline = "2px solid #d97757");
  btn.onblur = () => (btn.style.outline = "none");
  const BASE =
    "all:initial;display:inline-flex;align-items:center;gap:5px;cursor:pointer;font:500 12px system-ui,sans-serif;" +
    "padding:3px 9px;border-radius:6px;background:#1f2023;color:#e8e8ea;border:1px solid #3a3b40;";

  let lastUrl = "";
  let since = 0;
  // ponytail: polls like content.js; Linear is an SPA and re-renders the toolbar, which can drop the button.
  setInterval(() => {
    if (location.href !== lastUrl) (lastUrl = location.href), (since = Date.now());
    if (!issueId()) return btn.remove();
    const anchor = document.querySelector(TOOLBAR_BUTTON);
    if (anchor) {
      if (btn.nextElementSibling === anchor) return;
      btn.style.cssText = BASE + "margin-right:6px;";
      anchor.before(btn);
    } else if (!btn.isConnected && Date.now() - since > 3000) {
      // Toolbar not found after the page settled: pin to the viewport's top right instead.
      btn.style.cssText = BASE + "position:fixed;top:10px;right:16px;z-index:2147483647;box-shadow:0 2px 8px rgba(0,0,0,.3);";
      document.body.append(btn);
    }
  }, 1000);
}
