// node scripts/pr.check.ts
import assert from "node:assert/strict";
import { parsePr } from "../src/pr.ts";

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
console.log("pr ok");
