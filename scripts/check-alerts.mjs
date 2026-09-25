// node scripts/check-alerts.mjs (Node 22.18+ runs the .ts import directly)
import assert from "node:assert/strict";
import { alertFor, ciAlertFor } from "../src/pr.ts";

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

const ci = (checksStatus, number = 1) => ({ number, checksStatus });
assert.equal(ciAlertFor(ci("success"), ci("failure")), true);
assert.equal(ciAlertFor(ci("pending"), ci("failure")), true);
assert.equal(ciAlertFor(ci("none"), ci("failure")), true);
assert.equal(ciAlertFor(undefined, ci("failure")), false); // first sight
assert.equal(ciAlertFor(null, ci("failure")), false); // the workspace just got its PR
assert.equal(ciAlertFor(ci(undefined), ci("failure")), false); // checks not known yet
assert.equal(ciAlertFor(ci("failure"), ci("failure")), false);
assert.equal(ciAlertFor(ci("failure"), ci("pending")), false);
assert.equal(ciAlertFor(ci("success"), ci("pending")), false);
assert.equal(ciAlertFor(ci("success"), null), false);
assert.equal(ciAlertFor(ci("success", 1), ci("failure", 2)), false); // switched to another PR
console.log("ok");
