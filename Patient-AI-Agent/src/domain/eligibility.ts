// Prescreen answers -> likely eligibility. Deterministic on purpose: the model explains the
// result, but never decides it. The study team makes the final call at the screening visit.

export type QuestionType = "yes_no" | "number" | "choice" | "multi_choice" | "scale" | "date" | "text";

export type Operator = "gte" | "gt" | "lte" | "lt" | "eq" | "ne" | "in" | "not_in" | "between";

export interface Criterion {
  /** inclusion: must match. exclusion: must not match. review: a match needs a person to look. */
  kind: "inclusion" | "exclusion" | "review";
  label: string;
  op: Operator;
  value: unknown;
  /**
   * The person judged a free-text rule for themselves ("Does this describe you?"). Their answer
   * can't rule them in or out on its own, so a result against the rule goes to staff review.
   */
  selfReported?: boolean;
}

export interface Question {
  key: string;
  /** A short headline for the mini-app ("Pregnancy."); the prompt is the question itself. */
  title?: string;
  prompt: string;
  type: QuestionType;
  required: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  unit?: string;
  help?: string;
  showIf?: { key: string; in?: unknown[]; equals?: unknown };
  criteria?: Criterion[];
}

export type Answers = Record<string, unknown>;

export interface CriterionResult {
  criterion: string;
  kind: Criterion["kind"];
  result: "pass" | "fail" | "review" | "unknown";
  detail: string;
}

export interface EligibilityResult {
  status: "likely_eligible" | "needs_review" | "not_eligible";
  reasons: CriterionResult[];
}

const present = (value: unknown) => value !== undefined && value !== null && value !== "";

/** Whether a question applies, given earlier answers (show_if). */
export function isAsked(question: Question, answers: Answers): boolean {
  const rule = question.showIf;
  if (!rule) return true;
  const value = answers[rule.key];
  if (rule.in) return rule.in.includes(value);
  if ("equals" in rule) return value === rule.equals;
  return true;
}

const asNumber = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const same = (a: unknown, b: unknown) =>
  a === b || (typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()) || (Number.isFinite(asNumber(a)) && asNumber(a) === asNumber(b));

/** Whether an answer satisfies one rule test. Lists (multi-choice answers) match if any item does. */
export function test(op: Operator, expected: unknown, answer: unknown): boolean {
  if (Array.isArray(answer) && op !== "between") {
    return op === "ne" || op === "not_in" ? answer.every((a) => test(op, expected, a)) : answer.some((a) => test(op, expected, a));
  }
  const n = asNumber(answer);
  switch (op) {
    case "gte": return n >= asNumber(expected);
    case "gt": return n > asNumber(expected);
    case "lte": return n <= asNumber(expected);
    case "lt": return n < asNumber(expected);
    case "between": {
      const [lo, hi] = expected as [unknown, unknown];
      return (lo === null || n >= asNumber(lo)) && (hi === null || n <= asNumber(hi));
    }
    case "eq": return same(answer, expected);
    case "ne": return !same(answer, expected);
    case "in": return (expected as unknown[]).some((x) => same(answer, x));
    case "not_in": return !(expected as unknown[]).some((x) => same(answer, x));
  }
}

export function evaluate(questions: Question[], answers: Answers): EligibilityResult {
  const reasons: CriterionResult[] = [];
  for (const q of questions) {
    if (!q.criteria?.length || !isAsked(q, answers)) continue;
    const value = answers[q.key];
    for (const c of q.criteria) {
      if (!present(value)) {
        reasons.push({ criterion: c.label, kind: c.kind, result: "unknown", detail: "not answered" });
        continue;
      }
      const hit = test(c.op, c.value, value);
      const against = c.selfReported ? "review" : "fail";
      const result = c.kind === "inclusion" ? (hit ? "pass" : against) : c.kind === "exclusion" ? (hit ? against : "pass") : hit ? "review" : "pass";
      reasons.push({ criterion: c.label, kind: c.kind, result, detail: `answered ${JSON.stringify(value)}` });
    }
  }
  const status = reasons.some((r) => r.result === "fail")
    ? "not_eligible"
    : !reasons.length || reasons.some((r) => r.result === "review" || r.result === "unknown")
      ? "needs_review" // also when the study has no machine-checkable rules: staff decide
      : "likely_eligible";
  return { status, reasons };
}

/** Normalizes one answer to the question's type, or explains why it isn't valid. */
export function normalizeAnswer(question: Question, raw: unknown): { value: unknown } | { error: string } {
  if (!present(raw)) return question.required ? { error: "This question needs an answer." } : { value: null };
  switch (question.type) {
    case "yes_no": {
      if (typeof raw === "boolean") return { value: raw };
      const s = String(raw).trim().toLowerCase();
      if (["yes", "y", "true"].includes(s)) return { value: true };
      if (["no", "n", "false"].includes(s)) return { value: false };
      return { error: "Answer yes or no." };
    }
    case "number":
    case "scale": {
      // Accepts "34", "34 years" or "about 6"; rejects text with no number in it.
      const match = typeof raw === "number" ? null : String(raw).match(/-?\d+(?:\.\d+)?/);
      const n = typeof raw === "number" ? raw : match ? Number(match[0]) : NaN;
      if (!Number.isFinite(n)) return { error: "Enter a number." };
      if (question.min !== undefined && n < question.min) return { error: `Enter ${question.min} or more.` };
      if (question.max !== undefined && n > question.max) return { error: `Enter ${question.max} or less.` };
      return { value: n };
    }
    case "choice": {
      const values = question.options?.map((o) => o.value) ?? [];
      return values.includes(String(raw)) ? { value: String(raw) } : { error: "Pick one of the options." };
    }
    case "multi_choice": {
      const list = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const values = question.options?.map((o) => o.value) ?? [];
      return list.every((v) => values.includes(v)) ? { value: list } : { error: "Pick from the options." };
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? { value: String(raw) } : { error: "Use a date like 2026-10-20." };
    default:
      return { value: String(raw).trim().slice(0, 500) };
  }
}
