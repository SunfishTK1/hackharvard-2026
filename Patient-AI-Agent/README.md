# Patient AI Agent

**Sage**, an iMessage assistant that takes a person from "I saw a flyer" to active study participant: it answers questions, prequalifies them, walks them through informed consent and collects an e-signature verified with Face ID, books the screening visit, and once they are enrolled, collects check-ins and flags side effects. Rich steps happen in **mini-apps** that open inside iMessage (Photon Spectrum app cards); the conversation stays in the chat.

It runs on the team's **consent-first platform** database (`clinical_trials`, built by the platform team) and adds one schema, `assistant`, beside it. Study content (studies, sites, arms, eligibility rules, measures, approved ICFs) comes from the platform; the assistant writes to the platform only through guarded functions, so the platform's rules (opt-in, approved and active ICF, lifecycle, value types) still apply to everything it does.

Live: https://patient.hackharvard2026.velroi.com (mini-apps) · iMessage: the Photon 1.0 line (+1 415-605-6081), shared with Charles Sprint.

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

**Mini-apps** (`public/`, `src/web/`): prescreen (one question per screen, generated from the platform's eligibility rules), study overview, e-consent (read, acknowledge key points, teach-back check graded on the server, agree, verify, sign), scheduler (per-site hours and time zones, `.ics` download), check-in (the study's measures), documents (behind Face ID), and, once enrolled, the study page: week and progress, today's tasks, next visit, report a symptom (urgent ones show call 911), visits, pause or stop. Three cards open one screen of it directly: `symptom`, `visit` (a reminder for the next visit) and `week` (check-ins and reading trends).

**Design**: the mini-apps follow the "Sage Mini-App Components" canvas (Claude Design), in Apple's style: a thin translucent top bar, an eyebrow over a big short headline, white pages with gray cards or gray pages with white cards, one accent (#0071E3), pill buttons, and Liquid Glass only on floating controls (the action bar and its ••• options menu, which sit outside `<main>` as siblings on one dock so neither blurs the other). Card images (`src/cards/image.ts`) are the canvas's black cards: study code, a pill badge, a headline with a period.

**Voice** (`src/voice/`, `public/assets/voice.js`): "Answer by voice" in the prescreen and check-in runs on the Grok Voice Agent API. The server mints a five-minute client secret and writes the session (Sage's instructions, the questions, a `record_answer` tool); the page streams the microphone as 24 kHz PCM over `wss://api.x.ai/v1/realtime`, plays Grok's voice, and checks every answer Grok records with the server exactly like a tap. Nothing is saved until the person reviews and sends. The glass bar has mute, the primary action, and a menu (repeat the question, mute, use buttons, end). In the chat, a voice message is transcribed with xAI speech-to-text and Sage answers with a voice note (xAI text-to-speech, voice `eve`); ffmpeg converts iMessage audio. Set `XAI_API_KEY`.

**Face ID** (`src/web/verify.ts`, `ios/`): Photon's iMessage extension can't use Face ID for our domain. In that view the card hands off to Safari: a one-time link opens `/v/<token>`, a passkey (Face ID) verifies the person, the server completes the action, and the card in Messages moves on by itself. Sage also has its own iOS app. Cards for people listed in `NATIVE_CARD_HANDLES` are sent as `customizedMiniApp` cards that open the Sage app's Messages extension, which shows the same mini-app pages with a native bridge: Face ID unlocks a Secure Enclave P-256 key (one per person, `.biometryCurrentSet`), the key signs a one-time server challenge, and the server verifies the signature and registers the key on first use. In Safari, WebAuthn passkeys do the same. Typing a full name is always the fallback. The signature records which method was used, plus the fingerprint of exactly what they read.

**The Sage iOS app** (`ios/`, XcodeGen): `cd ios && xcodegen`, put your Team ID in `ios/Config/Local.xcconfig` (`SAGE_TEAM_ID = ABCDE12345`), open `Sage.xcodeproj`, and run the Sage scheme on your iPhone (the app's "Test Face ID" button checks Face ID end to end on the device). Then set `IMESSAGE_TEAM_ID` (same Team ID) and `NATIVE_CARD_HANDLES` (comma-separated phone numbers, or `*`) in the server's `.env` so those people's cards open the app.

**Shared line**: Charles Sprint answers on the same Photon 1.0 line. TypeSafe's Jev model makes a typed choice per message (`patient_assistant` or `other`), sticky per chat so "yes" and "34" stay with whoever asked; Charles asks `POST http://patient-assistant:3011/route` before replying (`Charles-Sprint/src/line-router.ts`).

More detail: [docs/DESIGN.md](docs/DESIGN.md).

## Try it

**In iMessage**: text the Photon 1.0 line something like "Hi, I saw a flyer about a migraine study". (The line can only start conversations with registered numbers; anyone can text it first.)

**In the terminal**, as any phone number, with cards printed as links you open in a browser. Use a scratch copy of the database, since a journey creates platform participants:

```sh
npm install
ssh -N -L 15432:localhost:5432 root@<server> &      # Postgres is firewalled; tunnel it
export DATABASE_HOST=localhost:15432 DATABASE_NAME=assistant_scratch   # see "Databases"
npm run chat -- +16175550123
```

**Staff side**: after the screening visit is booked, confirm enrollment as a study coordinator, which moves the person to the active phase:

```sh
npm run enroll -- +16175550123 --due-now     # --due-now opens today's check-in assessments
```

## Trial Ops: the trial manager's agent

**Trial Ops** (`src/ops`) is the study team's side, in the same service: an iMessage agent and mini-apps on the same data as the ops website (https://ops.hackharvard2026.velroi.com). A manager asks "what needs my attention today?", "which enrollments are waiting on me?", "show me STUDY-005-P010's blood pressure" or "spin up a computer and forecast enrollment against target", and gets a short answer plus a mini-app card.

- **Line.** Its own Photon project, "Trial Ops", with its own line per person (Thomas texts +1 415-603-5536, Bessie +1 646-579-2868; `photon spectrum users list --project b20be7b3-1c05-43ce-8a34-cc6c2a442ac9`). Every text there goes to Trial Ops; people who aren't linked managers are told the line is for study teams. Without `TRIAL_OPS_SPECTRUM_PROJECT_ID`/`_SECRET`, linked managers reach it on Sage's line by texting "ops" ("sage" switches back).
- **Who.** Only phones an administrator links: `npm run ops:link -- +16175550123 "Jordan Lee" --managers` (every study's trial manager identity) or `--as drew.foster,riley.adams`. `npm run ops:link -- --list` shows them.
- **Data.** It runs as the platform's `manager_agent` role (`TRIAL_OPS_DATABASE_URL`) and reads only the `ops.*` views (migration `20261018010000_trial_ops`): studies, sites, participants, consents, events, alerts, tasks, assessments, readings, the message log, and Sage's funnel. No contact details, signatures or consent evidence.
- **Mini-apps** (`/o/<token>`, `public/ops.html`): portfolio, decisions, alert queue and alert, study, participant (readings charts), pipeline, data quality, and analyses.
- **Decisions.** Confirm or decline an enrollment, record a baseline visit, sign off a safety review, acknowledge or resolve an alert. The agent only prepares them (`ops.approvals`); the manager confirms with Face ID (a passkey; in Photon's iMessage view, a link texted to open in Safari), and `ops.execute_approval` carries it out as their own staff identity for that study, which the platform's triggers check. Sage then tells the participant when Sage is their contact.
- **Analyses on Daytona.** "Spin up a computer…" hands the work to an analyst agent on the manager's own Daytona sandbox (Python data stack; 2 CPU / 4 GB by default) with a fresh CSV snapshot of the `ops.*` views, minus message text. Its live status card (computer, data, each step with timing, report) updates in place when done, and the report (summary, findings, charts, tables) stays in `ops.analyses`. Computers come in three sizes the agent picks from the request: standard (2 CPU / 4 GB), large (4 CPU / 8 GB) and GPU (1 NVIDIA GPU, 4 CPU / 16 GB; Daytona runs those as ephemeral and needs GPU credits on the account). One at a time per manager; computers stop after 30 idle minutes. Needs `DAYTONA_API_KEY`.
- **Sage's escalations.** The moment Sage escalates a case (a symptom, a question it can't answer, a call or visit-change request, someone stopping, a prescreen to review), Trial Ops texts every manager linked to that study, whatever the severity, with the alert card; people still screening are covered too. Only "alerts off" silences it.
- **Reaching out.** Once a minute it checks for new alerts at each manager's studies (high and critical by default) and texts them, several in one message, with the alert card; and it sends a morning briefing at 8:00 with the portfolio card. Managers change both by asking ("only critical alerts", "briefing at 7:15", "stop the briefing") or on the mini-app's Notifications screen. `ops.notices` keeps each one from going twice.
- **For other apps.** The core is channel-free (`core.ts`). The ops website's Agentic mode uses the internal API (`api.ts`, port 3012 on the Docker network, `TRIAL_OPS_API_TOKEN`): sign-in by a link texted to the manager, chat in the same conversation as iMessage, every view, mini-app links, analyses. `src/ops/index.ts` exports everything for use in code.

When someone signs the informed consent, the site's principal investigator gets an email through Resend (`src/notify/consent.ts`): the participant's code, study, site, ICF version and time, the identity check, Sage's prescreen and the next step. No name or contact details. `PI_EMAIL` (bl108@wellesley.edu on the server) replaces the synthetic investigators' addresses; Resend only delivers to other people from a verified sender domain (`EMAIL_FROM`).

Sage's writes follow the platform's conventions so ops sees Sage's participants like any other (migration `20261018000000_ops_data_flow`): readings are judged by each study's alert rules, every alert is assigned (the investigator gets safety reviews, with a review task), a second check-in in the same window corrects the first, consent steps are participant events, and enrollment requests go to the site investigator.

## Databases

The deployed assistant runs on `clinical_trials`, the platform's database, with the platform team's five synthetic studies (STUDY-001 migraine, -002 type 2 diabetes, -003 depression, -004 solid tumors, -005 hypertension). New contacts start on the most recently updated active study (or `DEFAULT_STUDY`), and Sage switches to the one that matches what the person is looking for (`choose_study`). People who reach consent become real (synthetic) participants there, numbered after the study's own (`STUDY-001-P009`).

For experiments, make a scratch copy on the server (as postgres): `createdb -T template0 assistant_scratch`, `pg_dump clinical_trials | psql assistant_scratch` (add `--schema-only` for an empty one), then `grant create on database assistant_scratch to app_owner` and, in it, `grant usage on schema public to patient_assistant`. `db/seeds/demo_study.sql` adds a synthetic study set up the way the platform requires (`NORTHSTAR-DEMO`, with presentation rows); it refuses to run on `clinical_trials`.

```sh
npm run migrate -- status                       # assistant migrations (db/migrations), as developer
npm run migrate                                 # apply; first time, the DB owner runs:
                                                #   grant usage on schema public to patient_assistant;
DATABASE_NAME=assistant_scratch npm run seed -- db/seeds/demo_study.sql
```

Optional presentation tables let a study team tune what patients see without touching the platform: `assistant.study_profiles` (plain-language summary, time, pay, contact, agent instructions), `assistant.prescreen_questions` (reword a rule's question or add one), `assistant.consent_presentations` (the ICF's readable sections and teach-back questions; without it, a walkthrough is generated from the study record and labeled as such), `assistant.site_hours` (screening-visit hours; default weekdays 9-4).

## Develop

```sh
npm run typecheck
npm test                                                      # domain: eligibility, rule mapping, phases, slots
DATABASE_HOST=localhost:15432 DATABASE_NAME=assistant_scratch npm run test:db   # platform bridge, on a scratch copy with demo_study.sql
npm run dev                                                   # web + iMessage + router, restarts on change
```

Deploy: `server/deploy.sh Patient-AI-Agent patient-assistant` (the server's `/opt/apps/patient-assistant/.env` holds the secrets; see `.env.example`). The proxy site is `server/proxy/sites/patient-assistant.caddy`.

All data is synthetic. This is a hackathon prototype, not a HIPAA-compliant system.
