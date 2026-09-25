// node scripts/pr.check.ts
import assert from "node:assert/strict";
import { orderStack, parsePr } from "../src/pr.ts";

const pr = { owner: "cli", repo: "cli", number: 9000 };
for (const url of [
  "https://app.graphite.com/github/pr/cli/cli/9000",
  "https://app.graphite.dev/github/pr/Cli/CLI/9000/title-slug?tab=files",
  "https://graphite.com/github/cli/cli/pull/9000",
  "https://github.com/cli/cli/pull/9000",
  "https://github.com/Cli/cli/pull/9000/files",
  "https://github.com/cli/cli/pull/9000/commits",
  "https://github.com/cli/cli/pull/9000/checks",
  "https://github.com/cli/cli/pull/9000/changes#diff-abc",
  "https://github.com/cli/cli/pull/9000?w=1",
])
  assert.deepEqual(parsePr(url), pr, url);
for (const url of [
  undefined,
  "https://github.com/cli/cli/pulls",
  "https://github.com/cli/cli/pull/new/branch",
  "https://github.com/cli/cli/pull/9000x",
  "https://github.com/cli/cli/issues/9000",
  "https://gist.github.com/cli/cli/pull/9000",
  "https://linear.app/acme/issue/ENG-1/x",
])
  assert.equal(parsePr(url), null, url);

// Stack order, bottom to top, whatever order the searches returned PRs in.
const pr_ = (number: number, baseRefName: string, headRefName: string) => ({ number, baseRefName, headRefName });
const order = (items: ReturnType<typeof pr_>[]) => orderStack(items).map((i) => i.number);
const chain = [pr_(103, "b", "c"), pr_(101, "main", "a"), pr_(102, "a", "b")];
assert.deepEqual(order(chain), [101, 102, 103]);
// Two PRs share head b (one onto a, a stray one onto main): they sit together, below the PR based on b, each once.
assert.deepEqual(order([pr_(104, "c", "d"), pr_(103, "b", "c"), pr_(105, "main", "b"), pr_(101, "main", "a"), pr_(102, "a", "b"), pr_(102, "a", "b")]), [101, 102, 105, 103, 104]);
// A cycle has no bottom: it starts from its lowest PR and still lists each PR once.
assert.deepEqual(order([pr_(202, "x", "y"), pr_(201, "y", "x")]), [201, 202]);
// A fork above a PR: both children after it, by number.
assert.deepEqual(order([pr_(303, "a", "c"), pr_(302, "a", "b"), pr_(301, "main", "a")]), [301, 302, 303]);
console.log("pr ok");
