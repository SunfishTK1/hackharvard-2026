// TrialKnowledge backed by the consent-first platform: public.studies, sites, study_arms,
// eligibility_rules, measure_definitions, assessment_schedules and consent_documents, plus the
// assistant's optional presentation tables (study_profiles, prescreen_questions,
// consent_presentations, site_hours). Cached briefly; study content rarely changes.
import { config } from "../config.ts";
import type { Question } from "../domain/eligibility.ts";
import type { SiteHours } from "../domain/scheduling.ts";
import { shared } from "../db.ts";
import { generatedPresentation, presentationHash } from "./consent.ts";
import { buildPrescreen, type EligibilityRule, type QuestionOverride } from "./rules.ts";
import type { CheckInMeasure, ConsentDocument, StudyListing, TrialKnowledge, TrialSummary } from "./types.ts";

const TTL_MS = 60_000;
/** Visit hours for sites the assistant has no hours for: weekdays 9:00-16:00, hour-long slots. */
const DEFAULT_HOURS = { weekdays: [1, 2, 3, 4, 5], opens: "09:00", closes: "16:00", slotMinutes: 60 };
const FREQUENCY: Record<string, string> = { once: "once", daily: "daily", weekly: "weekly", custom_days: "on set study days" };

/** The platform defaults site time zones to UTC; treat that as unset. */
const zone = (tz: string | null | undefined) => (tz && tz !== "UTC" ? tz : config.timeZone);

export class ConsentFirstKnowledge implements TrialKnowledge {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
    const value = load().catch((error) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async trialByCode(code?: string): Promise<TrialSummary | undefined> {
    const [row] = code
      ? await shared<{ id: string }>("select id from public.studies where study_code = $1", [code])
      : await shared<{ id: string }>("select id from public.studies where status = 'active' order by updated_at desc limit 1");
    return row ? this.trial(row.id) : undefined;
  }

  trial(id: string): Promise<TrialSummary> {
    return this.cached(`trial:${id}`, async () => {
      const [s] = await shared(
        `select s.*, p.short_name, p.patient_summary, p.time_commitment, p.compensation, p.contact_phone
         from public.studies s left join assistant.study_profiles p on p.study_id = s.id where s.id = $1`, [id]);
      if (!s) throw new Error(`No study ${id}`);
      const sites = await shared(
        `select id, site_code, institution_name, city, state, principal_investigator, time_zone, status from public.sites
         where study_id = $1 and status <> 'closed' order by (status = 'active') desc, site_code`, [id]);
      const arms = await shared("select arm_code, name, description, is_control from public.study_arms where study_id = $1 order by is_control, arm_code", [id]);
      const assessments = await shared(
        `select distinct on (m.id) m.label, a.frequency from public.assessment_schedules a join public.measure_definitions m on m.id = a.measure_id
         where a.study_id = $1 and a.is_active and m.is_active order by m.id, a.frequency`, [id]);
      const mapped = sites.map((r) => ({
        id: r.id, code: r.site_code, name: r.institution_name, city: r.city, region: r.state,
        principalInvestigator: r.principal_investigator, timeZone: zone(r.time_zone), status: r.status,
      }));
      return {
        id: s.id, code: s.study_code, title: s.title, shortTitle: s.short_name ?? s.study_code, phase: s.phase, status: s.status,
        condition: s.condition, intervention: s.intervention, sponsor: s.sponsor, design: s.design,
        summary: s.patient_summary ?? s.title, primaryEndpoint: s.primary_outcome, durationWeeks: s.duration_weeks,
        timeCommitment: s.time_commitment, compensation: s.compensation, contactPhone: s.contact_phone,
        timezone: mapped.find((x) => x.status === "active")?.timeZone ?? zone(null), isSynthetic: s.is_synthetic,
        sites: mapped,
        arms: arms.map((a) => ({ code: a.arm_code, name: a.name, description: a.description, isControl: a.is_control })),
        assessments: assessments.map((a) => ({ label: a.label, frequency: FREQUENCY[a.frequency] ?? a.frequency })),
      };
    });
  }

  prescreenQuestions(trialId: string): Promise<Question[]> {
    return this.cached(`prescreen:${trialId}`, async () => {
      const [rules, overrides, trial] = await Promise.all([
        shared("select id, rule_type, description, field_name, operator, rule_value, sort_order from public.eligibility_rules where study_id = $1", [trialId]),
        shared(
          `select key, position, prompt, help, type, options, unit, min_value, max_value, required, show_if
           from assistant.prescreen_questions where study_id = $1`, [trialId]),
        this.trial(trialId),
      ]);
      return buildPrescreen(
        rules.map((r): EligibilityRule => ({
          id: r.id, ruleType: r.rule_type, description: r.description, fieldName: r.field_name?.trim() || null,
          operator: r.operator, value: r.rule_value, sortOrder: r.sort_order,
        })),
        overrides.map((o): QuestionOverride => ({
          key: o.key, position: o.position, prompt: o.prompt, help: o.help, type: o.type, options: o.options, unit: o.unit,
          min: o.min_value === null ? null : Number(o.min_value), max: o.max_value === null ? null : Number(o.max_value),
          required: o.required, showIf: o.show_if,
        })),
        trial.sites.filter((s) => s.status === "active").map((s) => ({ code: s.code, name: s.name, city: s.city })),
      );
    });
  }

  consentDocument(trialId: string, siteId?: string | null): Promise<ConsentDocument | undefined> {
    return this.cached(`consent:${trialId}:${siteId ?? ""}`, async () => {
      const [d] = await shared(
        `select d.id, d.document_name, d.version, s.sha256, p.summary, p.sections, p.comprehension, p.presentation_hash,
                s.review_status = 'approved' and d.effective_date <= current_date and (d.expires_on is null or d.expires_on >= current_date) as signable
         from public.consent_documents d
         join public.study_documents s on s.id = d.source_document_id
         left join assistant.consent_presentations p on p.consent_document_id = d.id
         where d.study_id = $1 and d.is_active and (d.site_id is null or d.site_id = $2 or $2::uuid is null)
         order by (d.site_id = $2) desc nulls last, (d.site_id is null) desc limit 1`, [trialId, siteId ?? null]);
      if (!d) return undefined;
      const base = { id: d.id, version: d.version, title: d.document_name, sourceSha256: d.sha256, signable: d.signable };
      if (d.sections) {
        return { ...base, summary: d.summary, sections: d.sections, comprehension: d.comprehension, contentHash: d.presentation_hash, generated: false };
      }
      const p = generatedPresentation(await this.trial(trialId), { name: d.document_name, version: d.version });
      return { ...base, ...p, contentHash: presentationHash(p), generated: true };
    });
  }

  siteHours(trialId: string): Promise<SiteHours[]> {
    return this.cached(`hours:${trialId}`, async () => {
      const trial = await this.trial(trialId);
      const rows = await shared(
        `select h.site_id, h.weekday, to_char(h.opens, 'HH24:MI') as opens, to_char(h.closes, 'HH24:MI') as closes, h.slot_minutes
         from assistant.site_hours h join public.sites s on s.id = h.site_id where s.study_id = $1`, [trialId]);
      return trial.sites.filter((s) => s.status === "active").flatMap((site) => {
        const base = { siteId: site.id, siteCode: site.code, siteName: site.name, city: site.city ?? undefined, timeZone: site.timeZone };
        const own = rows.filter((r) => r.site_id === site.id);
        return own.length
          ? own.map((r) => ({ ...base, weekday: r.weekday, opens: r.opens, closes: r.closes, slotMinutes: r.slot_minutes }))
          : DEFAULT_HOURS.weekdays.map((weekday) => ({ ...base, weekday, opens: DEFAULT_HOURS.opens, closes: DEFAULT_HOURS.closes, slotMinutes: DEFAULT_HOURS.slotMinutes }));
      });
    });
  }

  checkInMeasures(trialId: string): Promise<CheckInMeasure[]> {
    return this.cached(`checkin:${trialId}`, async () => {
      // What a participant reports themselves: not values from site visits, labs or app telemetry.
      const rows = await shared(
        `select m.id, m.measure_code, m.label, m.prompt, m.data_type, m.unit, m.min_value, m.max_value, m.choices, m.required,
                exists (select 1 from public.assessment_schedules a where a.measure_id = m.id and a.is_active and a.frequency in ('daily', 'weekly')) as routine
         from public.measure_definitions m
         where m.study_id = $1 and m.is_active and m.data_type <> 'json'
           and coalesce(m.source_type, 'patient_message') in ('patient_message', 'questionnaire', 'device')
         order by m.measure_code`, [trialId]);
      // Measures on a daily or weekly schedule are the check-in; if none are scheduled yet, offer them all.
      const chosen = rows.some((r) => r.routine) ? rows.filter((r) => r.routine) : rows;
      return chosen.map((r): CheckInMeasure => {
        const min = r.min_value === null ? null : Number(r.min_value);
        const max = r.max_value === null ? null : Number(r.max_value);
        const valueType = r.data_type === "numeric" ? "number"
          : r.data_type === "integer" ? (min !== null && max !== null && max - min <= 10 ? "scale" : "integer")
          : r.data_type;
        return {
          measureId: r.id, code: r.measure_code, label: r.label, valueType, unit: r.unit, min, max,
          choices: Array.isArray(r.choices) ? r.choices.map(String) : null, required: r.required, prompt: r.prompt ?? r.label,
        };
      });
    });
  }

  recruitingStudies(): Promise<StudyListing[]> {
    return this.cached("recruiting", async () => {
      const rows = await shared(
        `select s.id, s.study_code, s.title, s.condition, p.short_name from public.studies s
         left join assistant.study_profiles p on p.study_id = s.id
         where s.status = 'active' and exists (select 1 from public.sites x where x.study_id = s.id and x.status = 'active')
         order by s.study_code`);
      return rows.map((r) => ({ id: r.id, code: r.study_code, title: r.title, condition: r.condition, shortTitle: r.short_name ?? r.study_code }));
    });
  }

  agentInstructions(trialId: string): Promise<string | undefined> {
    return this.cached(`agent:${trialId}`, async () => {
      const [p] = await shared("select agent_instructions from assistant.study_profiles where study_id = $1", [trialId]);
      return p?.agent_instructions ?? undefined;
    });
  }
}
