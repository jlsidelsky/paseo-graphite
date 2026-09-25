// node scripts/inbox.check.ts
import assert from "node:assert/strict";
import { groupInbox, INBOX_DEFAULTS, orderSections, type InboxRow } from "../src/inbox-view.ts";
import { rowPr } from "../src/pr.ts";

// Row → PR: the title link first, in either Graphite form or GitHub's, else the subtitle line.
const pr = { owner: "acme", repo: "widgets", number: 101 };
assert.deepEqual(rowPr("https://app.graphite.com/github/pr/Acme/widgets/101/fix(app)-some-title-(ABC-1)", ""), pr);
assert.deepEqual(rowPr("https://app.graphite.com/github/acme/widgets/pull/101", ""), pr);
assert.deepEqual(rowPr("https://github.com/acme/widgets/pull/101", ""), pr);
assert.deepEqual(rowPr("https://app.graphite.com/", "alice · Acme/widgets #101"), pr);
// Labels and a "1/4" stack position after the number aren't the PR.
assert.deepEqual(rowPr(undefined, "alice · acme/widgets #101 2 labels 1/4"), pr);
assert.deepEqual(rowPr(undefined, "alice · acme/my.widgets-2 #7"), { owner: "acme", repo: "my.widgets-2", number: 7 });
assert.equal(rowPr(undefined, "alice · 1/4"), null);
assert.equal(rowPr(undefined, "alice · acme/widgets #"), null);
assert.equal(rowPr("https://app.graphite.com/settings", undefined), null);

// ponytail: only the fields grouping reads.
const agent = (id: string, o: object = {}) => ({ id, updatedAt: "2026-01-01", status: "idle", pendingPermissions: [], archivedAt: null, ...o }) as never;
const row = (number: number, section: string, sectionIndex: number): InboxRow => ({ pr: { ...pr, number }, title: `PR ${number}`, section, sectionIndex });
const rows = [row(1, "Review", 0), row(2, "Review", 0), row(3, "Review", 0), row(4, "Drafts", 1), row(5, "Mine", 2)];
const sessions: Record<number, never[]> = {
  1: [agent("idle1", { updatedAt: "2026-01-03" })],
  2: [agent("idle2", { updatedAt: "2026-01-02" }), agent("asks", { status: "running", pendingPermissions: [{}] })],
  3: [agent("runs", { status: "running" }), agent("gone", { archivedAt: "2026-01-01" })],
  5: [agent("idle5")],
};
const of = (p: { number: number }) => sessions[p.number] ?? [];
const view = (o: object) =>
  groupInbox(rows, of, { ...INBOX_DEFAULTS, ...o }).map((g) => [g.section, g.prs.map((p) => [p.row.pr.number, ...p.sessions.map((a: { id: string }) => a.id)])]);

// Page order, needs-you sessions first within a PR, archived hidden by default.
assert.deepEqual(view({}), [
  ["Review", [[1, "idle1"], [2, "asks", "idle2"], [3, "runs"]]],
  ["Drafts", [[4]]],
  ["Mine", [[5, "idle5"]]],
]);
// Urgency: needs you, running, then most recent; hidden sections, only PRs with sessions, reordered sections.
assert.deepEqual(view({ sort: "urgency", hidden: ["Mine"], onlyWithSessions: true, order: ["Drafts", "Review"] }), [["Review", [[2, "asks", "idle2"], [3, "runs"], [1, "idle1"]]]]);
// Status filter: archived on, idle off.
assert.deepEqual(view({ show: { needs: true, running: true, idle: false, archived: true }, onlyWithSessions: true }), [["Review", [[2, "asks"], [3, "runs", "gone"]]]]);
// A section the user hasn't placed yet goes after the ones they have, in page order.
assert.deepEqual(orderSections(["Review", "Drafts", "New", "Mine"], { ...INBOX_DEFAULTS, order: ["Mine", "Review"] }), ["Mine", "Review", "Drafts", "New"]);
console.log("inbox ok");
