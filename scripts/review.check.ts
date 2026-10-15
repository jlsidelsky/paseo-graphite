// node scripts/review.check.ts
import assert from "node:assert/strict";
import { reviewDir, reviewNumber } from "../plugin/server/review.ts";
import { lightReviewPr } from "../src/pr.ts";

const home = "/home/me/.paseo";
const dir = reviewDir(home, "/code/app", 42);
assert.match(dir, /^\/home\/me\/\.paseo\/review-worktrees\/app-[0-9a-f]{8}\/pr-42$/);
// Same repo name elsewhere: another dir.
assert.notEqual(reviewDir(home, "/other/app", 42), dir);
assert.equal(reviewNumber(home, dir), 42);
// Only ours: Paseo's own worktrees, the root itself, and look-alikes outside it don't count.
assert.equal(reviewNumber(home, "/home/me/.paseo/worktrees/abc/pr-42"), null);
assert.equal(reviewNumber(home, "/home/me/.paseo/review-worktrees"), null);
assert.equal(reviewNumber(home, "/elsewhere/review-worktrees/app-1/pr-42"), null);
assert.equal(reviewNumber(home, "/home/me/.paseo/review-worktrees/app-1/main"), null);

// The panel spots one from the workspace's directory, on any host.
assert.equal(lightReviewPr(dir), 42);
assert.equal(lightReviewPr("/srv/paseo/review-worktrees/app-1/pr-7"), 7);
assert.equal(lightReviewPr("/home/me/.paseo/worktrees/abc/pr-7"), null);
assert.equal(lightReviewPr(undefined), null);
console.log("review ok");
