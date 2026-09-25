// PR actions (Review, Fix CI, Feedback): prompt presets, their storage, placeholder filling, and which slash commands count.
import type { Pr, StackPr } from "./pr";

export type PresetKind = "review" | "ci" | "feedback-evaluate" | "feedback-address";
// "ask" opens the Choose PRs picker first. Unset: whatever the panel's scope control says.
export type Scope = "this" | "stack" | "ask";
// Where the session runs: ＋ New on a new worktree or the PR's existing workspace, or the session already selected.
export type WorkspacePref = "new" | "existing" | "selected";
export type Preset = {
  id: string;
  kind: PresetKind;
  label: string;
  // A slash command (no "/"); `prompt` then holds extra instructions after its arguments.
  command?: string;
  prompt: string;
  provider?: string;
  // "<provider>/<model id>", as the panel's model picker keys them.
  model?: string;
  effort?: string;
  mode?: string;
  scope?: Scope;
  // A command's argument values, as parseHint's controls key them.
  args?: ArgValues;
  workspace?: WorkspacePref;
  favorite?: boolean;
  hidden?: boolean;
  order?: number;
};
// What the options page can change on a discovered command, keyed by `provider:commandName`.
export type Override = Partial<Omit<Preset, "id" | "kind" | "command" | "provider">>;
export type Store = { presets: Preset[]; overrides: Record<string, Override> };
export type Vars = Partial<Record<"pr" | "url" | "prs" | "comment" | "checks", string>>;
export type Check = { name: string; status: string; url: string | null };
type Command = { name: string; description?: string; argumentHint?: string };
export type Found = Command & { provider: string };
// The panel's last review and feedback commands per provider, in chrome.storage.local for the options page.
export type DiscoveredCache = Record<string, { label: string; commands: (Command & { kind: "review" | "feedback" })[] }>;

export const PRESET_KINDS: PresetKind[] = ["review", "ci", "feedback-evaluate", "feedback-address"];

export const DEFAULT_PRESETS: Preset[] = [
  {
    id: "review",
    label: "Review",
    kind: "review",
    prompt:
      "Review these pull requests, listed bottom to top. If there's more than one, they form a stack: review them together, each on top of the one below it.\n{prs}\n\nLook for correctness bugs, security issues and missing tests. Report findings by severity with file and line. Don't change any code.",
  },
  {
    id: "ci",
    label: "Fix CI",
    kind: "ci",
    prompt:
      "Fix the failing CI checks on these pull requests, listed bottom to top. If there's more than one, they form a stack: fix from the bottom up.\n{prs}\n\n{checks}\n\nRead each failing job's logs, find the root cause, fix it and push. Don't skip or disable checks.",
  },
  {
    id: "evaluate",
    label: "Evaluate latest feedback",
    kind: "feedback-evaluate",
    prompt:
      "Evaluate the review feedback on these pull requests: the comment quoted below, or if none is quoted, the latest review comments on each.\n{prs}\n\nFor each, say whether it's valid and why, checking the claim against the code. Don't change any code yet.\n\n{comment}",
  },
  {
    id: "address",
    label: "Address all feedback",
    kind: "feedback-address",
    prompt:
      "Address the review feedback on these pull requests: the comment quoted below, or if none is quoted, all open review comments on each.\n{prs}\n\nCheck each claim against the code, fix what's valid, and reply to each thread saying what changed or why not, resolving the ones you fixed.\n\n{comment}",
  },
];

// The shipped prompts from before scope covered Fix CI and Feedback; a saved copy of one is still "unedited".
const LEGACY_DEFAULTS: Partial<Record<PresetKind, string>> = {
  ci: "Fix the failing CI checks on PR {pr} ({url}).\n\n{checks}\n\nRead each failing job's logs, find the root cause, fix it and push. Don't skip or disable checks.",
  "feedback-evaluate":
    "Evaluate the review feedback on PR {pr} ({url}): the comment quoted below, or if none is quoted, the latest review comments. For each, say whether it's valid and why, checking the claim against the code. Don't change any code yet.\n\n{comment}",
  "feedback-address":
    "Address the review feedback on PR {pr} ({url}): the comment quoted below, or if none is quoted, all open review comments. Check each claim against the code, fix what's valid, and reply to each thread saying what changed or why not, resolving the ones you fixed.\n\n{comment}",
};

// chrome.storage.sync caps each item at 8 KB, so each preset and each command override is its own item
// (`preset:<id>`, `cmd:<provider>:<name>`) and `presetIds` keeps their order. Before, one `presets` array held them all.
type Area = Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function readStore(all: Record<string, unknown>): Store {
  const overrides = Object.fromEntries(Object.entries(all).filter(([k, v]) => k.startsWith("cmd:") && isObject(v)).map(([k, v]) => [k.slice(4), v as Override]));
  if (Array.isArray(all.presetIds)) return { presets: all.presetIds.map((id) => all[`preset:${id}`]).filter(isObject) as Preset[], overrides };
  if (!Array.isArray(all.presets)) return { presets: DEFAULT_PRESETS, overrides };
  const presets = (all.presets.filter(isObject) as Omit<Preset, "id">[]).map((p, i) => {
    const shipped = p.prompt === LEGACY_DEFAULTS[p.kind] && DEFAULT_PRESETS.find((d) => d.kind === p.kind);
    return { ...p, id: `m${i}`, ...(shipped ? { prompt: shipped.prompt } : {}) };
  });
  return { presets, overrides };
}

export async function saveStore(area: Area, s: Store) {
  const old = Object.keys(await area.get(null));
  const next: Record<string, unknown> = { presetIds: s.presets.map((p) => p.id) };
  for (const p of s.presets) next[`preset:${p.id}`] = p;
  for (const [k, o] of Object.entries(s.overrides)) if (Object.keys(o).length) next[`cmd:${k}`] = o;
  const stale = old.filter((k) => k === "presets" || ((k.startsWith("preset:") || k.startsWith("cmd:")) && !(k in next)));
  await area.set(next);
  if (stale.length) await area.remove(stale);
}

// Moves the old single-array shape to one item per preset on first read.
export async function loadStore(area: Area) {
  const all = await area.get(null);
  const s = readStore(all);
  if (Array.isArray(all.presets) && !Array.isArray(all.presetIds)) await saveStore(area, s).catch(() => {});
  return s;
}

// Visible entries, favorites first, then by `order`, else as listed.
export function arrange<T extends Preset>(items: T[]): T[] {
  const rank = (p: Preset) => p.order ?? Infinity;
  return items
    .filter((p) => !p.hidden)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Number(!!b.p.favorite) - Number(!!a.p.favorite) || rank(a.p) - rank(b.p) || a.i - b.i)
    .map(({ p }) => p);
}

export const commandKey = (c: Found) => `${c.provider}:${c.name}`;

// A discovered command as a menu entry, with the user's rename, placement and defaults applied.
export const commandPreset = (c: Found, kind: PresetKind, overrides: Record<string, Override>): Preset & { description?: string; argumentHint?: string } => ({
  id: commandKey(c),
  kind,
  label: `/${c.name}`,
  command: c.name,
  provider: c.provider,
  prompt: "",
  description: c.description,
  argumentHint: c.argumentHint,
  ...overrides[commandKey(c)],
});

export const fillPrompt = (template: string, vars: Vars) =>
  template
    .replace(/\{(pr|url|prs|comment|checks)\}/g, (_, k: keyof Vars) => vars[k] ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// A command preset is `/command <args>` then its extra instructions; any other preset is its filled template.
export function presetText(p: Preset, vars: Vars, args = "") {
  const text = fillPrompt(p.prompt, vars);
  return p.command ? [`/${p.command} ${args}`.trim(), text].filter(Boolean).join("\n\n") : text;
}

export const prUrl = (p: Pr, n = p.number) => `https://github.com/${p.owner}/${p.repo}/pull/${n}`;
export const prLines = (p: Pr, numbers: number[]) => numbers.map((n) => `#${n} ${prUrl(p, n)}`).join("\n");

// The arguments after a slash command with no argument hint: PR numbers, never URLs.
export const scopeText = (numbers: number[]) =>
  numbers.length === 1 ? `#${numbers[0]}` : `these PRs as a stack, bottom to top: ${numbers.map((n) => `#${n}`).join(" ")}`;

// ---- Argument hints, like "[low|high] [--fix] [<pr#>|<branch>]", as form controls. ----

export type ArgValues = Record<string, string | boolean>;
export type ArgPart =
  | { kind: "choice"; key: string; options: string[]; required: boolean }
  | { kind: "flag"; key: string }
  | { kind: "target"; accepts: string[]; required: boolean }
  | { kind: "text"; key: string; required: boolean };
// `extra`: the parts of the hint that fit no control, shown as the free-text box's placeholder.
export type ArgSpec = { parts: ArgPart[]; extra: string };

const isPrAlt = (a: string) => /^pr\b|^#|number/i.test(a);
const isBranchAlt = (a: string) => /branch/i.test(a);

// ponytail: one level of brackets; a nested group like "[--model [x]]" lands in `extra`.
export function parseHint(hint = ""): ArgSpec {
  const parts: ArgPart[] = [];
  const extra: string[] = [];
  for (const [whole, inner, bare] of hint.matchAll(/\[([^\]]*)\]|(\S+)/g)) {
    const body = (inner ?? bare).trim();
    const alts = body.split("|").map((a) => a.trim());
    const required = bare !== undefined;
    if (/^--?[\w-]+$/.test(body) && !required) parts.push({ kind: "flag", key: body });
    else if (alts.every((a) => /^<[^<>]+>$/.test(a))) {
      const accepts = alts.map((a) => a.slice(1, -1));
      parts.push(accepts.some((a) => isPrAlt(a) || isBranchAlt(a)) ? { kind: "target", accepts, required } : { kind: "text", key: body, required });
    } else if (alts.every((a) => /^-{0,2}[\w.-]+$/.test(a)) && (alts.length > 1 || !required)) parts.push({ kind: "choice", key: body, options: alts, required });
    else if (required && /^[\w.-]+$/.test(body)) parts.push({ kind: "text", key: body, required });
    else extra.push(whole);
  }
  return { parts, extra: extra.join(" ") };
}

// The one value a target slot takes for the PRs in scope (bottom to top). A range from the stack's bottom is its top
// branch, which diffs against trunk; any other set can't be one target, so it's the topmost PR, with a note saying so.
export function targetFor(command: string, accepts: string[], stack: StackPr[], prs: number[]): { value: string; note?: string } {
  const top = prs.at(-1)!;
  const head = stack.find((s) => s.number === top)?.head;
  const pr = accepts.some(isPrAlt);
  const branch = !!head && accepts.some(isBranchAlt);
  if (branch && (prs.length === 1 ? !pr : prs.every((n, i) => stack[i]?.number === n))) return { value: head };
  const useNumber = pr || !branch;
  const value = useNumber ? String(top) : head;
  return prs.length > 1 ? { value, note: `/${command} takes one target; using ${useNumber ? `#${top}` : value}` } : { value };
}

// The arguments after `/command`, in the hint's order, the free text last. A command with no hint gets the PRs in scope
// first, as numbers. `target`: what the scope resolved to, for the form to show.
export function commandArgs(command: string, spec: ArgSpec, values: ArgValues, stack: StackPr[], prs: number[]) {
  const slot = spec.parts.find((p) => p.kind === "target");
  const t = slot ? targetFor(command, slot.accepts, stack, prs) : !spec.parts.length && !spec.extra ? { value: scopeText(prs) } : undefined;
  const word = (v: string | boolean | undefined) => (typeof v === "string" ? v.trim() : "");
  const out = spec.parts.map((p) => (p.kind === "target" ? t!.value : p.kind === "flag" ? (values[p.key] ? p.key : "") : word(values[p.key])));
  const args = [...(slot ? [] : [t?.value]), ...out, word(values.extra)].filter(Boolean).join(" ");
  return { args, target: t?.value, note: t?.note };
}

// Picked PRs in stack order (bottom to top); the last one's branch contains all the others.
export const inScope = (stack: number[], picked: Set<number>) => stack.filter((n) => picked.has(n));

// The PRs a preset covers: its own scope if it sets one, else what's picked in the panel ("ask" picks first).
export function presetScope(p: Pick<Preset, "scope">, stack: number[], picked: Set<number>, current: number) {
  if (p.scope === "stack" && stack.length) return stack;
  const prs = p.scope === "this" ? [] : inScope(stack, picked);
  return prs.length ? prs : [current];
}

// What ＋ New suggests: a worktree on the topmost PR in scope (a review's default) or that PR's existing workspace
// (Fix CI's and Feedback's), and the preset's model. null: fill the composer for the selected session instead.
export type NewDefaults = { number: number; reuse: boolean; provider?: string; model?: string; effort?: string; mode?: string };
export function newDefaultsFor(p: Preset, prs: number[]): NewDefaults | null {
  const where = p.workspace ?? (p.kind === "review" ? "new" : "existing");
  if (where === "selected") return null;
  return { number: prs.at(-1)!, reuse: where === "existing", provider: p.model?.split("/")[0] ?? p.provider, model: p.model, effort: p.effort, mode: p.mode };
}

// One PR: its failing checks, or how to find them. Several: the same, headed per PR.
export function checksText(prs: { number: number; checks?: Check[] }[]) {
  return prs
    .map(({ number: n, checks }) => {
      const failing = checks?.filter((c) => c.status === "failure" || c.status === "cancelled") ?? [];
      const head = prs.length > 1 ? `#${n}: ` : "";
      return failing.length
        ? `${head}Failing checks:\n${failing.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ""}`).join("\n")}`
        : `${head}Run \`gh pr checks ${n}\` to see which checks fail.`;
    })
    .join("\n\n");
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

const isCustomized = (p: Preset) => !!p.command || !DEFAULT_PRESETS.some((d) => d.prompt === p.prompt);

// The per-comment Evaluate / Address: a favorite (preset or fitting skill) first; else a fitting skill wins over a
// shipped preset, and a preset the user wrote or edited wins over the skill.
export function feedbackPreset(kind: "feedback-evaluate" | "feedback-address", s: Store, commands: Found[]): Preset {
  const own = arrange(s.presets.filter((p) => p.kind === kind));
  const skills = arrange(
    FEEDBACK_SKILLS[kind].flatMap((name) => commands.filter((c) => c.name === name || c.name.endsWith(`:${name}`)).map((c) => commandPreset(c, kind, s.overrides))),
  );
  const preset = own[0] ?? DEFAULT_PRESETS.find((p) => p.kind === kind)!;
  return [...own, ...skills].find((p) => p.favorite) ?? (skills[0] && !isCustomized(preset) ? skills[0] : preset);
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
