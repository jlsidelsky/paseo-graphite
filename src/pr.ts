import type { createPaseoApi } from "@getpaseo/client";

type Paseo = ReturnType<typeof createPaseoApi>;
export type Workspace = Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number];
export type Pr = { owner: string; repo: string; number: number };

export const DAEMON_URL = "ws://127.0.0.1:6767/ws";

export function parsePr(url: string | undefined): Pr | null {
  const m = url?.match(/^https:\/\/(?:[\w-]+\.)*graphite\.(?:com|dev)\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)/);
  return m ? { owner: m[1].toLowerCase(), repo: m[2].toLowerCase(), number: Number(m[3]) } : null;
}

// Set by scripts/pr-touch.mjs and on sessions started from the panel.
export const prLabel = (target: Pr) => `pr:${target.owner}/${target.repo}#${target.number}`;

export function isRepo(w: Workspace, target: Pr) {
  return (w.gitRuntime?.remoteUrl ?? "").toLowerCase().includes(`/${target.owner}/${target.repo}`);
}

export function isPrWorkspace(w: Workspace, target: Pr | null) {
  return !!target && w.githubRuntime?.pullRequest?.number === target.number && isRepo(w, target);
}

export async function sessionsForPr(paseo: Paseo, target: Pr) {
  const [ws, ag] = await Promise.all([paseo.workspaces.list(), paseo.agents.list({ filter: { includeArchived: true } })]);
  const prWorkspaceIds = new Set(ws.entries.filter((w) => isPrWorkspace(w, target)).map((w) => w.id));
  const label = prLabel(target);
  const agents = ag.entries
    .map((e) => e.agent)
    .filter((a) => (a.workspaceId && prWorkspaceIds.has(a.workspaceId)) || label in (a.labels ?? {}))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { workspaces: ws.entries, agents };
}
