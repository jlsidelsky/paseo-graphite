import { execFileSync } from "node:child_process";

// Lookups (`gh pr view/list/checks/status`) and plain mentions don't count; these read the code or change the PR.
// Anchored to command position so a script that merely contains the text doesn't count.
const CMD = String.raw`(?:^|[;&|(]\s*)`;
const GH_PR = new RegExp(CMD + String.raw`gh\s+pr\s+(create|diff|review|comment|edit|merge|checkout|ready|close|reopen)\b([^|;&\n]*)`, "gm");
const GT_SUBMIT = new RegExp(CMD + String.raw`gt\s+(submit|ss)\b`, "m");
const PR_URL =
  /https:\/\/(?:github\.com\/([\w.-]+)\/([\w.-]+)\/pull|app\.graphite\.(?:com|dev)\/github\/(?:pr\/([\w.-]+)\/([\w.-]+)|([\w.-]+)\/([\w.-]+)\/pull))\/(\d+)/g;

const repoCache = new Map<string, string | null>();
function repoOf(cwd: string) {
  if (!repoCache.has(cwd)) {
    let repo: string | null = null;
    try {
      const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = url.trim().match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (m) repo = `${m[1]}/${m[2]}`;
    } catch {}
    repoCache.set(cwd, repo);
  }
  return repoCache.get(cwd) ?? null;
}

const urlPrs = (text: string) => [...text.matchAll(PR_URL)].map((m) => `${m[1] ?? m[3] ?? m[5]}/${m[2] ?? m[4] ?? m[6]}#${m[7]}`);

/** Labels (`pr:<owner>/<repo>#<n>`) for the PRs one shell command worked on. */
export function touchedPrs(command: string, output: string, cwd: string) {
  const prs = new Set<string>();
  for (const [, sub, args] of command.matchAll(GH_PR)) {
    const fromArgs = urlPrs(args);
    const num = args.match(/(?:^|\s)#?(\d+)(?=\s|$)/)?.[1];
    const repo = args.match(/(?:-R|--repo)[\s=]+([\w.-]+\/[\w.-]+)/)?.[1] ?? repoOf(cwd);
    if (fromArgs.length) fromArgs.forEach((p) => prs.add(p));
    else if (num && repo) prs.add(`${repo}#${num}`);
    else if (sub === "create") urlPrs(output).forEach((p) => prs.add(p));
  }
  // gt submit lists the whole stack; only the (created)/(updated) lines were touched.
  if (GT_SUBMIT.test(command))
    for (const line of output.split("\n")) if (/\((created|updated)\)/.test(line)) urlPrs(line).forEach((p) => prs.add(p));
  return [...prs].map((p) => `pr:${p.toLowerCase()}`);
}

type Item = { type: string; detail?: unknown };

/** Scans shell tool calls in any provider's timeline. */
export function prsInTimeline(items: readonly Item[], cwd: string) {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool_call" || !item.detail || typeof item.detail !== "object") continue;
    const { command, output } = item.detail as { command?: unknown; output?: unknown };
    if (typeof command !== "string") continue;
    for (const key of touchedPrs(command, typeof output === "string" ? output : JSON.stringify(output ?? ""), cwd)) keys.add(key);
  }
  return keys;
}
