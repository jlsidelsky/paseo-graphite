// node scripts/question.check.ts
import assert from "node:assert/strict";
import { isAnswered, parseQuestions, questionResponse } from "../src/question.ts";

// Claude AskUserQuestion as the daemon hands it over (allowOther injected by Paseo's Claude provider).
const input = {
  questions: [
    { question: "Which database?", header: "DB", multiSelect: false, allowOther: true, options: [{ label: "Postgres", description: "SQL" }, { label: "Redis" }] },
    { question: "Which features?", header: "Features", multiSelect: true, allowOther: true, options: [{ label: "Auth" }, { label: "Billing" }] },
  ],
};
const qs = parseQuestions(input)!;
assert.equal(qs.length, 2);
assert.equal(qs[0].options[0].description, "SQL");
assert.equal(isAnswered(qs[0], { picked: [], text: "  " }), false);
assert.equal(isAnswered(qs[0], { picked: [], text: "MySQL" }), true);

assert.deepEqual(questionResponse(input, qs, [{ picked: ["Postgres"], text: "" }, { picked: ["Auth", "Billing"], text: "" }], false), {
  behavior: "allow",
  updatedInput: { ...input, answers: { DB: "Postgres", Features: "Auth, Billing" } },
});
// Typed "Other" text wins over a pick.
assert.deepEqual(questionResponse(input, qs, [{ picked: ["Redis"], text: " MySQL " }, { picked: [], text: "Search" }], false).updatedInput?.answers, { DB: "MySQL", Features: "Search" });
assert.deepEqual(questionResponse(input, qs, [{ picked: [], text: "" }, { picked: [], text: "" }], true), { behavior: "deny", message: "Dismissed by user" });

// Free-text-only optional forms (Codex) dismiss by submitting empty answers.
const free = { questions: [{ question: "Anything else?", header: "Question 1", options: [], allowEmpty: true }] };
assert.deepEqual(questionResponse(free, parseQuestions(free)!, [{ picked: [], text: "" }], true), { behavior: "allow", updatedInput: { ...free, answers: { "Question 1": "" } } });

assert.equal(parseQuestions({ questions: [{ question: "no header", options: [] }] }), null);
assert.equal(parseQuestions({}), null);
console.log("question ok");
