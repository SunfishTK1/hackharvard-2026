# Patient AI Agent

**Sage**, an iMessage assistant that takes a person from "I saw a flyer" to active study participant: it answers questions, prequalifies them, walks them through informed consent and collects an e-signature verified with Face ID, books the screening visit, and once they are enrolled, collects check-ins and flags side effects. Rich steps happen in **mini-apps** that open inside iMessage (Photon Spectrum app cards); the conversation stays in the chat.

It runs on the team's **consent-first platform** database (`clinical_trials`, built by the platform team) and adds one schema, `assistant`, beside it. Study content (studies, sites, arms, eligibility rules, measures, approved ICFs) comes from the platform; the assistant writes to the platform only through guarded functions, so the platform's rules (opt-in, approved and active ICF, lifecycle, value types) still apply to everything it does.

Live: https://patient.hackharvard2026.velroi.com (mini-apps) · iMessage: the Photon 1.0 line, shared with Charles Sprint.

## How it works

```
iMessage ──Spectrum──▶ Line router (TypeSafe Jev) ──▶ Assistant turn ──▶ reply + mini-app cards
                         │ "other" → Charles Sprint      │
                         └─ patient-assistant:3011        ├─ context: phase, goals, memory, transcript, platform record
                                                          ├─ Claude Haiku 5.5 + tools (send_card, remember, record_answer,
                                                          │   check_eligibility, change_phase, record_observation,
                                                          │   report_symptom, escalate, ...)
                                                          └─ Journey engine: guarded phase changes, platform hand-off
Mini-app (web, /f/<token>) ──▶ Forms: validate, apply, update the card in place, tell the assistant to follow up
```

**Phases** (`src/domain/phases.ts`): `prequalification → consent → scheduling → screening → active → completed`, with `not_eligible`, `declined`, `withdrawn` as exits. Each phase has a purpose, tone, allowed cards and allowed next phases, and code guards every move (no scheduling without a signed consent, no check-ins before enrollment). The model can ask to move; only allowed moves happen.

**Goals** (`src/domain/playbook.ts`): each phase generates goals from the study's knowledge (e.g. "Complete the prescreen" exists only if the study has eligibility rules). Open goals go into every prompt, and the model marks them done.

**Memory** (`assistant.memories`): long-term, per person, scoped by row-level security. The model saves preferences, routines, worries and health context it is told, and can correct or forget them.

**Hand-off to the platform**: prequalification is the assistant's alone (the platform starts at the consent invitation). When the prescreen passes, or needs staff review, the assistant creates the platform participant (`consent_pending`) and contact (opted in only if the person agreed), presents the active ICF, and from then on mirrors every allowed message into `public.messages`, signs consent into `participant_consents`, files symptoms as `alerts`, writes check-ins as `observations` (completing open `scheduled_assessments`), and asks staff to `confirm_enrollment` after the visit is booked. Staff enrollment on the platform moves the assistant's journey to `active` on its own.

**Mini-apps** (`public/`, `src/web/`): prescreen (one question per screen, generated from the platform's eligibility rules), study overview, e-consent (read, acknowledge key points, teach-back check graded on the server, agree, verify, sign), scheduler (per-site hours and time zones, `.ics` download), check-in (the study's measures), and documents (behind Face ID).

**Face ID**: WebAuthn passkeys (`src/web/verify.ts`). The first verification creates a passkey; after that it's one Face ID scan. Where a browser can't do passkeys (some in-app web views), the person types their full name instead. The signature records which method was used, plus the fingerprint of exactly what they read.

**Shared line**: Charles Sprint answers on the same Photon 1.0 line. TypeSafe's Jev model makes a typed choice per message (`patient_assistant` or `other`), sticky per chat so "yes" and "34" stay with whoever asked; Charles asks `POST http://patient-assistant:3011/route` before replying (`Charles-Sprint/src/line-router.ts`).

More detail: [docs/DESIGN.md](docs/DESIGN.md).

## Try it

**In iMessage**: text the Photon 1.0 line something like "Hi, I saw a flyer about a migraine study". (The line can only start conversations with registered numbers; anyone can text it first.)

**In the terminal**, as any phone number, with cards printed as links you open in a browser:

```sh
npm install
ssh -N -L 15432:localhost:5432 root@<server> &      # Postgres is firewalled; tunnel it
export DATABASE_HOST=localhost:15432 DATABASE_NAME=assistant_demo
npm run chat -- +16175550123
```

**Staff side**: after the screening visit is booked, confirm enrollment as a study coordinator, which moves the person to the active phase:

```sh
npm run enroll -- +16175550123 --due-now     # --due-now opens today's check-in assessments
```

## Databases

| Database | What it is |
|---|---|
| `clinical_trials` | The platform's real database. The `assistant` schema is applied; studies come from the platform team. Until a study is `active`, Sage replies that nothing is recruiting. |
| `assistant_demo` | A copy of the platform schema with one synthetic study (`NORTHSTAR-DEMO`, `db/seeds/demo_study.sql`). The deployed assistant uses it until real studies arrive; set `DATABASE_NAME` to switch. |

```sh
npm run migrate -- status                       # assistant migrations (db/migrations), as developer
npm run migrate                                 # apply; first time, the DB owner runs:
                                                #   grant usage on schema public to patient_assistant;
DATABASE_NAME=assistant_demo npm run seed -- db/seeds/demo_study.sql   # refuses to run on clinical_trials
```

Optional presentation tables let a study team tune what patients see without touching the platform: `assistant.study_profiles` (plain-language summary, time, pay, contact, agent instructions), `assistant.prescreen_questions` (reword a rule's question or add one), `assistant.consent_presentations` (the ICF's readable sections and teach-back questions; without it, a walkthrough is generated from the study record and labeled as such), `assistant.site_hours` (screening-visit hours; default weekdays 9-4).

## Develop

```sh
npm run typecheck
npm test                                                      # domain: eligibility, rule mapping, phases, slots
DATABASE_HOST=localhost:15432 DATABASE_NAME=assistant_scratch npm run test:db   # platform bridge, on a scratch copy
npm run dev                                                   # web + iMessage + router, restarts on change
```

Deploy: `server/deploy.sh Patient-AI-Agent patient-assistant` (the server's `/opt/apps/patient-assistant/.env` holds the secrets; see `.env.example`). The proxy site is `server/proxy/sites/patient-assistant.caddy`.

All data is synthetic. This is a hackathon prototype, not a HIPAA-compliant system.
