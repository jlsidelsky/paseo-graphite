// node scripts/contexts.check.ts
import assert from "node:assert/strict";
import { agentsOnTicket, branchHasTicket, groupAll, parseTicket, ticketBranch, ticketTitle } from "../src/pr.ts";

assert.deepEqual(parseTicket("https://linear.app/granted/issue/eng-8574/store-the-thing?x=1"), {
  id: "ENG-8574",
  url: "https://linear.app/granted/issue/eng-8574/store-the-thing",
});
assert.equal(parseTicket("https://linear.app/granted/issue/ENG-12")?.id, "ENG-12");
assert.equal(parseTicket("https://linear.app/granted/project/foo"), null);
assert.equal(parseTicket("https://graphite.com/github/pr/a/b/1"), null);

assert.ok(branchHasTicket("joshsidelsky/eng-8574-store-the-thing", "ENG-8574"));
assert.ok(branchHasTicket("ENG-8574", "ENG-8574"));
assert.ok(!branchHasTicket("joshsidelsky/eng-85741-other", "ENG-8574"));
assert.ok(!branchHasTicket("joshsidelsky/xeng-8574", "ENG-8574"));
assert.ok(!branchHasTicket(null, "ENG-8574"));

assert.equal(ticketBranch({ id: "ENG-8574", url: "https://linear.app/g/issue/ENG-8574/store-the-thing" }), "eng-8574-store-the-thing");
assert.equal(ticketBranch({ id: "ENG-8574", url: "https://linear.app/g/issue/ENG-8574" }), "eng-8574");
assert.equal(ticketBranch({ id: "ENG-8574", url: "https://linear.app/g/issue/ENG-8574/x", branch: "josh/eng-8574-x" }), "josh/eng-8574-x");

assert.equal(ticketTitle("ENG-8574 Store the thing – Linear", "ENG-8574"), "Store the thing");
assert.equal(ticketTitle("ENG-8574: A - B | Linear", "ENG-8574"), "A - B");
assert.equal(ticketTitle(undefined, "ENG-1"), "");

// ponytail: only the fields these helpers read.
const agent = (id: string, o: object) => ({ id, updatedAt: "2026-01-01", status: "idle", pendingPermissions: [], labels: {}, archivedAt: null, ...o }) as never;
const ws = (id: string, branch: string | null, head?: string) => ({ id, gitRuntime: { currentBranch: branch }, githubRuntime: head ? { pullRequest: { headRefName: head } } : null }) as never;
const agents = [
  agent("onBranch", { workspaceId: "w1" }),
  agent("onPrHead", { workspaceId: "w3" }),
  agent("labelled", { labels: { "ticket:ENG-8574": "2026-09-24" } }),
  agent("mentions", { workspaceId: "w2", title: "Fix ENG-8574" }),
];
const found = agentsOnTicket([ws("w1", "josh/eng-8574-a"), ws("w2", "josh/other"), ws("w3", null, "eng-8574-b")], agents, "ENG-8574");
assert.deepEqual(found.map((a: { id: string }) => a.id).sort(), ["labelled", "onBranch", "onPrHead"]);

const g = groupAll([
  agent("asks", { status: "running", pendingPermissions: [{}] }),
  agent("runs", { status: "running" }),
  agent("old", { updatedAt: "2026-01-01" }),
  agent("new", { updatedAt: "2026-02-01" }),
  agent("gone", { archivedAt: "2026-02-02" }),
]);
const ids = (l: { id: string }[]) => l.map((a) => a.id);
assert.deepEqual([ids(g.needs), ids(g.running), ids(g.finished)], [["asks"], ["runs"], ["new", "old"]]);
console.log("contexts ok");
