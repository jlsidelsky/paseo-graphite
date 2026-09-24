// node scripts/check-alerts.mjs (Node 22.18+ runs the .ts import directly)
import assert from "node:assert/strict";
import { alertFor } from "../src/pr.ts";

const s = (status, permissions = 0, archivedAt = null) => ({ status, pendingPermissions: Array(permissions).fill({}), archivedAt });

assert.equal(alertFor(undefined, s("idle")), null);
assert.equal(alertFor(s("running"), s("running")), null);
assert.equal(alertFor(s("running"), s("idle")), "done");
assert.equal(alertFor(s("running"), s("error")), "done");
assert.equal(alertFor(s("idle"), s("running")), null);
assert.equal(alertFor(s("running"), s("running", 1)), "needs-you");
assert.equal(alertFor(s("running", 1), s("running", 2)), null);
assert.equal(alertFor(s("running"), s("idle", 1)), "needs-you");
assert.equal(alertFor(s("running"), s("closed", 0, "2026-01-01")), null);
console.log("ok");
