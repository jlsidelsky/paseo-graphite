// Tags a Paseo agent with `pr:<owner>/<repo>#<n>` labels for PRs it works on, so the extension can find it.
//   Claude Code PostToolUse hook (Bash):  node pr-touch.mjs
//   One-off backfill from transcripts:    node pr-touch.mjs --backfill [--dry-run]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const PASEO = process.env.PASEO_CLI || "paseo";
// Lookups (`gh pr view/list/checks/status`) and plain mentions don't count; these read the code or change the PR.
// Anchored to command position so a script that merely contains the text doesn't count.
const CMD = String.raw`(?:^|[;&|(]\s*)`;
const GH_PR = new RegExp(CMD + String.raw`gh\s+pr\s+(create|diff|review|comment|edit|merge|checkout|ready|close|reopen)\b([^|;&\n]*)`, "gm");
const GT_SUBMIT = new RegExp(CMD + String.raw`gt\s+(submit|ss)\b`, "m");
const PR_URL = /https:\/\/(?:github\.com\/([\w.-]+)\/([\w.-]+)\/pull|app\.graphite\.(?:com|dev)\/github\/(?:pr\/([\w.-]+)\/([\w.-]+)|([\w.-]+)\/([\w.-]+)\/pull))\/(\d+)/g;

const repoCache = new Map();
function repoOf(cwd) {
  if (!repoCache.has(cwd)) {
    let repo = null;
    try {
      const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = url.trim().match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (m) repo = `${m[1]}/${m[2]}`;
    } catch {}
    repoCache.set(cwd, repo);
  }
  return repoCache.get(cwd);
}

const urlPrs = (text) => [...text.matchAll(PR_URL)].map((m) => `${m[1] ?? m[3] ?? m[5]}/${m[2] ?? m[4] ?? m[6]}#${m[7]}`);

export function touchedPrs(command, output, cwd) {
  const prs = new Set();
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
    for (const line of output.split(/\n|\\n/)) if (/\((created|updated)\)/.test(line)) urlPrs(line).forEach((p) => prs.add(p));
  return [...prs].map((p) => `pr:${p.toLowerCase()}`);
}

function label(agentId, keys) {
  if (!keys.length) return;
  const date = new Date().toISOString().slice(0, 10);
  execFileSync(PASEO, ["agent", "update", agentId, ...keys.flatMap((k) => ["--label", `${k}=${date}`])], { stdio: "ignore" });
}

function hook() {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) return;
  const input = JSON.parse(readFileSync(0, "utf8"));
  const res = input.tool_response ?? {};
  const output = typeof res === "string" ? res : `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  try {
    label(agentId, touchedPrs(input.tool_input?.command ?? "", output, input.cwd ?? process.cwd()));
  } catch {} // ponytail: never fail the agent's tool call over a missed tag.
}

async function backfill(dryRun) {
  const { createPaseoClient } = await import("@getpaseo/client");
  const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
  await client.connect();
  const { entries } = await client.agents.list();
  await client.close();
  const bySession = new Map(entries.filter((e) => e.agent.runtimeInfo?.sessionId).map((e) => [e.agent.runtimeInfo.sessionId, e.agent.id]));
  const root = join(homedir(), ".claude", "projects");
  const files = readdirSync(root, { recursive: true }).filter((f) => f.endsWith(".jsonl"));
  const found = new Map();
  for (const file of files) {
    // Subagent transcripts live in <parent-session>/subagents/, and count toward the parent.
    const session = file.includes("/subagents/") ? basename(dirname(dirname(file))) : basename(file, ".jsonl");
    const agentId = bySession.get(session);
    if (!agentId) continue;
    const calls = new Map();
    for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
      if (!line.includes('"Bash"') && !line.includes("tool_result")) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      for (const part of Array.isArray(row.message?.content) ? row.message.content : []) {
        if (part.type === "tool_use" && part.name === "Bash") calls.set(part.id, { command: part.input?.command ?? "", cwd: row.cwd });
        if (part.type === "tool_result" && calls.has(part.tool_use_id)) {
          const { command, cwd } = calls.get(part.tool_use_id);
          const output = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
          for (const key of touchedPrs(command, output, cwd ?? "")) {
            if (!found.has(agentId)) found.set(agentId, new Set());
            found.get(agentId).add(key);
          }
        }
      }
    }
  }
  for (const [agentId, keys] of found) {
    console.log(agentId, [...keys].join(" "));
    if (!dryRun) label(agentId, [...keys]);
  }
}

if (process.argv.includes("--backfill")) await backfill(process.argv.includes("--dry-run"));
else hook();
