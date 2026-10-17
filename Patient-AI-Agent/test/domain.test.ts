import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, isAsked, normalizeAnswer, type Question } from "../src/domain/eligibility.ts";
import { transitionBlocker } from "../src/domain/phases.ts";
import { generateSlots, zonedTime } from "../src/domain/scheduling.ts";
import { generatedPresentation, presentationHash } from "../src/knowledge/consent.ts";
import { buildPrescreen, CONTACT_OPT_IN, PREFERRED_SITE, ruleTest, type EligibilityRule } from "../src/knowledge/rules.ts";
import type { TrialSummary } from "../src/knowledge/types.ts";

const questions: Question[] = [
  { key: "age", prompt: "Age?", type: "number", required: true, criteria: [{ kind: "inclusion", op: "between", value: [18, 65], label: "Age 18-65" }] },
  { key: "headache_days", prompt: "Days?", type: "number", required: true, criteria: [{ kind: "exclusion", op: "gte", value: 15, label: "Chronic" }] },
  { key: "sex", prompt: "Sex?", type: "choice", required: true, options: [{ value: "female", label: "F" }, { value: "male", label: "M" }] },
  {
    key: "pregnancy", prompt: "Pregnant?", type: "yes_no", required: true, showIf: { key: "sex", in: ["female"] },
    criteria: [{ kind: "exclusion", op: "eq", value: true, label: "Pregnant" }],
  },
  { key: "preventive", prompt: "Preventive?", type: "yes_no", required: true, criteria: [{ kind: "review", op: "eq", value: true, label: "Preventive" }] },
  { key: "diagnosed", prompt: "Diagnosed a year ago?", type: "yes_no", required: true, criteria: [{ kind: "inclusion", op: "eq", value: true, label: "Diagnosed", selfReported: true }] },
];
const ok = { age: 34, headache_days: 8, sex: "male", preventive: false, diagnosed: true };

test("eligible when every criterion passes", () => {
  const r = evaluate(questions, ok);
  assert.equal(r.status, "likely_eligible");
  assert.ok(!r.reasons.some((x) => x.criterion === "Pregnant"), "skips questions hidden by show_if");
});

test("not eligible on a failed inclusion or a matched exclusion", () => {
  assert.equal(evaluate(questions, { ...ok, age: 70 }).status, "not_eligible");
  assert.equal(evaluate(questions, { ...ok, headache_days: 20 }).status, "not_eligible");
  assert.equal(evaluate(questions, { ...ok, sex: "female", pregnancy: true }).status, "not_eligible");
});

test("needs review on a review flag, a missing answer, a self-reported mismatch, or no rules at all", () => {
  assert.equal(evaluate(questions, { ...ok, preventive: true }).status, "needs_review");
  assert.equal(evaluate(questions, { ...ok, headache_days: undefined }).status, "needs_review");
  assert.equal(evaluate(questions, { ...ok, diagnosed: false }).status, "needs_review", "free-text rules never rule anyone out alone");
  assert.equal(evaluate([{ key: "first_name", prompt: "Name?", type: "text", required: true }], { first_name: "Jo" }).status, "needs_review");
});

test("show_if and answer normalization", () => {
  assert.equal(isAsked(questions[3], { sex: "male" }), false);
  assert.equal(isAsked(questions[3], { sex: "female" }), true);
  assert.deepEqual(normalizeAnswer(questions[0], "34 years"), { value: 34 });
  assert.ok("error" in normalizeAnswer(questions[0], "abc"));
  assert.deepEqual(normalizeAnswer(questions[3], "Yes"), { value: true });
  assert.ok("error" in normalizeAnswer(questions[2], "other"));
});

test("platform rule operators and value shapes", () => {
  assert.deepEqual(ruleTest(">=", 18), { op: "gte", value: 18 });
  assert.deepEqual(ruleTest(">=", "18"), { op: "gte", value: 18 });
  assert.deepEqual(ruleTest("between", [18, 65]), { op: "between", value: [18, 65] });
  assert.deepEqual(ruleTest("between", { min: 4, max: 14 }), { op: "between", value: [4, 14] });
  assert.deepEqual(ruleTest(null, { min: 4 }), { op: "between", value: [4, null] }, "a {min,max} value implies a range");
  assert.deepEqual(ruleTest("=", "true"), { op: "eq", value: true });
  assert.deepEqual(ruleTest("is true", null), { op: "eq", value: true });
  assert.deepEqual(ruleTest("in", { values: ["a", "b"] }), { op: "in", value: ["a", "b"] });
  assert.deepEqual(ruleTest("not in", "x"), { op: "not_in", value: ["x"] });
  assert.equal(ruleTest("matches_regex", "x"), undefined, "unknown operators fall back to a self-reported question");
  assert.equal(ruleTest(">=", "eighteen"), undefined);
});

test("prescreen built from platform rules", () => {
  const rules: EligibilityRule[] = [
    { id: "11111111-1111-1111-1111-111111111111", ruleType: "inclusion", description: "Aged 18 or over", fieldName: "age", operator: ">=", value: 18, sortOrder: 1 },
    { id: "22222222-2222-2222-2222-222222222222", ruleType: "inclusion", description: "Aged 65 or under", fieldName: "age", operator: "<=", value: 65, sortOrder: 2 },
    { id: "33333333-3333-3333-3333-333333333333", ruleType: "inclusion", description: "Diagnosed at least a year ago", fieldName: null, operator: null, value: null, sortOrder: 3 },
    { id: "44444444-4444-4444-4444-444444444444", ruleType: "exclusion", description: "Smoker", fieldName: "smoking_status", operator: "in", value: ["current"], sortOrder: 4 },
    { id: "55555555-5555-5555-5555-555555555555", ruleType: "exclusion", description: "Too many headache days", fieldName: "headache_days_per_month", operator: ">=", value: 15, sortOrder: 5 },
  ];
  const sites = [{ code: "BOS", name: "Back Bay", city: "Boston" }, { code: "CAM", name: "Kendall", city: "Cambridge" }];
  const qs = buildPrescreen(rules, [], sites);
  const keys = qs.map((q) => q.key);
  assert.equal(keys[0], "first_name");
  assert.deepEqual(keys.slice(-2), [PREFERRED_SITE, CONTACT_OPT_IN]);
  const age = qs.find((q) => q.key === "age")!;
  assert.equal(age.prompt, "How old are you?");
  assert.equal(age.criteria?.length, 2, "both age rules land on one question");
  const freeText = qs.find((q) => q.key.startsWith("criterion_"))!;
  assert.equal(freeText.type, "yes_no");
  assert.ok(freeText.criteria?.[0].selfReported);
  const smoking = qs.find((q) => q.key === "smoking_status")!;
  assert.equal(smoking.type, "choice");
  assert.deepEqual(smoking.options?.map((o) => o.value), ["current", "other"]);
  assert.equal(qs.find((q) => q.key === "headache_days_per_month")!.type, "number");

  const answers = { first_name: "Jo", age: 40, [freeText.key]: true, smoking_status: "other", headache_days_per_month: 3 };
  assert.equal(evaluate(qs, answers).status, "likely_eligible");
  assert.equal(evaluate(qs, { ...answers, age: 70 }).status, "not_eligible");
  assert.equal(evaluate(qs, { ...answers, smoking_status: "current" }).status, "not_eligible");

  const named = buildPrescreen([
    { ...rules[0], fieldName: "age_years", operator: "between", value: [18, 65] },
    { ...rules[1], fieldName: "screening_hba1c_percent", operator: "between", value: [7.5, 10.5], description: "HbA1c 7.5%-10.5% at screening" },
    { ...rules[2], fieldName: "screening_migraine_days_per_month", operator: ">=", value: 4, description: "At least 4 migraine days a month" },
    { ...rules[3], fieldName: null, operator: null, ruleType: "exclusion", description: "Pregnancy" },
  ], [], []);
  const q = Object.fromEntries(named.map((x) => [x.key, x]));
  assert.equal(q.age_years.prompt, "How old are you?");
  assert.equal(q.screening_hba1c_percent.prompt, "What was your most recent HbA1c, if you know it?");
  assert.equal(q.screening_hba1c_percent.unit, "%");
  assert.equal(q.screening_hba1c_percent.required, false, "values measured at screening may be unknown");
  assert.equal(q.screening_migraine_days_per_month.prompt, "In a typical month, how many migraine days do you have?");
  assert.ok(named.find((x) => x.key.startsWith("criterion_"))!.prompt.startsWith("Are you pregnant"));
  assert.equal(evaluate(named, { age_years: 40, screening_migraine_days_per_month: 6, [named.find((x) => x.key.startsWith("criterion_"))!.key]: false }).status,
    "needs_review", "an unknown screening value goes to staff review");

  const reworded = buildPrescreen(rules, [{ key: "age", position: 0, prompt: "Your age?", help: null, type: "number", options: null, unit: "years", min: 0, max: 120, required: true, showIf: null }], []);
  assert.equal(reworded.find((q) => q.key === "age")!.prompt, "Your age?");
  assert.ok(!reworded.some((q) => q.key === PREFERRED_SITE), "no site question with a single site");
});

test("generated consent walkthrough is stable and covers the essentials", () => {
  const trial = {
    id: "t", code: "X", title: "A study of Y", shortTitle: "X", phase: "Phase 2", status: "active", condition: "Migraine", intervention: "Y",
    sponsor: null, design: null, summary: "Testing Y.", primaryEndpoint: "Fewer migraine days", durationWeeks: 12, timeCommitment: null,
    compensation: null, contactPhone: null, timezone: "America/New_York", isSynthetic: true,
    sites: [{ id: "s", code: "BOS", name: "Back Bay", city: "Boston", region: "MA", principalInvestigator: "Dr. R", timeZone: "America/New_York", status: "active" }],
    arms: [{ code: "A", name: "Y", description: null, isControl: false }, { code: "P", name: "Placebo", description: null, isControl: true }],
    assessments: [{ label: "Pain", frequency: "daily" }],
  } satisfies TrialSummary;
  const p = generatedPresentation(trial, { name: "ICF", version: "1.0" });
  assert.ok(p.sections.some((s) => s.id === "voluntary" && s.key_point));
  assert.ok(p.sections.some((s) => s.id === "groups"), "randomized studies explain the groups");
  assert.deepEqual(p.comprehension.map((c) => c.id), ["voluntary", "groups", "emergency"]);
  assert.equal(presentationHash(p), presentationHash(generatedPresentation(trial, { name: "ICF", version: "1.0" })));
});

test("phase guard rails", () => {
  const facts = { eligibility: "unknown" as const, hasSignedConsent: false, hasBookedAppointment: false, isEnrolled: false };
  assert.ok(transitionBlocker("prequalification", "consent", facts));
  assert.equal(transitionBlocker("prequalification", "consent", { ...facts, eligibility: "likely_eligible" }), undefined);
  assert.equal(transitionBlocker("prequalification", "consent", { ...facts, eligibility: "needs_review" }), undefined);
  assert.ok(transitionBlocker("consent", "scheduling", facts), "no scheduling before consent");
  assert.ok(transitionBlocker("prequalification", "active", facts), "no skipping phases");
  assert.equal(transitionBlocker("consent", "declined", facts), undefined, "declining is always allowed");
});

test("slots respect site hours, time zone, lead time and bookings", () => {
  const hours = [{ siteId: "s1", siteCode: "BOS", siteName: "Boston", timeZone: "America/New_York", weekday: 2, opens: "09:00", closes: "11:00", slotMinutes: 60 }];
  // Monday 2026-10-19 12:00 New York.
  const now = zonedTime("2026-10-19", "12:00", "America/New_York");
  const booked = [{ siteId: "s1", start: zonedTime("2026-10-20", "09:00", "America/New_York").toISOString() }];
  const slots = generateSlots({ hours, booked, now, days: 8, leadHours: 20 });
  assert.deepEqual(slots.map((s) => `${s.localDate} ${s.localTime}`), ["2026-10-20 10:00", "2026-10-27 09:00", "2026-10-27 10:00"]);
  assert.equal(slots[0].start, "2026-10-20T14:00:00.000Z", "10:00 EDT is 14:00 UTC");
  const west = generateSlots({ hours: [{ ...hours[0], siteId: "s2", siteCode: "SFO", timeZone: "America/Los_Angeles" }], booked: [], now, days: 1, leadHours: 0 });
  assert.equal(west[0].start, "2026-10-20T16:00:00.000Z", "each site uses its own time zone");
});

test("zonedTime handles the DST change", () => {
  assert.equal(zonedTime("2026-11-02", "09:00", "America/New_York").toISOString(), "2026-11-02T14:00:00.000Z"); // EST
  assert.equal(zonedTime("2026-10-30", "09:00", "America/New_York").toISOString(), "2026-10-30T13:00:00.000Z"); // EDT
});
