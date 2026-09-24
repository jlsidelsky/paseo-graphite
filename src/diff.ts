export type DiffLine = { sign: "+" | "-" | " " | "@"; text: string };

// ponytail: trims common leading/trailing lines and shows the middle as a remove-then-add block, no LCS; fine for Edit's small old/new strings.
export function diffStrings(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ctx = (lines: string[]) => lines.map((text) => ({ sign: " " as const, text }));
  return [
    ...ctx(a.slice(0, head)),
    ...a.slice(head, a.length - tail).map((text) => ({ sign: "-" as const, text })),
    ...b.slice(head, b.length - tail).map((text) => ({ sign: "+" as const, text })),
    ...ctx(a.slice(a.length - tail)),
  ];
}

// Codex's apply_patch starts at the first hunk; a git diff has headers before it, which we drop.
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, "").split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  return lines
    .slice(Math.max(first, 0))
    .filter((l) => !l.startsWith("\\ No newline"))
    .map((l): DiffLine => (l.startsWith("@@") ? { sign: "@", text: l } : l[0] === "+" || l[0] === "-" ? { sign: l[0], text: l.slice(1) } : { sign: " ", text: l.slice(1) }));
}
