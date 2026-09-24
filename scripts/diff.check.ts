// node scripts/diff.check.ts
import assert from "node:assert/strict";
import { diffStrings, parseUnifiedDiff } from "../src/diff.ts";

const show = (lines: { sign: string; text: string }[]) => lines.map((l) => l.sign + l.text);

assert.deepEqual(show(diffStrings("a\nb\nc", "a\nB\nc")), [" a", "-b", "+B", " c"]);
assert.deepEqual(show(diffStrings("", "x\ny")), ["+x", "+y"]);
assert.deepEqual(show(diffStrings("same", "same")), [" same"]);
assert.deepEqual(show(diffStrings("a\na", "a")), [" a", "-a"]);
assert.deepEqual(
  show(parseUnifiedDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n ctx\n--- sql comment\n+new\n\\ No newline at end of file\n")),
  ["@@@ -1,2 +1,2 @@", " ctx", "--- sql comment", "+new"],
);
assert.deepEqual(show(parseUnifiedDiff("@@ -10,3 +10,3 @@\n A=1\n-B=2\n+B=3\n")), ["@@@ -10,3 +10,3 @@", " A=1", "-B=2", "+B=3"]);
console.log("diff ok");
