// Light review worktrees: a plain `git worktree` checked out to a PR, with none of the repo's Paseo worktree setup.
// They live in a plugin-owned dir, outside Paseo's own worktrees root, so Paseo never treats them as its own (no teardown,
// no removal) and the plugin only ever removes what it created.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();

export const reviewRoot = (home: string) => join(home, "review-worktrees");
export const reviewBranch = (n: number) => `review-pr-${n}`;
// <root>/<repo name>-<hash of its path>/pr-<n>: two checkouts of one repo, or two repos with one name, don't collide.
export const reviewDir = (home: string, repoRoot: string, n: number) =>
  join(reviewRoot(home), `${basename(repoRoot)}-${createHash("sha1").update(repoRoot).digest("hex").slice(0, 8)}`, `pr-${n}`);
// The PR number if `cwd` is (in) one of ours.
export function reviewNumber(home: string, cwd: string) {
  const parts = relative(reviewRoot(home), cwd).split(sep);
  const m = parts.length >= 2 && parts[0] !== ".." ? parts[1].match(/^pr-(\d+)$/) : null;
  return m ? Number(m[1]) : null;
}

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
// Branches we made carry this, so removal never deletes a branch that was already there.
const MARK = "paseoReview";
const marked = (cwd: string, branch: string) => ok(git(cwd, "config", "--get", `branch.${branch}.${MARK}`));

// Fetches the PR head and checks it out, new or refreshed. The local branch is the PR's head branch when it's free, so
// `gh pr view` and review tools that read the current branch find the PR; else `review-pr-<n>`. Either tracks the head on
// origin, which is what Paseo links the workspace to the PR by.
export async function createReviewWorktree(home: string, repoRoot: string, n: number, head: string | null) {
  const dir = reviewDir(home, repoRoot, n);
  await git(repoRoot, "fetch", "--quiet", "origin", `+refs/pull/${n}/head`);
  const sha = await git(repoRoot, "rev-parse", "FETCH_HEAD");
  let branch: string;
  if (existsSync(dir)) {
    branch = await git(dir, "branch", "--show-current");
    if (!branch || !(await marked(dir, branch))) throw new Error(`${dir} is on a branch it didn't make; not refreshing it`);
    if (await git(dir, "status", "--porcelain")) throw new Error(`${dir} has local changes; not refreshing it`);
    await git(dir, "reset", "--quiet", "--hard", sha);
  } else {
    const free = head && !(await ok(git(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${head}`)));
    branch = free ? head : reviewBranch(n);
    // A leftover review-pr-<n> of ours is reset; anyone else's makes this fail rather than lose it.
    await git(repoRoot, "worktree", "add", "--quiet", (await marked(repoRoot, branch)) ? "-B" : "-b", branch, dir, sha);
    await git(repoRoot, "config", `branch.${branch}.${MARK}`, "true");
  }
  if (head) {
    // Keeps origin/<head> current so ahead/behind is right; a fork's branch isn't on origin, which is fine.
    await git(repoRoot, "fetch", "--quiet", "origin", `+refs/heads/${head}:refs/remotes/origin/${head}`).catch(() => {});
    await git(repoRoot, "config", `branch.${branch}.remote`, "origin");
    await git(repoRoot, "config", `branch.${branch}.merge`, `refs/heads/${head}`);
  }
  return { path: dir, branch };
}

// Removes one of ours if git agrees it's clean (no changes, no untracked files), and its branch if we made it. Throws otherwise.
export async function removeReviewWorktree(dir: string) {
  const main = dirname(await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const branch = await git(dir, "branch", "--show-current");
  const ours = !!branch && (await marked(main, branch));
  await git(main, "worktree", "remove", dir);
  if (ours) await git(main, "branch", "-D", branch);
}
