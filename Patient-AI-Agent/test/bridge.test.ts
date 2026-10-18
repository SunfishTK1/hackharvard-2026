// Integration test of the assistant schema on a scratch copy of the platform database with the
// synthetic demo study (db/seeds/demo_study.sql): a person goes from first text to active
// participant through the same code the service uses, as the row-level-scoped patient_assistant
// role, while the platform's own triggers check every step. Refuses to run on clinical_trials.
//   DATABASE_HOST=localhost:15432 DATABASE_NAME=assistant_scratch npm run test:db
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import pg from "pg";
import { Journey } from "../src/agent/journey.ts";
import { config } from "../src/config.ts";
import { asPerson, pgConfig, pool, shared } from "../src/db.ts";
import { ConsentFirstKnowledge } from "../src/knowledge/consent-first.ts";
import { CONTACT_OPT_IN } from "../src/knowledge/rules.ts";
import * as store from "../src/store.ts";

const database = new URL(config.databaseUrl).pathname.slice(1);
if (database === "clinical_trials") throw new Error("test:db creates people and participants; point DATABASE_NAME at a scratch copy.");

const knowledge = new ConsentFirstKnowledge();
const journey = new Journey(knowledge, "NORTHSTAR-DEMO");
const staff = new pg.Client(pgConfig(config.staffDatabaseUrl));
const handle = (n: number) => `+1617555${String(Date.now()).slice(-4)}${n}`;
const alice = handle(1);
const bob = handle(2);
let alicePerson = "";
let aliceEngagement = "";

const personFor = async (h: string) => (await shared<{ id: string }>("select assistant.person_for_handle($1) as id", [h]))[0].id;
const platform = async (participantId: string) =>
  (await staff.query(
    `select p.status, p.eligibility_status, c.messaging_opt_in, c.secure_handle, public.has_current_consent(p.study_id, p.id) as consented
     from public.participants p join private.participant_contacts c on c.participant_id = p.id where p.id = $1`, [participantId])).rows[0];

before(async () => {
  await staff.connect();
});
after(async () => {
  await staff.end();
  await pool.end();
});

test("a likely-eligible prescreen hands the person to the platform and presents consent", async () => {
  alicePerson = await personFor(alice);
  const e = await asPerson(alicePerson, async (q) => {
    await store.ensureThread(q, alicePerson, "console", alice);
    const e = (await journey.start(q, alicePerson))!;
    assert.equal(e.phase, "prequalification");
    const questions = await knowledge.prescreenQuestions(e.trialId);
    const free = questions.find((x) => x.key.startsWith("criterion_"))!;
    const answers: Record<string, unknown> = {
      first_name: "Alice", age: 34, [free.key]: true, migraine_days_per_month: 6, headache_days_per_month: 8, sex: "female",
      pregnant: false, preventive_medication: false, preferred_site: "CAM", [CONTACT_OPT_IN]: true,
    };
    for (const [k, v] of Object.entries(answers)) await store.saveAnswer(q, e, k, v, "form");
    const result = await journey.applyPrescreen(q, e);
    assert.equal(result.status, "likely_eligible", JSON.stringify(result.reasons));
    return e;
  });
  aliceEngagement = e.id;
  assert.equal(e.phase, "consent");
  assert.ok(e.participantId);
  const p = await platform(e.participantId!);
  assert.deepEqual([p.status, p.eligibility_status, p.messaging_opt_in, p.secure_handle], ["consent_pending", "pending_review", true, alice]);
  const consent = await asPerson(alicePerson, (q) => store.currentConsent(q, e));
  assert.equal(consent?.status, "sent");
  const site = (await staff.query("select site_code from public.sites where id = $1", [e.siteId])).rows[0];
  assert.equal(site.site_code, "CAM", "uses the preferred site");
});

test("row-level security keeps people apart, including in the bridge functions", async () => {
  const bobPerson = await personFor(bob);
  await asPerson(bobPerson, async (q) => {
    assert.equal((await q("select * from assistant.engagements")).length, 0, "Bob can't see Alice's journey");
    assert.equal((await q("select * from assistant.people")).length, 1, "only himself");
    await q("savepoint s");
    await assert.rejects(q("select assistant.sign_consent($1, 'Bob', '{}')", [aliceEngagement]), /not the current person/);
    await q("rollback to savepoint s");
  });
  await assert.rejects(shared("select * from public.participants"), /permission denied/, "the assistant role can't read platform participants directly");
});

test("only messages the platform allows are copied to it", async () => {
  await asPerson(alicePerson, async (q) => {
    const e = await store.engagement(q, aliceEngagement);
    const thread = (await store.threadFor(q, alicePerson))!;
    const inbound = (await store.addMessage(q, { threadId: thread.id, personId: alicePerson, direction: "inbound", author: "person", body: "What happens at the visit?" }))!;
    assert.ok(await store.mirrorMessage(q, e, inbound, { direction: "inbound", type: "support", body: "What happens at the visit?" }));
    const outbound = (await store.addMessage(q, { threadId: thread.id, personId: alicePerson, direction: "outbound", author: "assistant", body: "Here's what to expect." }))!;
    assert.equal(await store.mirrorMessage(q, e, outbound, { direction: "outbound", type: "support", body: "Here's what to expect." }), null,
      "study messages need enrollment");
  });
});

test("signing consent with a verified identity makes the participant consented", async () => {
  await asPerson(alicePerson, async (q) => {
    const e = await store.engagement(q, aliceEngagement);
    const doc = (await knowledge.consentDocument(e.trialId, e.siteId))!;
    assert.ok(doc.signable && doc.generated, "the demo ICF has no loaded presentation, so the walkthrough is generated");
    await store.consentOpened(q, e);
    const at = await store.signConsent(q, e, "Alice Rivera", { method: "typed_name", presentation_hash: doc.contentHash });
    assert.ok(at instanceof Date);
    await journey.afterSignature(q, e);
    assert.equal(e.phase, "scheduling");
    const consent = await store.currentConsent(q, e);
    assert.deepEqual([consent?.status, consent?.signedBy, consent?.method], ["signed", "Alice Rivera", "typed_name"]);
  });
  const e = await asPerson(alicePerson, (q) => store.engagement(q, aliceEngagement));
  const p = await platform(e.participantId!);
  assert.deepEqual([p.status, p.consented], ["consented", true]);
});

test("booking the screening visit asks staff to confirm enrollment; check-ins wait for it", async () => {
  await asPerson(alicePerson, async (q) => {
    const e = await store.engagement(q, aliceEngagement);
    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setUTCMinutes(0, 0, 0);
    await q(
      `insert into assistant.appointments (person_id, engagement_id, site_id, starts_at, ends_at) values ($1, $2, $3, $4, $4::timestamptz + interval '1 hour')`,
      [alicePerson, e.id, e.siteId, start.toISOString()]);
    await journey.afterBooking(q, e, start.toISOString());
    assert.equal(e.phase, "screening");
    await q("savepoint s");
    await assert.rejects(store.recordObservation(q, e, { measureCode: "pain_score", value: 3, source: "questionnaire", raw: "3", confidence: 1 }),
      /require enrollment and current consent/);
    await q("rollback to savepoint s");
  });
  const e = await asPerson(alicePerson, (q) => store.engagement(q, aliceEngagement));
  const task = (await staff.query("select status, requires_approval from public.workflow_tasks where participant_id = $1 and action_type = 'confirm_enrollment'", [e.participantId])).rows[0];
  assert.deepEqual([task.status, task.requires_approval], ["pending", true]);
});

test("after staff enroll them, the journey goes active and check-ins reach the platform", async () => {
  const out = execFileSync(process.execPath, ["src/scripts/enroll.ts", alice, "--arm", "NS210", "--due-now"], { encoding: "utf8", env: process.env });
  assert.match(out, /enrolled and active by .*arm NS210.*Assistant phase: active/);
  await asPerson(alicePerson, async (q) => {
    const e = (await journey.start(q, alicePerson))!;
    assert.equal(e.phase, "active");
    assert.ok((await store.dueAssessments(q, e)).length > 0);
    await store.recordObservation(q, e, { measureCode: "pain_score", value: 3, source: "questionnaire", raw: "3", confidence: 1 });
    await store.recordObservation(q, e, { measureCode: "acute_medication", value: "triptan", source: "questionnaire", raw: "triptan", confidence: 1 });
    await q("savepoint s");
    await assert.rejects(store.recordObservation(q, e, { measureCode: "acute_medication", value: "aspirin", source: "questionnaire", raw: "aspirin", confidence: 1 }),
      /does not match the measure/, "the platform rejects values outside the measure's choices");
    await q("rollback to savepoint s");
    const thread = (await store.threadFor(q, alicePerson))!;
    const id = (await store.addMessage(q, { threadId: thread.id, personId: alicePerson, direction: "outbound", author: "assistant", body: "Thanks for checking in!" }))!;
    assert.ok(await store.mirrorMessage(q, e, id, { direction: "outbound", type: "support", body: "Thanks for checking in!" }), "enrolled study messages are accepted");
    assert.ok(await store.notifyStaff(q, e, "high", "Reported symptom: dizziness (moderate)", "Assess for an adverse event.", "adverse_event"));
    assert.equal(await store.notifyStaff(q, e, "high", "Reported symptom: dizziness (moderate)", "Assess for an adverse event.", "adverse_event"), null, "an open alert isn't duplicated");
  });
  const e = await asPerson(alicePerson, (q) => store.engagement(q, aliceEngagement));
  const done = (await staff.query("select count(*)::int as n from public.scheduled_assessments a join public.measure_definitions m on m.id = a.measure_id where a.participant_id = $1 and a.status = 'completed'", [e.participantId])).rows[0];
  assert.equal(done.n, 2, "the check-in completed the open assessments");
});

test("the study page reads the participant's own progress, tasks and readings", async () => {
  await asPerson(alicePerson, async (q) => {
    const e = await store.engagement(q, aliceEngagement);
    const overview = (await store.studyOverview(q, e))!;
    assert.equal(overview.status, "active");
    assert.equal(overview.studyDay, 1);
    assert.ok(overview.assessmentsDone14d >= 2);
    assert.ok((await store.todayAssessments(q, e)).some((a) => a.status === "completed"));
    const readings = await store.recentReadings(q, e, 7);
    assert.deepEqual(readings.map((r) => r.measureCode).sort(), ["acute_medication", "pain_score"]);
  });
});

test("withdrawing is recorded on the platform", async () => {
  await asPerson(alicePerson, async (q) => {
    const e = await store.engagement(q, aliceEngagement);
    const moved = await journey.move(q, e, "withdrawn", "assistant", "Moving away");
    assert.deepEqual(moved, { ok: true });
  });
  const e = await asPerson(alicePerson, (q) => store.engagement(q, aliceEngagement));
  assert.equal((await platform(e.participantId!)).status, "withdrawn");
});

test("a failed prescreen stays with the assistant: no participant is created", async () => {
  const person = await personFor(handle(3));
  await asPerson(person, async (q) => {
    const e = (await journey.start(q, person))!;
    for (const [k, v] of Object.entries({ first_name: "Cal", age: 70, migraine_days_per_month: 6, headache_days_per_month: 8, sex: "male", preventive_medication: false, [CONTACT_OPT_IN]: true })) {
      await store.saveAnswer(q, e, k, v, "form");
    }
    const result = await journey.applyPrescreen(q, e);
    assert.equal(result.status, "not_eligible");
    assert.equal(e.phase, "not_eligible");
    assert.equal(e.participantId, null);
  });
});
