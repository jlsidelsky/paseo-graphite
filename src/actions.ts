// PR actions (Review, Fix CI, Feedback): prompt presets, placeholder filling, and which slash commands count.
import type { Pr } from "./pr";

export type PresetKind = "review" | "ci" | "feedback-evaluate" | "feedback-address";
export type Preset = { label: string; kind: PresetKind; provider?: string; prompt: string };
export type Vars = Partial<Record<"pr" | "url" | "prs" | "comment" | "checks", string>>;
export type Check = { name: string; status: string; url: string | null };
type Command = { name: string; description?: string };

export const PRESET_KINDS: PresetKind[] = ["review", "ci", "feedback-evaluate", "feedback-address"];

export const DEFAULT_PRESETS: Preset[] = [
  {
    label: "Review",
    kind: "review",
    prompt:
      "Review these pull requests, listed bottom to top. If there's more than one, they form a stack: review them together, each on top of the one below it.\n{prs}\n\nLook for correctness bugs, security issues and missing tests. Report findings by severity with file and line. Don't change any code.",
  },
  {
    label: "Fix CI",
    kind: "ci",
    prompt:
      "Fix the failing CI checks on PR {pr} ({url}).\n\n{checks}\n\nRead each failing job's logs, find the root cause, fix it and push. Don't skip or disable checks.",
  },
  {
    label: "Evaluate latest feedback",
    kind: "feedback-evaluate",
    prompt:
      "Evaluate the review feedback on PR {pr} ({url}): the comment quoted below, or if none is quoted, the latest review comments. For each, say whether it's valid and why, checking the claim against the code. Don't change any code yet.\n\n{comment}",
  },
  {
    label: "Address all feedback",
    kind: "feedback-address",
    prompt:
      "Address the review feedback on PR {pr} ({url}): the comment quoted below, or if none is quoted, all open review comments. Check each claim against the code, fix what's valid, and reply to each thread saying what changed or why not, resolving the ones you fixed.\n\n{comment}",
  },
];

export const fillPrompt = (template: string, vars: Vars) =>
  template
    .replace(/\{(pr|url|prs|comment|checks)\}/g, (_, k: keyof Vars) => vars[k] ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const prUrl = (p: Pr, n = p.number) => `https://github.com/${p.owner}/${p.repo}/pull/${n}`;
export const prLines = (p: Pr, numbers: number[]) => numbers.map((n) => `#${n} ${prUrl(p, n)}`).join("\n");

// The arguments after a slash command: one PR's URL, or the stack.
export const scopeText = (p: Pr, numbers: number[]) =>
  numbers.length === 1 ? prUrl(p, numbers[0]) : `these PRs as a stack, bottom to top:\n${prLines(p, numbers)}`;

// Picked PRs in stack order (bottom to top); the last one's branch contains all the others.
export const inScope = (stack: number[], picked: Set<number>) => stack.filter((n) => picked.has(n));

export function checksText(checks: Check[] | undefined, n: number) {
  const failing = checks?.filter((c) => c.status === "failure" || c.status === "cancelled") ?? [];
  return failing.length
    ? `Failing checks:\n${failing.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ""}`).join("\n")}`
    : `Run \`gh pr checks ${n}\` to see which checks fail.`;
}

export const isFeedbackCommand = (c: Command) => /feedback|review-response/i.test(c.name);
// "review" in the name isn't enough: Codex ships presentation templates called business-review.
export const isReviewCommand = (c: Command) =>
  !isFeedbackCommand(c) && /review|grill/i.test(c.name) && /\b(code|pr|diff|changes?|branch)\b/i.test(c.description ?? "");

// Skills that fit a per-comment feedback action, best first.
const FEEDBACK_SKILLS: Record<string, string[]> = {
  "feedback-evaluate": ["assess-feedback", "pr-review-response"],
  "feedback-address": ["pr-review-response"],
};

const isCustomized = (p: Preset) => !DEFAULT_PRESETS.some((d) => d.prompt === p.prompt);

// A fitting skill wins over a shipped preset; a preset the user wrote or edited wins over the skill.
export function feedbackPrompt<C extends Command & { provider?: string }>(
  kind: "feedback-evaluate" | "feedback-address",
  presets: Preset[],
  commands: C[],
  vars: Vars,
): { text: string; provider?: string } {
  const preset = presets.find((p) => p.kind === kind) ?? DEFAULT_PRESETS.find((p) => p.kind === kind)!;
  const skill = FEEDBACK_SKILLS[kind].map((s) => commands.find((c) => c.name === s || c.name.endsWith(`:${s}`))).find(Boolean);
  if (skill && !isCustomized(preset)) return { text: `/${skill.name} ${vars.comment || vars.url || ""}`.trim(), provider: skill.provider };
  return { text: fillPrompt(preset.prompt, vars), provider: preset.provider };
}

// Adds an action's text to the composer without losing a draft. A slash command only works first in the
// message, so it goes on top; the same command twice keeps one and appends the new arguments.
export function mergeDraft(current: string, add: string) {
  const cur = current.trim();
  if (!cur) return add;
  const cmd = add.match(/^\/\S+/)?.[0];
  if (!cmd) return `${cur}\n\n${add}`;
  if (cur === cmd || cur.startsWith(`${cmd} `) || cur.startsWith(`${cmd}\n`)) return `${cur}\n\n${add.slice(cmd.length).trim()}`;
  return `${add}\n\n${cur}`;
}
