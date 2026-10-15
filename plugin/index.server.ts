import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createReviewWorktree, removeReviewWorktree, reviewNumber } from "./server/review";
import { prsInTimeline } from "./server/rules";

const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
const statePath = join(home, "paseo-graphite-pr-tags.json");
// ponytail: TCP listen only; a unix-socket daemon would need the socket transport.
const listen = (() => {
  try {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8")).daemon?.listen ?? "127.0.0.1:6767";
  } catch {
    return "127.0.0.1:6767";
  }
})();

// The panel's light review worktrees (server/review.ts).
const createReview = defineRpc({
  name: "review.worktree.create",
  input: z.object({ repoRoot: z.string().startsWith("/"), number: z.number().int().positive() }),
  output: z.object({ path: z.string(), branch: z.string() }),
});

function registerReview(server: PluginServerContext, daemon: DaemonClient, ready: Promise<unknown>, home: string) {
  server.handle(createReview, async ({ repoRoot, number }) => {
    await ready;
    // The PR's head branch, for the local branch to track, from Paseo's own GitHub search (no gh needed).
    const found = await daemon.searchForge({ cwd: repoRoot, query: String(number), limit: 10, kinds: ["pr"] }).catch(() => null);
    const head = (found?.items as { number: number; headRefName?: string }[] | undefined)?.find((i) => i.number === number)?.headRefName ?? null;
    const out = await createReviewWorktree(home, repoRoot, number, head);
    console.log(`review worktree for #${number}: ${out.path}${head ? ` tracking ${head}` : ""}`);
    return out;
  });

  server.on("workspace.archived", async ({ workspace }) => {
    if (reviewNumber(home, workspace.cwd) === null) return;
    await removeReviewWorktree(workspace.cwd).then(
      () => console.log(`removed review worktree ${workspace.cwd}`),
      (err) => console.error(`kept review worktree ${workspace.cwd}: ${err instanceof Error ? err.message.trim() : err}`),
    );
  });
}

type Item = { type: string; detail?: unknown };

export default function contribute(server: PluginServerContext) {
  // The handed-in SDK can't set labels or read subagent timelines, so keep our own connection.
  const daemon = new DaemonClient({ url: `ws://${listen}/ws`, clientId: "paseo-graphite-pr-tags", clientType: "cli" });
  const ready = daemon.connect();
  const applied = new Map<string, Set<string>>();
  const subagentSeen = new Map<string, string>();
  let stopped = false;

  async function tag(agentId: string, keys: Set<string>) {
    const done = applied.get(agentId) ?? new Set();
    const fresh = [...keys].filter((k) => !done.has(k));
    if (!fresh.length) return;
    const date = new Date().toISOString().slice(0, 10);
    await daemon.updateAgent(agentId, { labels: Object.fromEntries(fresh.map((k) => [k, date])) });
    fresh.forEach((k) => done.add(k));
    applied.set(agentId, done);
    console.log(`tagged ${agentId}: ${fresh.join(" ")}`);
  }

  // Subagents (Claude's Agent tool and the like) run their own commands; count them toward the session that started them.
  async function subagentPrs(agentId: string, cwd: string) {
    const keys = new Set<string>();
    // Archived sessions can't list subagents; their own timeline still counts.
    const { subagents } = await daemon.listProviderSubagents(agentId).catch(() => ({ subagents: [] }));
    for (const s of subagents) {
      const seenKey = `${agentId}/${s.id}`;
      if (subagentSeen.get(seenKey) === s.updatedAt) continue;
      const page = await daemon.fetchProviderSubagentTimeline(agentId, s.id, { direction: "tail", limit: 100000 }).catch(() => null);
      if (!page) continue;
      prsInTimeline(page.rows.map((r: { item: Item }) => r.item), s.cwd ?? cwd).forEach((k) => keys.add(k));
      subagentSeen.set(seenKey, s.updatedAt);
    }
    return keys;
  }

  async function scan(agentId: string, cwd: string, items: readonly Item[], parentAgentId: string | null) {
    const keys = prsInTimeline(items, cwd);
    (await subagentPrs(agentId, cwd)).forEach((k) => keys.add(k));
    await tag(agentId, keys);
    if (parentAgentId) await tag(parentAgentId, keys);
  }

  server.on("agent.turn_ended", async ({ agent, timeline }) => {
    await ready;
    await scan(agent.id, agent.cwd, timeline, agent.parentAgentId).catch((err) => console.error(`scan ${agent.id} failed:`, err));
  });

  registerReview(server, daemon, ready, home);

  // Catch up on sessions updated since the last run; the first run covers everything, including archived sessions.
  void (async () => {
    await ready;
    let since = "";
    try {
      since = JSON.parse(readFileSync(statePath, "utf8")).lastScan ?? "";
    } catch {}
    const startedAt = new Date().toISOString();
    const { entries } = await daemon.fetchAgents({ filter: { includeArchived: true } });
    const stale = entries.map((e) => e.agent).filter((a) => a.updatedAt > since);
    console.log(`catch-up: scanning ${stale.length} of ${entries.length} sessions`);
    let skipped = 0;
    for (const a of stale) {
      if (stopped) return;
      try {
        const page = await daemon.fetchAgentTimeline(a.id, { direction: "tail", limit: 100000 });
        await scan(a.id, a.cwd, page.entries.map((e: { item: Item }) => e.item), null);
      } catch {
        // Usually a session whose worktree was deleted, so its history can't load.
        skipped++;
      }
    }
    if (skipped) console.log(`catch-up: skipped ${skipped} sessions whose history couldn't load (deleted worktrees)`);
    writeFileSync(statePath, JSON.stringify({ lastScan: startedAt }));
    console.log("catch-up done");
  })().catch((err) => console.error("catch-up failed:", err));

  return async () => {
    stopped = true;
    await daemon.close().catch(() => {});
  };
}
