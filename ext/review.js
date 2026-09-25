"use strict";
// "Send to Paseo" on review comments and diff selections. Block-scoped and strict: content.js and inbox.js share this global
// scope, and without strict mode the functions declared in this block would leak into it (and break inbox.js's `scan`).
{
  // ---- Graphite DOM knowledge: fix selectors here. ----
  // Diff selectors come from github.com/nprbst/graphite-tour-export, which reads Graphite's CSS-module class
  // prefixes (Name_local__hash; the hash changes per deploy, the prefix rarely does).
  const FILE_CARD = '[class*="FileCard_file__"]';
  const FILE_TITLE = '[class*="FileDiffTitle_fileDiffTitle__"]';
  const GUTTER = "[data-gutter-line-number]";
  const GUTTER_MARK = '[class*="line_side_number__"]'; // class includes "added" / "deleted"
  const CODE = '[class*="CodeLineHtml_codeLineHtml__"]';
  const graphite = {
    DIFF: FILE_CARD,
    DIFF_LINES: '[class*="FileDiffLines_fileDiffLines__"]', // its children are line rows
    // Comment selectors are guesses: Graphite renders markdown in markdown_markdown__* (known), and a comment's
    // container class presumably contains "Comment"/"comment".
    COMMENT_BODY: '[class*="omment"] [class*="markdown_markdown__"]',
    AUTHOR: '[class*="author" i], [class*="username" i], img[alt][class*="avatar" i]',
    filePath: (node) => node.closest(FILE_CARD)?.querySelector(FILE_TITLE)?.textContent?.trim() || null,
    // The row's last numbered gutter: the new-file side in split view.
    lineNo: (row) => [...row.querySelectorAll(GUTTER)].map((g) => g.getAttribute("data-gutter-line-number")).filter(Boolean).pop(),
    codeLine(row) {
      const code = row.querySelector(CODE);
      if (!code) return null;
      const mark = row.querySelector(GUTTER_MARK)?.className ?? "";
      return (mark.includes("added") ? "+" : mark.includes("deleted") ? "-" : " ") + code.textContent;
    },
  };
  // ---- end Graphite DOM knowledge ----

  // ---- GitHub DOM knowledge: fix selectors here. ----
  // Checked against public pages: the classic "Files changed" (what logged-out users get) and the React diff on
  // commit pages, which is the component the new "Files changed" uses. Both put rows in table[data-diff-anchor].
  // React: tr.diff-line-row > td.diff-text-cell[data-line-anchor="diff-<hash>R12"] > code.diff-text.addition > .diff-text-inner
  // Classic: tr > td.blob-num[data-line-number] + td.blob-code-addition > .blob-code-inner
  const GH_CODE = ".diff-text-cell:not(.hunk) .diff-text-inner, .blob-code-inner:not(.blob-code-hunk)";
  const github = {
    DIFF: "table[data-diff-anchor]",
    DIFF_LINES: "table[data-diff-anchor] > tbody",
    // Classic comments (conversation and inline) are .comment-body.markdown-body; the new view's are assumed to be
    // .markdown-body too, which also puts a button on the PR description.
    COMMENT_BODY: ".comment-body, .markdown-body",
    // Mentions in a comment are user hovercard links too; they carry .user-mention.
    AUTHOR: 'a.author, a[data-hovercard-type="user"]:not(.user-mention):not(:has(img))',
    filePath: (node) =>
      node.closest("[data-tagsearch-path]")?.getAttribute("data-tagsearch-path") ??
      node.closest('[role="region"]')?.querySelector('table[aria-label^="Diff for: "]')?.getAttribute("aria-label").slice(10) ??
      null,
    lineNo: (row) =>
      [...row.querySelectorAll("[data-line-anchor], [data-line-number]")]
        .map((g) => (g.getAttribute("data-line-anchor") ?? g.getAttribute("data-line-number")).match(/\d+$/)?.[0])
        .filter(Boolean)
        .pop(),
    // ponytail: split view sends the right-hand (new) side of each row; a row changed on both sides loses the old line.
    codeLine(row) {
      const code = [...row.querySelectorAll(GH_CODE)].pop();
      if (!code) return null;
      const sign = code.closest(".addition, .blob-code-addition") ? "+" : code.closest(".deletion, .blob-code-deletion") ? "-" : " ";
      return sign + code.textContent;
    },
  };
  // ---- end GitHub DOM knowledge ----

  const dom = location.hostname === "github.com" ? github : graphite;
  const BTN = "data-paseo-send";

  // intent "evaluate" / "address" has the panel wrap a comment in that prompt; none quotes it as is.
  // Shift-click (fresh) opens the panel's new-session form with it instead of filling the selected session's composer.
  const send = (text, intent, fresh = false) => chrome.runtime.sendMessage({ type: "to-paseo", text, intent, fresh }).catch(() => {});
  const SHIFT_HINT = " (⇧-click: in a new session)";

  const rowOf = (node) => {
    for (let n = node; n?.parentElement; n = n.parentElement) if (n.parentElement.matches(dom.DIFF_LINES)) return n;
    return null;
  };

  // Same URL shapes as parsePr in src/pr.ts. Also gates the buttons: github.com/* includes non-PR pages.
  const prNumber = () => location.pathname.match(/\/(?:pr\/[^/]+\/[^/]+|pull)\/(\d+)/)?.[1];
  const pr = () => `PR #${prNumber()}`;
  const where = (path, lines) => {
    const range = !lines.length ? "" : lines[0] === lines.at(-1) ? ` line ${lines[0]}` : ` lines ${lines[0]}–${lines.at(-1)}`;
    return path ? `\`${path}\`${range} (${pr()})` : pr();
  };

  function commentText(body) {
    let author = null;
    for (let n = body.parentElement, i = 0; n && i < 8 && !author; n = n.parentElement, i++) {
      const a = n.querySelector(dom.AUTHOR);
      author = (a?.alt || a?.textContent)?.trim().replace(/^@/, "") || null;
    }
    // Inline comments sit between diff rows; the nearest numbered row above is the commented line.
    let line = null;
    for (let r = rowOf(body)?.previousElementSibling; r && !line; r = r.previousElementSibling) line = dom.lineNo(r);
    const quoted = body.innerText.trim().replace(/^/gm, "> ");
    return `Review comment on ${where(dom.filePath(body), line ? [line] : [])}${author ? ` by @${author}` : ""}:\n${quoted}\n\n${location.href}`;
  }

  function selectionText(sel) {
    const range = sel.getRangeAt(0);
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const rows = [...(start?.closest(dom.DIFF_LINES)?.children ?? [])].filter(
      (r) => range.intersectsNode(r) && dom.codeLine(r) !== null,
    );
    const lines = rows.map(dom.lineNo).filter(Boolean);
    const code = rows.length ? rows.map(dom.codeLine).join("\n") : sel.toString();
    // ponytail: whole rows, not the exact selected characters; a hand-off to an agent wants the full lines.
    return `Lines from ${where(start && dom.filePath(start), lines)}:\n\`\`\`${rows.length ? "diff" : ""}\n${code}\n\`\`\`\n\n${location.href}`;
  }

  function button(label, style, text = "→ Paseo") {
    const b = document.createElement("button");
    b.setAttribute(BTN, "");
    b.setAttribute("aria-label", label);
    b.title = label;
    b.textContent = text;
    b.style.cssText = `all:initial;cursor:pointer;font:500 11px system-ui,sans-serif;padding:2px 8px;border-radius:999px;${style}`;
    b.onfocus = () => (b.style.outline = "2px solid #d97757");
    b.onblur = () => (b.style.outline = "none");
    return b;
  }

  function scan() {
    if (!prNumber()) return;
    for (const body of document.querySelectorAll(dom.COMMENT_BODY)) {
      if (body.nextElementSibling?.hasAttribute(BTN)) continue;
      const style = `display:inline-block;color:${getComputedStyle(body).color};border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.1);`;
      const group = document.createElement("span");
      group.setAttribute(BTN, "");
      group.style.cssText = `all:initial;display:inline-flex;gap:4px;align-items:center;margin-top:4px;font:500 11px system-ui,sans-serif;color:${getComputedStyle(body).color};`;
      group.append("→ Paseo:");
      for (const [text, label, intent] of [
        ["Evaluate", "Ask a Paseo session whether this comment is valid", "evaluate"],
        ["Address", "Ask a Paseo session to address this comment", "address"],
        ["Insert", "Quote this comment in the Paseo composer", undefined],
      ]) {
        const b = button(label + SHIFT_HINT, style, text);
        b.onclick = (e) => send(commentText(body), intent, e.shiftKey);
        group.append(b);
      }
      body.after(group);
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
    if (!prNumber() || !el?.closest(`${dom.DIFF}, ${dom.DIFF_LINES}`)) return;
    const text = selectionText(sel);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    floating = button(
      "Send selected lines to Paseo" + SHIFT_HINT,
      `position:fixed;z-index:2147483647;left:${Math.min(rect.right, innerWidth - 90)}px;top:${Math.min(rect.bottom + 6, innerHeight - 30)}px;` +
        "background:#1f2023;color:#e8e8ea;border:1px solid #3a3b40;box-shadow:0 2px 8px rgba(0,0,0,.3);",
    );
    floating.onmousedown = (e) => e.preventDefault();
    floating.onclick = (e) => (send(text, undefined, e.shiftKey), floating?.remove(), (floating = null));
    document.body.append(floating);
  }
  const ours = (e) => e.target instanceof Element && !!e.target.closest(`[${BTN}]`);
  document.addEventListener("mouseup", (e) => !ours(e) && setTimeout(onSelect));
  document.addEventListener("keyup", (e) => e.shiftKey && !ours(e) && onSelect());
  document.addEventListener("scroll", () => (floating?.remove(), (floating = null)), true);
}
