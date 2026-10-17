// Builds the prescreen from the platform's eligibility rules. Each rule with a field_name becomes a
// criterion on the question for that field (several rules can share one, e.g. a minimum and maximum
// age); a rule with only a description becomes a "Does this describe you?" question whose answer
// goes to staff review rather than ruling anyone in or out. assistant.prescreen_questions rows
// reword a field's question or add questions no rule covers. Pure, so it is easy to test.
import type { Criterion, Operator, Question, QuestionType } from "../domain/eligibility.ts";

export interface EligibilityRule {
  id: string;
  ruleType: "inclusion" | "exclusion";
  description: string;
  fieldName: string | null;
  operator: string | null;
  value: unknown;
  sortOrder: number;
}

export interface QuestionOverride {
  key: string;
  position: number;
  prompt: string;
  help: string | null;
  type: Exclude<QuestionType, "scale" | "date">;
  options: { value: string; label: string }[] | null;
  unit: string | null;
  min: number | null;
  max: number | null;
  required: boolean;
  showIf: Question["showIf"] | null;
}

export interface PrescreenSite {
  code: string;
  name: string;
  city: string | null;
}

/** Keys the assistant adds itself, after the study's own questions. */
export const CONTACT_OPT_IN = "contact_opt_in";
export const PREFERRED_SITE = "preferred_site";

const OPERATORS: Record<string, Operator> = {
  ">=": "gte", "≥": "gte", gte: "gte", min: "gte", at_least: "gte", minimum: "gte",
  ">": "gt", gt: "gt", greater_than: "gt", above: "gt",
  "<=": "lte", "≤": "lte", lte: "lte", max: "lte", at_most: "lte", maximum: "lte",
  "<": "lt", lt: "lt", less_than: "lt", below: "lt",
  "=": "eq", "==": "eq", eq: "eq", equals: "eq", is: "eq",
  "!=": "ne", "<>": "ne", ne: "ne", neq: "ne", not_equals: "ne", is_not: "ne",
  in: "in", one_of: "in", any_of: "in",
  not_in: "not_in", none_of: "not_in",
  between: "between", range: "between",
};
const TRUTHY_OPERATORS = new Set(["is_true", "true", "yes", "exists", "present", "has"]);
const FALSY_OPERATORS = new Set(["is_false", "false", "no", "absent", "not_present"]);

const unwrap = (v: unknown): unknown => {
  if (typeof v === "string") {
    const s = v.trim();
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
    if (s !== "" && Number.isFinite(Number(s))) return Number(s);
    return s;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ("value" in o) return unwrap(o.value);
    if ("values" in o) return unwrap(o.values);
  }
  return Array.isArray(v) ? v.map(unwrap) : v;
};

/** A rule's test in our terms, or undefined when the rule can't be checked automatically. */
export function ruleTest(operator: string | null, raw: unknown): { op: Operator; value: unknown } | undefined {
  const name = String(operator ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (TRUTHY_OPERATORS.has(name)) return { op: "eq", value: true };
  if (FALSY_OPERATORS.has(name)) return { op: "eq", value: false };
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const range = object && ("min" in object || "max" in object) ? [unwrap(object.min ?? null), unwrap(object.max ?? null)] : undefined;
  const op = OPERATORS[name] ?? (range ? "between" : undefined);
  if (!op) return undefined;
  const value = unwrap(raw);
  switch (op) {
    case "between": {
      const pair = range ?? (Array.isArray(value) && value.length === 2 ? value : undefined);
      return pair && pair.every((x) => x === null || typeof x === "number") && pair.some((x) => x !== null) ? { op, value: pair } : undefined;
    }
    case "gte": case "gt": case "lte": case "lt":
      return typeof value === "number" ? { op, value } : undefined;
    case "in": case "not_in": {
      const list = Array.isArray(value) ? value : value === undefined || value === null ? undefined : [value];
      return list?.length ? { op, value: list } : undefined;
    }
    default:
      return value === undefined || value === null || typeof value === "object" ? undefined : { op, value };
  }
}

const humanize = (key: string) => key.replace(/_+/g, " ").trim();
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const optionLabel = (v: string) => capitalize(humanize(v));

const UNIT_SUFFIXES: [RegExp, string][] = [
  [/_years?$/, "years"], [/_months?$/, "months"], [/_weeks?$/, "weeks"], [/_days?_per_month$/, "days a month"], [/_per_month$/, "a month"],
  [/_days?$/, "days"], [/_percent$/, "%"], [/_kg$/, "kg"], [/_lbs?$/, "lb"], [/_cm$/, "cm"], [/_hours?$/, "hours"], [/_mmhg$/, "mmHg"], [/_mg_dl$/, "mg/dL"],
];
const ACRONYMS: Record<string, string> = { hba1c: "HbA1c", bmi: "BMI", bp: "blood pressure", ecog: "ECOG" };

/**
 * A field name in plain words: "screening_hba1c_percent" -> base "hba1c", label "HbA1c", unit "%".
 * Fields measured "at screening" may be unknown to the person, so their questions are optional.
 */
function describeField(field: string) {
  const screening = field.startsWith("screening_");
  const stripped = field.replace(/^screening_/, "").replace(/^is_|^has_/, "");
  const suffix = UNIT_SUFFIXES.find(([re]) => re.test(stripped));
  const base = suffix && !/_days?_per_month$|_per_month$/.test(stripped) ? stripped.replace(suffix[0], "") : stripped;
  const label = humanize(base).split(" ").map((w) => ACRONYMS[w] ?? w).join(" ");
  return { base, label, unit: suffix?.[1], screening };
}

/** Well-known fields get natural questions even without an override. */
const KNOWN: Record<string, Partial<Question>> = {
  age: { prompt: "How old are you?", type: "number", unit: "years", min: 0, max: 120 },
  sex: {
    prompt: "What was your sex at birth?", type: "choice",
    options: [{ value: "female", label: "Female" }, { value: "male", label: "Male" }, { value: "intersex", label: "Intersex" }, { value: "prefer_not", label: "Prefer not to say" }],
  },
  pregnant: { prompt: "Are you pregnant, breastfeeding, or planning a pregnancy soon?", type: "yes_no" },
  bmi: { prompt: "What is your BMI, if you know it?", type: "number", min: 10, max: 80 },
};

function generated(field: string, rules: EligibilityRule[], tests: Criterion[]): Question {
  const { base, label, unit, screening } = describeField(field);
  const known = KNOWN[base] ?? (/^pregnan/.test(base) ? KNOWN.pregnant : undefined);
  const values = tests.flatMap((t) => (Array.isArray(t.value) ? t.value : [t.value]));
  const numeric = tests.some((t) => ["gte", "gt", "lte", "lt", "between"].includes(t.op)) || (values.length > 0 && values.every((v) => typeof v === "number"));
  const boolean = !numeric && values.length > 0 && values.every((v) => typeof v === "boolean");
  const help = rules.map((r) => r.description).join(" · ");
  if (known) return { key: field, required: true, help, ...known, prompt: known.prompt!, type: known.type! };
  if (numeric) {
    const counted = /(days|times|count|episodes|attacks)/.test(base);
    const prompt = counted ? `In a typical month, how many ${label.replace(/ per month$/, "")} do you have?` : screening ? `What was your most recent ${label}, if you know it?` : `What is your ${label}?`;
    return { key: field, prompt, help, type: "number", unit: counted ? "days" : unit, required: !screening || counted, min: 0 };
  }
  if (boolean) return { key: field, prompt: `${capitalize(rules[0].description.replace(/\.$/, ""))}: does this apply to you?`, type: "yes_no", required: true };
  const options = [...new Set(values.map(String))].map((v) => ({ value: v, label: optionLabel(v) }));
  options.push({ value: "other", label: "Something else" });
  return { key: field, prompt: `Which best describes your ${label}?`, help, type: "choice", options, required: true };
}

/** The prescreen for a study: name first, then the study's questions, then site and contact. */
export function buildPrescreen(rules: EligibilityRule[], overrides: QuestionOverride[], sites: PrescreenSite[]): Question[] {
  const byKey = new Map(overrides.map((o) => [o.key, o]));
  const fields = new Map<string, { rules: EligibilityRule[]; criteria: Criterion[]; order: number }>();
  const questions: { order: number; question: Question }[] = [];

  for (const rule of [...rules].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const check = rule.fieldName ? ruleTest(rule.operator, rule.value) : undefined;
    if (rule.fieldName && check) {
      const entry = fields.get(rule.fieldName) ?? { rules: [], criteria: [], order: rule.sortOrder };
      entry.rules.push(rule);
      entry.criteria.push({ kind: rule.ruleType, label: rule.description, ...check });
      fields.set(rule.fieldName, entry);
      continue;
    }
    // Free text (or an operator we don't know): the person says whether it describes them.
    const key = `criterion_${rule.id.replace(/-/g, "").slice(0, 12)}`;
    const override = byKey.get(key);
    const pregnancy = rule.ruleType === "exclusion" && /^pregnan/i.test(rule.description.trim());
    questions.push({
      order: override?.position ?? rule.sortOrder,
      question: {
        key, type: "yes_no", required: true,
        prompt: override?.prompt ?? (pregnancy ? KNOWN.pregnant.prompt! : rule.ruleType === "inclusion" ? `Does this describe you? ${rule.description}` : `Does this apply to you? ${rule.description}`),
        help: override?.help ?? undefined,
        criteria: [{ kind: rule.ruleType, label: rule.description, op: "eq", value: true, selfReported: true }],
      },
    });
  }

  for (const [field, entry] of fields) {
    const o = byKey.get(field);
    const question: Question = o
      ? { key: field, prompt: o.prompt, help: o.help ?? undefined, type: o.type, required: o.required, options: o.options ?? undefined, unit: o.unit ?? undefined,
          min: o.min ?? undefined, max: o.max ?? undefined, showIf: o.showIf ?? undefined }
      : generated(field, entry.rules, entry.criteria);
    questions.push({ order: o?.position ?? entry.order, question: { ...question, criteria: entry.criteria } });
  }

  // Questions the assistant's content adds (no rule behind them), e.g. sex to decide whether to ask about pregnancy.
  for (const o of overrides) {
    if (fields.has(o.key) || o.key.startsWith("criterion_") || questions.some((q) => q.question.key === o.key)) continue;
    questions.push({
      order: o.position,
      question: { key: o.key, prompt: o.prompt, help: o.help ?? undefined, type: o.type, required: o.required, options: o.options ?? undefined,
        unit: o.unit ?? undefined, min: o.min ?? undefined, max: o.max ?? undefined, showIf: o.showIf ?? undefined },
    });
  }

  const ordered = questions.sort((a, b) => a.order - b.order).map((q) => q.question);
  const first: Question[] = ordered.some((q) => q.key === "first_name") ? [] : [
    { key: "first_name", prompt: "First, what should we call you?", type: "text", required: true },
  ];
  const last: Question[] = [];
  if (sites.length > 1 && !ordered.some((q) => q.key === PREFERRED_SITE)) {
    last.push({
      key: PREFERRED_SITE, prompt: "Which location would be easier for you to visit?", type: "choice", required: true,
      options: [...sites.map((s) => ({ value: s.code, label: [s.name, s.city].filter(Boolean).join(", ") })), { value: "either", label: "Either is fine" }],
    });
  }
  last.push({
    key: CONTACT_OPT_IN, type: "yes_no", required: true,
    prompt: "Is it OK for the study team to text you at this number about the study?",
    help: "Reply STOP anytime to stop texts. We never share your number.",
  });
  return [...first, ...ordered, ...last];
}
