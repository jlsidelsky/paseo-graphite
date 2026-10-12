// Paseo hosts: chrome.storage.local `hosts`, set on the options page (which reloads the extension). Each context keeps one
// client per host and merges their sessions and workspaces. Merged ids are host-qualified keys (`<host>:<id>`), so the
// rest of the code can compare and look up ids as before; `on(key)` gives the host's client and the daemon's own id back.
// No runtime imports from ./, so scripts/hosts.check.ts can load it in Node.
import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export type Paseo = ReturnType<typeof createPaseoApi>;
export type Host = { id: string; label: string; url: string; password: string };
export type Conn = { host: Host; daemon: DaemonClient; api: Paseo };

export const DAEMON_URL = "ws://127.0.0.1:6767/ws";
export const LOCAL: Host = { id: "local", label: "This machine", url: DAEMON_URL, password: "" };

export const keyOf = (host: string, id: string) => `${host}:${id}`;
// Host ids never contain ":"; the daemon's id may.
export const splitKey = (key: string) => {
  const i = key.indexOf(":");
  return i < 0 ? { host: "", id: key } : { host: key.slice(0, i), id: key.slice(i + 1) };
};
// A workspace id saved before there were hosts is the local daemon's.
export const asKey = (id: string) => (id.includes(":") ? id : keyOf(LOCAL.id, id));

// `hosts` as saved, or the old single `daemon` setting: that host next to this machine's (once, if it's elsewhere).
// No hosts at all is this machine's, and a second host on an address already listed is dropped.
export function readHosts(stored: { hosts?: unknown; daemon?: { url?: string; password?: string } }): Host[] {
  let list: Host[];
  if (Array.isArray(stored.hosts)) {
    list = stored.hosts.flatMap((h, i) =>
      h && typeof h.url === "string" && h.url.trim()
        ? [{ id: String(h.id || `h${i}`).replaceAll(":", ""), label: String(h.label ?? "").trim() || h.url.trim(), url: h.url.trim(), password: String(h.password ?? "") }]
        : [],
    );
  } else {
    const url = stored.daemon?.url?.trim() || DAEMON_URL;
    const password = stored.daemon?.password ?? "";
    list = url === DAEMON_URL ? [{ ...LOCAL, password }] : [LOCAL, { id: "remote", label: url.match(/^\w+:\/\/([^/:]+)/)?.[1] ?? url, url, password }];
  }
  const [urls, ids] = [new Set<string>(), new Set<string>()];
  const out = list.filter((h) => {
    if (urls.has(h.url) || ids.has(h.id)) return false;
    urls.add(h.url);
    ids.add(h.id);
    return true;
  });
  return out.length ? out : [LOCAL];
}

export const loadHosts = async () => readHosts(await chrome.storage.local.get(["hosts", "daemon"]));

export const tagAgent = <A extends Pick<PaseoAgent, "id" | "workspaceId">>(host: string, a: A): A => ({
  ...a,
  id: keyOf(host, a.id),
  workspaceId: a.workspaceId ? keyOf(host, a.workspaceId) : a.workspaceId,
});
export const tagWorkspace = <W extends { id: string }>(host: string, w: W): W => ({ ...w, id: keyOf(host, w.id) });

export let conns: Conn[] = [];

// The client reconnects on its own after a failed connect or a drop, so a host that's down keeps being retried.
export async function connectHosts(clientId: string) {
  conns = (await loadHosts()).map((host) => {
    const daemon = new DaemonClient({ clientId: `${clientId}-${host.id}`, clientType: "browser", url: host.url, password: host.password || undefined });
    return { host, daemon, api: createPaseoApi(daemon) };
  });
  return conns;
}

export const isUp = (c: Conn) => c.daemon.getConnectionState().status === "connected";
export const upConns = () => conns.filter(isUp);
export const multiHost = () => conns.length > 1;

// The host behind a merged id, its client, and the daemon's own id.
export const conn = (host: string) => conns.find((c) => c.host.id === host) ?? conns[0];
export function on(key: string) {
  const { host, id } = splitKey(key);
  return { ...conn(host), id };
}

export const hostLabel = (key: string) => on(key).host.label;

// Every reachable host's workspaces and sessions (archived included), merged; a host that fails is left out.
export async function listSessions() {
  const parts = await Promise.all(
    upConns().map(async ({ host, api }) => {
      const [ws, ag] = await Promise.all([api.workspaces.list(), api.agents.list({ filter: { includeArchived: true } })]);
      return { workspaces: ws.entries.map((w) => tagWorkspace(host.id, w)), all: ag.entries.map((e) => tagAgent(host.id, e.agent)) };
    }).map((p) => p.catch(() => ({ workspaces: [], all: [] }))),
  );
  return { workspaces: parts.flatMap((p) => p.workspaces), all: parts.flatMap((p) => p.all) };
}

// "dev box: can't reach" for each host that isn't connected, while at least one is; null when all are down.
export function hostStatus() {
  const down = conns.filter((c) => !isUp(c));
  if (down.length === conns.length) return null;
  return down.map((c) => `${c.host.label}: can't reach`).join(" · ");
}
