// node scripts/inbox.check.ts
import assert from "node:assert/strict";
import { groupInbox, INBOX_DEFAULTS, matches, orderSections, type InboxRow } from "../src/inbox-view.ts";
import { groupStacks, rowAuthor, rowPr, type StackRow } from "../src/pr.ts";

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

// Author from the subtitle line.
assert.equal(rowAuthor("alice · Acme/widgets #101 1 label 1/4"), "alice");
assert.equal(rowAuthor("dependabot[bot] · acme/widgets #7"), "dependabot[bot]");
assert.equal(rowAuthor(""), undefined);

// Stacks: linked by base = another row's head, within one section and repo, bottom to top; rows alone stay out.
const b = (number: number, base: string, head: string, section = "Review", repo = "widgets"): StackRow => ({ section, owner: "acme", repo, number, base, head });
const stacks = (list: (StackRow | null)[]) => groupStacks(list).map((st) => [st.key, st.rows.map((i) => list[i]!.number)]);
// A chain in any row order; a singleton and an unknown row (no branches) stay out.
assert.deepEqual(stacks([b(103, "b", "c"), b(200, "main", "z"), null, b(101, "main", "a"), b(102, "a", "b")]), [["acme/widgets:a", [101, 102, 103]]]);
// A fork: both children after their base, by number.
assert.deepEqual(stacks([b(303, "a", "c"), b(302, "a", "b"), b(301, "main", "a")]), [["acme/widgets:a", [301, 302, 303]]]);
// Two PRs sharing a head sit together, once each.
assert.deepEqual(stacks([b(401, "main", "a"), b(402, "a", "b"), b(403, "main", "b"), b(404, "b", "c")]), [["acme/widgets:a", [401, 402, 403, 404]]]);
// Split across sections: each section groups its own part; a lone part doesn't group.
assert.deepEqual(stacks([b(501, "main", "a", "Review"), b(502, "a", "b", "Review"), b(503, "b", "c", "Mine"), b(504, "c", "d", "Mine"), b(505, "d", "e", "Drafts")]), [
  ["acme/widgets:a", [501, 502]],
  ["acme/widgets:c", [503, 504]],
]);
// Same branch names in another repo don't link.
assert.deepEqual(stacks([b(601, "main", "a"), b(602, "a", "b", "Review", "gadgets")]), []);

// The panel: a stack's members together where its first one is, bottom to top; off, the page's order.
const srows = [row(10, "Review", 0), row(11, "Review", 0), row(12, "Review", 0), row(13, "Review", 0)];
const st = [{ key: "k", rows: [3, 1] }];
const sview = (o: object) => groupInbox(srows, of, { ...INBOX_DEFAULTS, ...o }, st)[0].prs.map((p) => [p.row.pr.number, p.stack?.pos ?? null]);
assert.deepEqual(sview({}), [[10, null], [13, 0], [11, 1], [12, null]]);
assert.deepEqual(sview({ groupStacks: false }), [[10, null], [11, null], [12, null], [13, null]]);

// Search: case-insensitive, each word somewhere in the fields; "#123" and "123" both find a PR number.
const fields = ["Fix the Login flow", "ABC-12 · #123", "abc-12-fix-login", undefined, null];
for (const q of ["", "  ", "login", "LOGIN", "#123", "123", "abc-12", "fix #123", "flow login"]) assert.ok(matches(q, fields), q);
for (const q of ["#124", "logout", "fix logout"]) assert.ok(!matches(q, fields), q);
// Inbox: a matching PR keeps all its sessions; otherwise only matching sessions keep it; other PRs and emptied sections drop.
const fview = (q: string) =>
  groupInbox(rows, of, INBOX_DEFAULTS, [], { q, fields: (a) => [a.id] }).map((g) => [g.section, g.prs.map((p) => [p.row.pr.number, ...p.sessions.map((a: { id: string }) => a.id)])]);
assert.deepEqual(fview(""), view({}));
assert.deepEqual(fview("pr 2"), [["Review", [[2, "asks", "idle2"]]]]);
assert.deepEqual(fview("#5"), [["Mine", [[5, "idle5"]]]]);
assert.deepEqual(fview("ASKS"), [["Review", [[2, "asks"]]]]);
assert.deepEqual(fview("#2 idle"), [["Review", [[2, "idle2"]]]]);
assert.deepEqual(fview("nothing"), []);
console.log("inbox ok");
