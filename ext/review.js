// "Send to Paseo" on review comments and diff selections. Block-scoped: content.js shares this global scope.
{
  // ---- Graphite DOM knowledge: fix selectors here. ----
  // Diff selectors come from github.com/nprbst/graphite-tour-export, which reads Graphite's CSS-module class
  // prefixes (Name_local__hash; the hash changes per deploy, the prefix rarely does).
  const FILE_CARD = '[class*="FileCard_file__"]';
  const FILE_TITLE = '[class*="FileDiffTitle_fileDiffTitle__"]';
  const DIFF_LINES = '[class*="FileDiffLines_fileDiffLines__"]'; // its children are line rows
  const GUTTER = "[data-gutter-line-number]";
  const GUTTER_MARK = '[class*="line_side_number__"]'; // class includes "added" / "deleted"
  const CODE = '[class*="CodeLineHtml_codeLineHtml__"]';
  // Comment selectors are guesses: Graphite renders markdown in markdown_markdown__* (known), and a comment's
  // container class presumably contains "Comment"/"comment".
  const COMMENT_BODY = '[class*="omment"] [class*="markdown_markdown__"]';
  const AUTHOR = '[class*="author" i], [class*="username" i], img[alt][class*="avatar" i]';
  // ---- end Graphite DOM knowledge ----

  const BTN = "data-paseo-send";

  const send = (text) => chrome.runtime.sendMessage({ type: "to-paseo", text }).catch(() => {});

  const filePath = (node) => node.closest(FILE_CARD)?.querySelector(FILE_TITLE)?.textContent?.trim() || null;

  // The row's last numbered gutter: the new-file side in split view.
  const lineNo = (row) => [...row.querySelectorAll(GUTTER)].map((g) => g.getAttribute("data-gutter-line-number")).filter(Boolean).pop();

  const rowOf = (node) => {
    for (let n = node; n?.parentElement; n = n.parentElement) if (n.parentElement.matches(DIFF_LINES)) return n;
    return null;
  };

  // Same two URL shapes as parsePr in src/pr.ts.
  const pr = () => `PR #${location.pathname.match(/\/(?:pr\/[^/]+\/[^/]+|pull)\/(\d+)/)?.[1] ?? "?"}`;
  const where = (path, lines) => {
    const range = !lines.length ? "" : lines[0] === lines.at(-1) ? ` line ${lines[0]}` : ` lines ${lines[0]}–${lines.at(-1)}`;
    return path ? `\`${path}\`${range} (${pr()})` : pr();
  };

  function commentText(body) {
    let author = null;
    for (let n = body.parentElement, i = 0; n && i < 8 && !author; n = n.parentElement, i++) {
      const a = n.querySelector(AUTHOR);
      author = (a?.alt || a?.textContent)?.trim().replace(/^@/, "") || null;
    }
    // Inline comments sit between diff rows; the nearest numbered row above is the commented line.
    let line = null;
    for (let r = rowOf(body)?.previousElementSibling; r && !line; r = r.previousElementSibling) line = lineNo(r);
    const quoted = body.innerText.trim().replace(/^/gm, "> ");
    return `Review comment on ${where(filePath(body), line ? [line] : [])}${author ? ` by @${author}` : ""}:\n${quoted}\n\n${location.href}`;
  }

  function selectionText(sel) {
    const range = sel.getRangeAt(0);
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const rows = [...(start?.closest(DIFF_LINES)?.children ?? [])].filter((r) => range.intersectsNode(r) && r.querySelector(CODE));
    const lines = rows.map(lineNo).filter(Boolean);
    const code = rows.length
      ? rows
          .map((r) => {
            const mark = r.querySelector(GUTTER_MARK)?.className ?? "";
            return (mark.includes("added") ? "+" : mark.includes("deleted") ? "-" : " ") + r.querySelector(CODE).textContent;
          })
          .join("\n")
      : sel.toString();
    // ponytail: whole rows, not the exact selected characters; a hand-off to an agent wants the full lines.
    return `Lines from ${where(start && filePath(start), lines)}:\n\`\`\`${rows.length ? "diff" : ""}\n${code}\n\`\`\`\n\n${location.href}`;
  }

  function button(label, style) {
    const b = document.createElement("button");
    b.setAttribute(BTN, "");
    b.setAttribute("aria-label", label);
    b.title = label;
    b.textContent = "→ Paseo";
    b.style.cssText = `all:initial;cursor:pointer;font:500 11px system-ui,sans-serif;padding:2px 8px;border-radius:999px;${style}`;
    b.onfocus = () => (b.style.outline = "2px solid #d97757");
    b.onblur = () => (b.style.outline = "none");
    return b;
  }

  function scan() {
    for (const body of document.querySelectorAll(COMMENT_BODY)) {
      if (body.nextElementSibling?.hasAttribute(BTN)) continue;
      const b = button(
        "Send this comment to Paseo",
        `display:inline-block;margin-top:4px;color:${getComputedStyle(body).color};border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.1);`,
      );
      b.onclick = () => send(commentText(body));
      body.after(b);
    }
  }

  let timer = null;
  new MutationObserver(() => {
    timer ??= setTimeout(() => ((timer = null), scan()), 500);
  }).observe(document.body, { childList: true, subtree: true });
  scan();

  // Floating button for a selection inside a diff. Text is captured on show, since clicking may clear the selection.
  let floating = null;
  function onSelect() {
    const sel = getSelection();
    const node = sel?.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).commonAncestorContainer : null;
    const el = node instanceof Element ? node : node?.parentElement;
    floating?.remove();
    floating = null;
    if (!el?.closest(`${FILE_CARD}, ${DIFF_LINES}`)) return;
    const text = selectionText(sel);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    floating = button(
      "Send selected lines to Paseo",
      `position:fixed;z-index:2147483647;left:${Math.min(rect.right, innerWidth - 90)}px;top:${Math.min(rect.bottom + 6, innerHeight - 30)}px;` +
        "background:#1f2023;color:#e8e8ea;border:1px solid #3a3b40;box-shadow:0 2px 8px rgba(0,0,0,.3);",
    );
    floating.onmousedown = (e) => e.preventDefault();
    floating.onclick = () => (send(text), floating?.remove(), (floating = null));
    document.body.append(floating);
  }
  const ours = (e) => e.target instanceof Element && e.target.hasAttribute(BTN);
  document.addEventListener("mouseup", (e) => !ours(e) && setTimeout(onSelect));
  document.addEventListener("keyup", (e) => e.shiftKey && !ours(e) && onSelect());
  document.addEventListener("scroll", () => (floating?.remove(), (floating = null)), true);
}
