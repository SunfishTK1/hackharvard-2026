# Design

## Layers

| Layer | Files | Responsibility |
|---|---|---|
| Channel | `src/agent/spectrum.ts`, `console.ts`, `channel.ts` | iMessage via Spectrum (text, app cards, in-place card edits, typing), or the terminal. |
| Router | `src/router/` | Which bot answers on the shared line (TypeSafe Jev), and the internal endpoint other bots ask. |
| Assistant | `src/agent/assistant.ts`, `prompt.ts`, `brain.ts`, `tools.ts` | One turn per inbound message or mini-app event, serialized per person. |
| Journey | `src/agent/journey.ts`, `src/domain/` | Deterministic state: phases and guards, goals, eligibility, slots. The model never decides eligibility or phase moves on its own. |
| Knowledge | `src/knowledge/` | Study content from the platform (`ConsentFirstKnowledge`), mapped to questions, consent walkthroughs, measures and visit hours. The only code that reads study tables. |
| Store | `src/store.ts`, `src/db.ts` | Person-scoped reads and writes (row-level security), and the platform bridge calls. |
| Web | `src/web/`, `public/` | Mini-app pages and their JSON API; identity verification. |

## Person scope

Every query about a person runs in `asPerson(id, work)`: one transaction that calls `assistant.use_person(id)`. The app connects as `patient_assistant`, whose row-level security policies show only that person's rows. Platform tables are not readable by that role at all; the bridge functions (`security definer`, owned by `app_owner`) check that the engagement belongs to the current person (`assistant.my_engagement`) before acting, so a bug or a prompt injection can't reach another person's record.

## The platform bridge

| Function | Platform effect |
|---|---|
| `ensure_participant(engagement, site)` | `participants` (consent_pending; eligibility pending_review or needs_review) + `private.participant_contacts` (secure_message handle; opted in only with consent to texts). |
| `present_consent` / `consent_opened` | `participant_consents` sent → opened for the current ICF. |
| `sign_consent(engagement, name, evidence)` | `participant_consents` signed with evidence in `audit_metadata` (method, verification, presentation hash, ICF sha256, agreements, teach-back answers); participant → consented. The platform rejects inactive, unapproved or expired ICFs. |
| `mirror_message` | `public.messages` + `message_threads` (provider photon, channel secure_message). The platform's trigger decides what is allowed (e.g. study messages only once enrolled, with opt-in); rejected copies are skipped, never lost from `assistant.messages`. |
| `record_observation` | `observations` (questionnaire or patient_message), completing an open `scheduled_assessment`. The platform enforces enrollment, current consent, type, choices and unit, and flags out-of-range values. |
| `notify_staff` | `alerts` at the participant's site (deduplicated while open), or a `notify_staff` workflow task before a participant exists. |
| `request_enrollment` | A `confirm_enrollment` workflow task (requires staff approval) after the visit is booked. |
| `leave_study` | Consent declined and participant withdrawn. |
| `sync_phase` | Pulls staff changes back: enrolled/active → active, completed, withdrawn, screen_failed → not_eligible. |

Enrollment itself is staff-only (the platform requires an authorized staff user and eligibility `eligible`); `npm run enroll` does it as a coordinator for demos.

## Eligibility

`public.eligibility_rules` rows become prescreen questions (`src/knowledge/rules.ts`):

- A rule with `field_name` and a known operator (`>=`, `between`, `in`, `=`, `is_true`, ... with values as scalars, arrays, `{min,max}` or `{value(s)}`) becomes a criterion on the question for that field. Several rules can share a field (minimum and maximum age).
- A rule with only a description (or an operator we don't know) becomes "Does this describe you?". The person's own judgment can't rule them in or out, so an answer against the rule sends them to staff review rather than "not eligible".
- `assistant.prescreen_questions` rewords a field's question or adds questions no rule covers (e.g. sex, to decide whether to ask about pregnancy).

Results: any failed structured rule → not eligible (journey closes kindly, no participant created); any review or unknown → needs review (consent proceeds, staff are told); all pass → likely eligible. Staff confirm eligibility at the screening visit either way.

## Consent

The e-consent mini-app shows the ICF's presentation (`assistant.consent_presentations`) or, without one, a walkthrough generated from the study record that says the approved form is the official document. Key points must be acknowledged, teach-back questions are graded on the server (the answer key never reaches the page), and signing requires a fresh, single-use identity verification (Face ID passkey, or typed name). The signature evidence includes the fingerprint of exactly what was shown.

## Line routing

Both bots receive every message on the shared Spectrum project. For each message, the patient assistant asks Jev one typed question (`patient_assistant` vs `other`) with the chat's previous route as context, and applies hysteresis: leaving the current bot needs a clear signal (p < 0.2 to leave Sage, p ≥ 0.6 to join her). Decisions are cached per chat and text for two minutes, so Charles Sprint's ask (`POST /route`) and the assistant's own share one call. If TypeSafe is unreachable, the chat keeps its previous route. Charles fails open: if the router is down, it answers as before.

## Prompting notes

- Transcript notes (form results, delivered cards, tool actions like "you alerted the study team") are shown on the person's side as `[Update: ...]`. Putting them in the assistant's own turns made the model type "[Sent card]" instead of calling `send_card`; replies are also scrubbed of bracketed notes.
- Tool actions are written to the transcript, so later turns know an alert was already raised; symptom alerts are also deduplicated per symptom while open.
- Haiku 5.5 doesn't accept prefilled replies, so the message list always ends on the person's side.
