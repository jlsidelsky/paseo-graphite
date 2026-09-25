// node scripts/actions.check.ts
import assert from "node:assert/strict";
import { checksText, DEFAULT_PRESETS, feedbackPrompt, fillPrompt, inScope, isFeedbackCommand, isReviewCommand, mergeDraft, prLines, scopeText } from "../src/actions.ts";

const p = { owner: "cli", repo: "cli", number: 20 };
const url = (n: number) => `https://github.com/cli/cli/pull/${n}`;

assert.equal(fillPrompt("Fix {pr} ({url}){comment}\n\n\n\n{checks} {nope}", { pr: "#20", url: url(20) }), `Fix #20 (${url(20)})\n\n {nope}`);

// Scope: stack order kept whatever order PRs were ticked in; the top of the range is the branch to check out.
const stack = [10, 20, 30, 40];
const scope = inScope(stack, new Set([30, 10, 20]));
assert.deepEqual(scope, [10, 20, 30]);
assert.equal(scope.at(-1), 30);
assert.deepEqual(inScope(stack, new Set([99])), []);
assert.equal(prLines(p, [10, 20]), `#10 ${url(10)}\n#20 ${url(20)}`);
assert.equal(scopeText(p, [20]), url(20));
assert.equal(scopeText(p, [10, 20]), `these PRs as a stack, bottom to top:\n#10 ${url(10)}\n#20 ${url(20)}`);
const review = fillPrompt(DEFAULT_PRESETS[0].prompt, { prs: prLines(p, scope) });
assert.ok(review.includes(`#10 ${url(10)}\n#20 ${url(20)}\n#30 ${url(30)}`) && !review.includes("{"));

assert.equal(checksText(undefined, 20), "Run `gh pr checks 20` to see which checks fail.");
assert.equal(
  checksText([{ name: "lint", status: "failure", url: "https://x/1" }, { name: "e2e", status: "cancelled", url: null }, { name: "ok", status: "success", url: null }], 20),
  "Failing checks:\n- lint: https://x/1\n- e2e",
);

// Names and descriptions as Claude and Codex report them.
const cmd = (name: string, description = "") => ({ name, description });
assert.ok(isReviewCommand(cmd("code-review", "Review the current diff, or a PR number")));
assert.ok(isReviewCommand(cmd("grill:grill", "(grill) Adversarial code review")));
assert.ok(!isReviewCommand(cmd("openai-templates:artifact-template-business-review", "Create a presentation using the Business Review template")));
assert.ok(!isReviewCommand(cmd("pr-review-response", "Evaluates every reviewer comment on a given PR")));
assert.ok(isFeedbackCommand(cmd("pr-review-response")) && isFeedbackCommand(cmd("assess-feedback")) && !isFeedbackCommand(cmd("code-review")));

// Per-comment: a fitting skill beats a shipped preset; an edited preset beats the skill.
const skills = [{ ...cmd("pr-review-response"), provider: "codex" }, { ...cmd("assess-feedback"), provider: "claude" }];
const vars = { pr: "#20", url: url(20), comment: "> nit" };
assert.deepEqual(feedbackPrompt("feedback-evaluate", DEFAULT_PRESETS, skills, vars), { text: "/assess-feedback > nit", provider: "claude" });
assert.deepEqual(feedbackPrompt("feedback-address", DEFAULT_PRESETS, skills, vars), { text: "/pr-review-response > nit", provider: "codex" });
const mine = [{ label: "Mine", kind: "feedback-evaluate" as const, provider: "codex", prompt: "Judge {comment} on {pr}" }];
assert.deepEqual(feedbackPrompt("feedback-evaluate", mine, skills, vars), { text: "Judge > nit on #20", provider: "codex" });
const plain = feedbackPrompt("feedback-evaluate", DEFAULT_PRESETS, [], vars);
assert.ok(plain.text.includes(url(20)) && plain.text.endsWith("> nit") && plain.provider === undefined);

// Composer: drafts survive, slash commands stay first, the same command isn't repeated.
assert.equal(mergeDraft("  ", "/code-review x"), "/code-review x");
assert.equal(mergeDraft("draft", "plain"), "draft\n\nplain");
assert.equal(mergeDraft("draft", "/code-review x"), "/code-review x\n\ndraft");
assert.equal(mergeDraft("/assess-feedback > a", "/assess-feedback > b"), "/assess-feedback > a\n\n> b");
assert.equal(mergeDraft("/assess-feedbackx", "/assess-feedback > b"), "/assess-feedback > b\n\n/assess-feedbackx");
console.log("actions ok");
