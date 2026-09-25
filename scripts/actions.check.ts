// node scripts/actions.check.ts
import assert from "node:assert/strict";
import {
  arrange,
  checksText,
  commandArgs,
  commandPreset,
  DEFAULT_PRESETS,
  feedbackPreset,
  fillPrompt,
  inScope,
  isFeedbackCommand,
  isReviewCommand,
  loadStore,
  mergeDraft,
  newDefaultsFor,
  parseHint,
  presetScope,
  presetText,
  prLines,
  readStore,
  saveStore,
  scopeText,
  type Preset,
} from "../src/actions.ts";

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
// Slash-command arguments carry PR numbers, never URLs.
assert.equal(scopeText([20]), "#20");
assert.equal(scopeText([10, 20]), "these PRs as a stack, bottom to top: #10 #20");
const review = fillPrompt(DEFAULT_PRESETS[0].prompt, { prs: prLines(p, scope) });
assert.ok(review.includes(`#10 ${url(10)}\n#20 ${url(20)}\n#30 ${url(30)}`) && !review.includes("{"));

// Scope per preset: its own, else the panel's pick; never empty.
assert.deepEqual(presetScope({}, stack, new Set([20, 40]), 20), [20, 40]);
assert.deepEqual(presetScope({}, stack, new Set(), 20), [20]);
assert.deepEqual(presetScope({ scope: "this" }, stack, new Set([10, 20]), 20), [20]);
assert.deepEqual(presetScope({ scope: "stack" }, stack, new Set([20]), 20), stack);
assert.deepEqual(presetScope({ scope: "stack" }, [], new Set(), 20), [20]);

// ＋ New per action: a review gets a new worktree on the topmost PR; Fix CI and Feedback that PR's workspace.
const ci = DEFAULT_PRESETS.find((x) => x.kind === "ci")!;
assert.deepEqual(newDefaultsFor(DEFAULT_PRESETS[0], [10, 30]), { number: 30, reuse: false, provider: undefined, model: undefined, effort: undefined, mode: undefined });
assert.equal(newDefaultsFor(ci, [10, 30])!.reuse, true);
assert.equal(newDefaultsFor({ ...ci, workspace: "new" }, [10])!.reuse, false);
assert.equal(newDefaultsFor({ ...ci, workspace: "selected" }, [10]), null);
assert.deepEqual(newDefaultsFor({ ...ci, model: "codex/gpt-5", effort: "high", mode: "auto" }, [10]), { number: 10, reuse: true, provider: "codex", model: "codex/gpt-5", effort: "high", mode: "auto" });
assert.equal(newDefaultsFor({ ...ci, provider: "claude" }, [10])!.provider, "claude");

assert.equal(checksText([{ number: 20 }]), "Run `gh pr checks 20` to see which checks fail.");
const failing = [{ name: "lint", status: "failure", url: "https://x/1" }, { name: "e2e", status: "cancelled", url: null }, { name: "ok", status: "success", url: null }];
assert.equal(checksText([{ number: 20, checks: failing }]), "Failing checks:\n- lint: https://x/1\n- e2e");
// Several PRs: per PR, from Paseo's data where a workspace has it, else gh.
assert.equal(checksText([{ number: 10, checks: failing }, { number: 20 }]), "#10: Failing checks:\n- lint: https://x/1\n- e2e\n\n#20: Run `gh pr checks 20` to see which checks fail.");
const vars = (prs: number[]) => ({ pr: "#20", url: url(20), prs: prLines(p, prs), checks: checksText(prs.map((number) => ({ number }))) });
const ciText = presetText(ci, vars([10, 20]), scopeText([10, 20]));
assert.ok(ciText.includes(`#10 ${url(10)}\n#20 ${url(20)}`) && ciText.includes("#10: Run `gh pr checks 10`") && ciText.includes("#20: Run `gh pr checks 20`"));
const evalText = presetText(DEFAULT_PRESETS.find((x) => x.kind === "feedback-evaluate")!, vars([10, 20]));
assert.ok(evalText.includes("latest review comments on each") && evalText.includes(`#10 ${url(10)}\n#20 ${url(20)}`) && !evalText.includes("{"));

// Command presets: /command, the PRs, then extra instructions.
const cr: Preset = { id: "x", kind: "review", label: "CR", command: "code-review", prompt: "Focus on {pr}'s data migrations." };
assert.equal(presetText(cr, vars([20]), scopeText([20])), `/code-review #20\n\nFocus on #20's data migrations.`);
assert.equal(presetText({ ...cr, prompt: "" }, vars([10, 20]), scopeText([10, 20])), "/code-review these PRs as a stack, bottom to top: #10 #20");

// Argument hints: choices, flags and a target slot, in the hint's order; what fits no control goes to the free text.
const hint = "[low|medium|high|xhigh|max|ultra] [--fix] [--comment] [<pr#>|<branch>|<path>]";
const spec = parseHint(hint);
assert.deepEqual(spec, {
  parts: [
    { kind: "choice", key: "low|medium|high|xhigh|max|ultra", options: ["low", "medium", "high", "xhigh", "max", "ultra"], required: false },
    { kind: "flag", key: "--fix" },
    { kind: "flag", key: "--comment" },
    { kind: "target", accepts: ["pr#", "branch", "path"], required: false },
  ],
  extra: "",
});
assert.deepEqual(parseHint(""), { parts: [], extra: "" });
assert.deepEqual(parseHint("add|remove <pr> [--dry-run] [--model <m>] <file> NAME [<notes>...]"), {
  parts: [
    { kind: "choice", key: "add|remove", options: ["add", "remove"], required: true },
    { kind: "target", accepts: ["pr"], required: true },
    { kind: "flag", key: "--dry-run" },
    { kind: "text", key: "<file>", required: true },
    { kind: "text", key: "NAME", required: true },
  ],
  extra: "[--model <m>] [<notes>...]",
});
assert.deepEqual(parseHint("[<branch>]").parts, [{ kind: "target", accepts: ["branch"], required: false }]);

// Composing over a stack of 101..104 (heads alice/a..d), for each scope.
const heads = [101, 102, 103, 104].map((number, i) => ({ number, title: "", head: `alice/${"abcd"[i]}`, base: i ? `alice/${"abcd"[i - 1]}` : "main" }));
const compose = (prs: number[], values = {}, s = spec, stackPrs = heads) => commandArgs("code-review", s, values, stackPrs, prs);
const hc = { "low|medium|high|xhigh|max|ultra": "high", "--comment": true, "--fix": false };
assert.deepEqual(compose([102], hc), { args: "high --comment 102", target: "102", note: undefined });
// A range from the bottom is its top branch, which diffs against trunk.
assert.deepEqual(compose([101, 102, 103], hc), { args: "high --comment alice/c", target: "alice/c", note: undefined });
assert.equal(compose([101, 102, 103, 104]).args, "alice/d");
// Anything else can't be one target: the topmost PR, with a note.
assert.deepEqual(compose([102, 103], hc), { args: "high --comment 103", target: "103", note: "/code-review takes one target; using #103" });
assert.equal(compose([101, 103]).note, "/code-review takes one target; using #103");
// No branch known (the stack hasn't loaded): the number, noted.
assert.equal(compose([101, 102], {}, spec, []).args, "102");
// A slot that takes a PR but no branch: the topmost PR even for a range from the bottom.
assert.deepEqual(compose([101, 102], {}, parseHint("[<pr#>]")), { args: "102", target: "102", note: "/code-review takes one target; using #102" });
// A branch-only slot takes one PR's branch too.
assert.equal(compose([102], {}, parseHint("[<branch>]")).args, "alice/b");
// A slot that takes neither is free text; the extra box always goes last.
assert.deepEqual(compose([102], { "<path>": "src", extra: "be brief" }, parseHint("[<path>] [--fix]")), { args: "src be brief", target: undefined, note: undefined });
// No hint: the PRs in scope as numbers, then the free text.
assert.equal(compose([102], { extra: "focus on auth" }, parseHint("")).args, "#102 focus on auth");
assert.equal(compose([101, 102], {}, parseHint(undefined)).args, "these PRs as a stack, bottom to top: #101 #102");
// A saved favorite ("/code-review high --comment") fills the same way.
const fav: Preset = { id: "f", kind: "review", label: "Strict", command: "code-review", prompt: "", args: hc };
assert.equal(presetText(fav, vars([104]), compose([104], fav.args).args), "/code-review high --comment 104");

// Menus: hidden out, favorites first, then order, then as listed.
const item = (id: string, extra: Partial<Preset> = {}): Preset => ({ id, kind: "review", label: id, prompt: "x", ...extra });
assert.deepEqual(
  arrange([item("a"), item("b", { order: 2 }), item("c", { hidden: true }), item("d", { favorite: true }), item("e", { order: 1 }), item("f")]).map((x) => x.id),
  ["d", "e", "b", "a", "f"],
);
// Discovered commands take their override (keyed provider:name): renamed, favorited, hidden.
const found = { name: "code-review", description: "Review the diff", provider: "claude" };
assert.deepEqual(commandPreset({ ...found, argumentHint: "[--fix]" }, "review", {}), { id: "claude:code-review", kind: "review", label: "/code-review", command: "code-review", provider: "claude", prompt: "", description: "Review the diff", argumentHint: "[--fix]" });
const renamed = commandPreset(found, "review", { "claude:code-review": { label: "Deep review", favorite: true, prompt: "be strict" }, "codex:code-review": { hidden: true } });
assert.ok(renamed.label === "Deep review" && renamed.favorite && renamed.command === "code-review" && renamed.provider === "claude");
assert.equal(arrange([commandPreset({ ...found, provider: "codex" }, "review", { "codex:code-review": { hidden: true } })]).length, 0);

// Names and descriptions as Claude and Codex report them.
const cmd = (name: string, description = "") => ({ name, description });
assert.ok(isReviewCommand(cmd("code-review", "Review the current diff, or a PR number")));
assert.ok(isReviewCommand(cmd("grill:grill", "(grill) Adversarial code review")));
assert.ok(!isReviewCommand(cmd("openai-templates:artifact-template-business-review", "Create a presentation using the Business Review template")));
assert.ok(!isReviewCommand(cmd("pr-review-response", "Evaluates every reviewer comment on a given PR")));
assert.ok(isFeedbackCommand(cmd("pr-review-response")) && isFeedbackCommand(cmd("assess-feedback")) && !isFeedbackCommand(cmd("code-review")));

// Per-comment: a favorite first; else a fitting skill beats a shipped preset; an edited preset beats the skill.
const skills = [{ ...cmd("pr-review-response"), provider: "codex" }, { ...cmd("assess-feedback"), provider: "claude" }];
const comment = { pr: "#20", url: url(20), prs: prLines(p, [20]), comment: "> nit" };
const defaults = { presets: DEFAULT_PRESETS, overrides: {} };
const pick = (kind: "feedback-evaluate" | "feedback-address", s: typeof defaults, cmds = skills) => {
  const x = feedbackPreset(kind, s, cmds);
  return { text: presetText(x, comment, comment.comment), provider: x.provider };
};
assert.deepEqual(pick("feedback-evaluate", defaults), { text: "/assess-feedback > nit", provider: "claude" });
assert.deepEqual(pick("feedback-address", defaults), { text: "/pr-review-response > nit", provider: "codex" });
const mine = { presets: [item("m", { kind: "feedback-evaluate", provider: "codex", prompt: "Judge {comment} on {pr}" })], overrides: {} };
assert.deepEqual(pick("feedback-evaluate", mine), { text: "Judge > nit on #20", provider: "codex" });
// A favorited shipped preset beats the skill; a favorited skill beats an edited preset; a hidden skill is skipped.
assert.equal(pick("feedback-evaluate", { presets: DEFAULT_PRESETS.map((x) => ({ ...x, favorite: true })), overrides: {} }).provider, undefined);
assert.deepEqual(pick("feedback-evaluate", { ...mine, overrides: { "claude:assess-feedback": { favorite: true, prompt: "Be brief." } } }), { text: "/assess-feedback > nit\n\nBe brief.", provider: "claude" });
assert.deepEqual(pick("feedback-evaluate", { ...defaults, overrides: { "claude:assess-feedback": { hidden: true } } }), { text: "/pr-review-response > nit", provider: "codex" });
const plain = pick("feedback-evaluate", defaults, []);
assert.ok(plain.text.includes(url(20)) && plain.text.endsWith("> nit") && plain.provider === undefined);

// Storage: the old single array migrates to one sync item per preset, its shipped prompts to today's, nothing lost.
const legacy = [
  { label: "Mine", kind: "review", provider: "codex", prompt: "Look at {prs}" },
  { label: "Fix CI", kind: "ci", prompt: "Fix the failing CI checks on PR {pr} ({url}).\n\n{checks}\n\nRead each failing job's logs, find the root cause, fix it and push. Don't skip or disable checks." },
];
const area = (data: Record<string, unknown>) => ({
  data,
  get: async () => structuredClone(data),
  set: async (v: Record<string, unknown>) => void Object.assign(data, structuredClone(v)),
  remove: async (keys: string | string[]) => [keys].flat().forEach((k) => delete data[k]),
});
const old = area({ presets: legacy, notify: false });
// why `as unknown as`: the fake implements only the calls loadStore makes, not chrome's overloads.
const migrated = await loadStore(old as unknown as Parameters<typeof loadStore>[0]);
assert.deepEqual(migrated.presets.map((x) => [x.id, x.label, x.provider]), [["m0", "Mine", "codex"], ["m1", "Fix CI", undefined]]);
assert.equal(migrated.presets[1].prompt, ci.prompt);
assert.deepEqual(Object.keys(old.data).sort(), ["notify", "preset:m0", "preset:m1", "presetIds"]);
assert.deepEqual(readStore(old.data), migrated);
assert.deepEqual(readStore({}).presets, DEFAULT_PRESETS);
assert.deepEqual(readStore({ presetIds: [] }).presets, []);
// Saving drops deleted presets and emptied overrides, keeps other settings.
await saveStore(old as unknown as Parameters<typeof saveStore>[0], { presets: [migrated.presets[0]], overrides: { "claude:code-review": { favorite: true }, "codex:x": {} } });
assert.deepEqual(Object.keys(old.data).sort(), ["cmd:claude:code-review", "notify", "preset:m0", "presetIds"]);
assert.deepEqual(readStore(old.data).overrides, { "claude:code-review": { favorite: true } });

// Composer: drafts survive, slash commands stay first, the same command isn't repeated.
assert.equal(mergeDraft("  ", "/code-review x"), "/code-review x");
assert.equal(mergeDraft("draft", "plain"), "draft\n\nplain");
assert.equal(mergeDraft("draft", "/code-review x"), "/code-review x\n\ndraft");
assert.equal(mergeDraft("/assess-feedback > a", "/assess-feedback > b"), "/assess-feedback > a\n\n> b");
assert.equal(mergeDraft("/assess-feedbackx", "/assess-feedback > b"), "/assess-feedback > b\n\n/assess-feedbackx");
console.log("actions ok");
