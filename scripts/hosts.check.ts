// node scripts/hosts.check.ts
import assert from "node:assert/strict";
import { asKey, DAEMON_URL, keyOf, LOCAL, readHosts, splitKey, tagAgent, tagWorkspace } from "../src/hosts.ts";

// Nothing saved: this machine.
assert.deepEqual(readHosts({}), [LOCAL]);
// The old single setting on this machine keeps its password.
assert.deepEqual(readHosts({ daemon: { url: "", password: "pw" } }), [{ ...LOCAL, password: "pw" }]);
assert.deepEqual(readHosts({ daemon: { url: DAEMON_URL } }), [LOCAL]);
// ...elsewhere, it joins this machine's.
assert.deepEqual(readHosts({ daemon: { url: " ws://devbox:6767/ws ", password: "pw" } }), [
  LOCAL,
  { id: "remote", label: "devbox", url: "ws://devbox:6767/ws", password: "pw" },
]);
// A saved list wins over the old setting; blank addresses go, labels default to the address, ids lose ":".
const dev = { id: "dev", label: "dev box", url: "wss://devbox/ws", password: "x" };
assert.deepEqual(readHosts({ hosts: [dev, { id: "y", label: "", url: " " }, { id: "a:b", url: "ws://other/ws" }], daemon: { url: "ws://ignored/ws" } }), [
  dev,
  { id: "ab", label: "ws://other/ws", url: "ws://other/ws", password: "" },
]);
// This machine can be removed; an empty list falls back to it; the same address or id twice is listed once.
assert.deepEqual(readHosts({ hosts: [dev] }), [dev]);
assert.deepEqual(readHosts({ hosts: [] }), [LOCAL]);
assert.deepEqual(readHosts({ hosts: [LOCAL, { ...LOCAL, id: "again", label: "twice" }, { ...dev, id: "local" }] }), [LOCAL]);

// Keys.
assert.equal(keyOf("dev", "wks_1"), "dev:wks_1");
assert.deepEqual(splitKey("dev:a:b"), { host: "dev", id: "a:b" });
assert.deepEqual(splitKey("bare"), { host: "", id: "bare" });
assert.equal(asKey("wks_1"), "local:wks_1");
assert.equal(asKey("dev:wks_1"), "dev:wks_1");

// The same ids on two hosts stay apart once tagged, and a session still points at its own host's workspace.
const agent = { id: "a1", workspaceId: "w1", title: "t" };
const [local, remote] = [tagAgent("local", agent), tagAgent("dev", agent)];
assert.notEqual(local.id, remote.id);
assert.equal(remote.workspaceId, tagWorkspace("dev", { id: "w1" }).id);
assert.equal(remote.title, "t");
assert.equal(tagAgent("dev", { id: "a2", workspaceId: null }).workspaceId, null);
assert.equal(agent.id, "a1", "tagging copies");

console.log("hosts ok");
