// Mirrors Paseo's question form (app: parseQuestionFormQuestions / buildQuestionFormAnswers), so answers
// reach every provider the same way: allow with updatedInput.answers keyed by question *header*.
export type Question = {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
};
// Per question: selected option labels, and the free-text answer.
export type Draft = { picked: string[]; text: string }[];

const rec = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function parseQuestions(input: unknown): Question[] | null {
  const qs = rec(input)?.questions;
  if (!Array.isArray(qs)) return null;
  const out: Question[] = [];
  for (const raw of qs) {
    const q = rec(raw);
    if (!q || typeof q.question !== "string" || typeof q.header !== "string" || !Array.isArray(q.options)) return null;
    const options = [];
    for (const o of q.options) {
      const opt = rec(o);
      if (!opt || typeof opt.label !== "string") return null;
      options.push({ label: opt.label, description: str(opt.description) });
    }
    out.push({
      question: q.question,
      header: q.header,
      options,
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther === true || q.isOther === true,
      allowEmpty: q.allowEmpty === true,
      placeholder: str(q.placeholder),
      dismissLabel: str(q.dismissLabel),
    });
  }
  return out.length ? out : null;
}

export const showsText = (q: Question) => q.options.length === 0 || q.allowOther;

export const isAnswered = (q: Question, d: Draft[number]) =>
  d.picked.length > 0 || (showsText(q) && (d.text.trim().length > 0 || q.allowEmpty));

// Typed text wins over picked options, as in Paseo.
export function buildAnswers(questions: Question[], draft: Draft) {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const text = draft[i].text.trim();
    if (showsText(q)) {
      if (text) return void (answers[q.header] = text);
      if (q.allowEmpty && !q.options.length) return void (answers[q.header] = "");
    }
    if (draft[i].picked.length) answers[q.header] = draft[i].picked.join(", ");
  });
  return answers;
}

// Paseo dismisses free-text-only optional forms by submitting them empty; everything else is a deny.
export function questionResponse(input: unknown, questions: Question[], draft: Draft, dismiss: boolean) {
  const submitEmpty = questions.every((q) => q.allowEmpty && !q.options.length);
  if (dismiss && !submitEmpty) return { behavior: "deny" as const, message: "Dismissed by user" };
  return { behavior: "allow" as const, updatedInput: { ...rec(input), answers: buildAnswers(questions, draft) } };
}
