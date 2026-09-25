import type { createPaseoApi, PaseoAgent as Agent } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

type Paseo = ReturnType<typeof createPaseoApi>;
export type Workspace = Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number];
export type Pr = { owner: string; repo: string; number: number };

export const DAEMON_URL = "ws://127.0.0.1:6767/ws";

export function parsePr(url: string | undefined): Pr | null {
  // Graphite uses both /github/pr/<owner>/<repo>/<n> and /github/<owner>/<repo>/pull/<n>; GitHub is /<owner>/<repo>/pull/<n>.
  const m =
    url?.match(/^https:\/\/(?:[\w-]+\.)*graphite\.(?:com|dev)\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)/) ??
    url?.match(/^https:\/\/(?:[\w-]+\.)*graphite\.(?:com|dev)\/github\/([^/]+)\/([^/]+)\/pull\/(\d+)/) ??
    url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/);
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

export function agentsOnPr(workspaces: Workspace[], agents: Agent[], target: Pr) {
  const prWorkspaceIds = new Set(workspaces.filter((w) => isPrWorkspace(w, target)).map((w) => w.id));
  const label = prLabel(target);
  return agents
    .filter((a) => (a.workspaceId && prWorkspaceIds.has(a.workspaceId)) || label in (a.labels ?? {}))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type StackPr = { number: number; title: string; head?: string; base?: string };

type Linked = { number: number; baseRefName?: string; headRefName?: string };

// Bottom to top, grouped by head branch: PRs sharing a head sit together, a branch comes after the one it's based on,
// and the bottom is the branch whose base isn't another stack PR's head. Ties go by PR number; each PR appears once.
export function orderStack<T extends Linked>(items: T[]): T[] {
  const prs = [...new Map(items.map((i) => [i.number, i])).values()].sort((a, b) => a.number - b.number);
  const head = (i: T) => i.headRefName ?? `#${i.number}`;
  const heads = [...new Set(prs.map(head))];
  const on = (h: string) => prs.filter((i) => head(i) === h);
  const isRoot = (h: string) => !on(h).some((i) => i.baseRefName && i.baseRefName !== h && heads.includes(i.baseRefName));
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (h: string) => {
    if (seen.has(h)) return;
    seen.add(h);
    out.push(...on(h));
    for (const c of heads) if (on(c).some((i) => i.baseRefName === h)) visit(c);
  };
  heads.filter(isRoot).forEach(visit);
  // A cycle has no root; start it from its lowest PR.
  heads.forEach(visit);
  return out;
}

// Walks GitHub base/head branches: parents down to the trunk, children up to the tips. ~0.5s per search.
export async function stackOf(daemon: DaemonClient, cwd: string, target: Pr): Promise<StackPr[]> {
  type Item = Linked & { title: string; state: string };
  const search = async (query: string) =>
    ((await daemon.searchForge({ cwd, query, limit: 10, kinds: ["pr"] })).items as Item[]).filter((i) => i.state === "OPEN");
  const self = (await search(String(target.number))).find((i) => i.number === target.number);
  if (!self?.headRefName) return [];
  const found = new Map([[self.number, self]]);
  // Every PR on a linked branch, not just the first the search returns: two PRs can share a head.
  const walk = async (start: string | undefined, query: (b: string) => string, linked: (i: Item, b: string) => boolean, next: (i: Item) => string | undefined) => {
    for (const todo = [start], seen = new Set<string>(); todo.length && found.size < 30; ) {
      const b = todo.shift();
      if (!b || seen.has(b)) continue;
      seen.add(b);
      for (const i of (await search(query(b))).filter((i) => linked(i, b) && !found.has(i.number))) found.set(i.number, i), todo.push(next(i));
    }
  };
  await walk(self.baseRefName, (b) => `head:${b} is:open`, (i, b) => i.headRefName === b, (i) => i.baseRefName);
  await walk(self.headRefName, (b) => `base:${b} is:open`, (i, b) => i.baseRefName === b, (i) => i.headRefName);
  return orderStack([...found.values()]).map(({ number, title, headRefName: head, baseRefName: base }) => ({ number, title, head, base }));
}

// chrome.storage.sync keys and their defaults.
export const SETTINGS = { notify: true, markTab: true };

export type Alert = "done" | "needs-you";

type AgentState = Pick<Agent, "status" | "pendingPermissions" | "archivedAt">;

// Only a change alerts: a session seen for the first time (e.g. after the worker restarts) doesn't.
export function alertFor(prev: AgentState | undefined, next: AgentState): Alert | null {
  if (!prev || next.archivedAt) return null;
  if (!prev.pendingPermissions?.length && next.pendingPermissions?.length) return "needs-you";
  if (prev.status === "running" && next.status !== "running") return "done";
  return null;
}

export type Ticket = { id: string; url: string; title?: string; branch?: string; description?: string };

export function parseTicket(url: string | undefined): Ticket | null {
  const m = url?.match(/^https:\/\/linear\.app\/[^/]+\/issue\/([a-z][a-z0-9]*-\d+)(?:\/[^/?#]*)?/i);
  return m ? { id: m[1].toUpperCase(), url: m[0] } : null;
}

export const ticketLabel = (id: string) => `ticket:${id}`;

// A whole token only: eng-123 in alice/eng-123-fix-login, not eng-1234.
export const branchHasTicket = (branch: string | null | undefined, id: string) =>
  !!branch && new RegExp(`(^|[^a-z0-9])${id}(?![a-z0-9])`, "i").test(branch);

export const isTicketWorkspace = (w: Workspace, id: string) =>
  branchHasTicket(w.gitRuntime?.currentBranch, id) || branchHasTicket(w.githubRuntime?.pullRequest?.headRefName, id);

export function agentsOnTicket(workspaces: Workspace[], agents: Agent[], id: string) {
  const ids = new Set(workspaces.filter((w) => isTicketWorkspace(w, id)).map((w) => w.id));
  return agents
    .filter((a) => (a.workspaceId && ids.has(a.workspaceId)) || ticketLabel(id) in (a.labels ?? {}))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// The Linear button may send the ticket's own branch name; otherwise <id>-<slug from the URL>.
export function ticketBranch(t: Ticket) {
  const slug = t.url.match(/\/issue\/[^/]+\/([^/?#]+)/)?.[1];
  return t.branch || (slug ? `${t.id.toLowerCase()}-${slug}` : t.id.toLowerCase());
}

// Linear titles tabs "ENG-123 Fix login – Linear" (the dash varies).
export const ticketTitle = (tabTitle: string | undefined, id: string) =>
  (tabTitle ?? "").replace(/\s+[-–—|]\s+Linear$/, "").replace(new RegExp(`^\\s*${id}\\s*[:\\-–—]?\\s*`, "i"), "").trim();

export function groupAll(agents: Agent[], finishedCap = 20) {
  const live = agents.filter((a) => !a.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const needs = live.filter((a) => a.pendingPermissions?.length);
  const running = live.filter((a) => !needs.includes(a) && (a.status === "running" || a.status === "initializing"));
  const finished = live.filter((a) => !needs.includes(a) && !running.includes(a)).slice(0, finishedCap);
  return { needs, running, finished };
}

export async function listSessions(paseo: Paseo) {
  const [ws, ag] = await Promise.all([paseo.workspaces.list(), paseo.agents.list({ filter: { includeArchived: true } })]);
  return { workspaces: ws.entries, all: ag.entries.map((e) => e.agent) };
}

// An inbox row's PR: its title link, else the "author · owner/repo #n" line under it (which may go on with labels or a "1/4" stack position).
export function rowPr(href: string | undefined, text: string | undefined): Pr | null {
  const m = text?.match(/(?:^|[\s·])([\w.-]+)\/([\w.-]+)\s+#(\d+)(?!\d)/);
  return parsePr(href) ?? (m ? { owner: m[1].toLowerCase(), repo: m[2].toLowerCase(), number: Number(m[3]) } : null);
}
