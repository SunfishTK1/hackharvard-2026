# ops-home

The trial manager's **portfolio home** (the "Classic" view): one page that says what changed since yesterday, who has the next move, whether enrollment is slowing, what no alert rule caught, and how each study is doing. It is the Claude Design draft "Clinical Trial Ops – Portfolio home", wired to the live `clinical_trials` database. The "Agentic" toggle switches the same page to **Agentic mode**, a conversation with Trial Ops (below).

Address once deployed: https://ops.hackharvard2026.velroi.com

## How it works

- `server.ts`: a small Node server. `GET /api/home` returns the whole page as JSON. It also serves the built React app and `GET /healthz`.
- `home.ts`: the queries and the code that turns rows into the sentences on the page. Everything is computed from the database on each request; nothing is hard-coded from the design mock.
- `src/`: React. It renders `/api/home` and refreshes every 5 minutes and when the tab regains focus. Add `?sources` to the URL (or use the footer link) to show which tables feed each section.

| Section | Source |
| --- | --- |
| Hero, Since yesterday | open high-severity `alerts`, `workflow_tasks` waiting on an investigator, `participant_events` and support `messages` since the start of yesterday |
| Who has the next move | `workflow_tasks` (waiting_review, pending) + unresolved `alerts` + enrolled participants awaiting baseline + unanswered participant messages, grouped by assigned `study_staff`. "Typical" is the median time of completed steps of the same kind. |
| Pipeline speed | `participant_consents.signed_at` → `participants.enrolled_at`, plus open `confirm_enrollment` tasks |
| Blind spots | device-reading gaps (the missing-data rule only watches text replies), participant questions with no staff reply, repeat threshold alerts within 30 days, silence before a scheduled visit; data quality from corrected observations, skipped assessments, failed messages |
| Study health | `studies`, `participants`, `has_current_consent()`, `alerts`, `workflow_tasks`, trial manager from `study_staff` |

Dates and "yesterday" use `America/New_York` (`DISPLAY_TZ`).

## Agentic mode

`?mode=agentic` (or the toggle, which switches in place) turns the page into a conversation with **Trial Ops**, the trial managers' agent from `Patient-AI-Agent/src/ops`. It is the same agent, and the same conversation, as Trial Ops in iMessage: one memory, the same tools, and the same views. Decisions, alerts, studies, participants and analyses are Trial Ops mini-apps, opened in a side panel (a sheet on phones). Decisions open in a new tab, because confirming one takes Face ID in a page of its own. Analyses running on a manager's Daytona computer show as live rows (phase, a four-step stepper, elapsed time), and the full status screen opens in the panel. It's the same screen iMessage opens.

- Sign-in: the manager enters their phone number and Trial Ops texts a one-time link to it, but only to phones an administrator linked (`npm run ops:link` in Patient-AI-Agent). The link lands on `?mode=agentic&signin=…`, and the session is then kept in an `HttpOnly`, `SameSite=Lax` cookie for 7 days.
- `agent-proxy.ts`: the browser only calls this site under `/api/agent/*` (sign-in, session, sign-out, me, messages, chat, views, link, analyses, cancel, report files). The server calls the Trial Ops API (`TRIAL_OPS_API_URL`, default `http://patient-assistant:3012` on the `web` network) with `TRIAL_OPS_API_TOKEN` and the session, so neither reaches page scripts. Cross-site POSTs are refused, and sign-in links are limited to 5 per IP every 10 minutes. Texted links use `PUBLIC_URL`, so a forged Host header can't redirect them.
- `src/Agentic.tsx` and `src/agentic.css`: the workspace. While the tab is visible it polls for new messages every 5 s, because Trial Ops also writes on its own: a finished analysis, or a Face ID link. Analyses are polled every 5 s while one is running, otherwise every 30 s.

Without `TRIAL_OPS_API_TOKEN`, Agentic mode says it isn't connected yet and Classic works as before.

## Database access

The page shows staff names, alert reasons and participant message text. The `analyst` and `manager_agent` roles deliberately can't read those (see `database/README.md`), so the server connects with the trusted `developer` role. Every request runs in a `READ ONLY` transaction with an 8-second statement timeout, tagged `app.request_id = ops-home:<uuid>` for the audit trail. Results are cached for 30 seconds. Credentials stay on the server and never reach the browser.

Before this shows real data, give it a dedicated least-privilege role (SELECT only on the tables in `home.ts`) and put authentication in front of it. Right now anyone with the URL can see it. The data is synthetic only.

## Run locally

```sh
cd ops-home
cp .env.example .env      # set DATABASE_URL to the public TLS endpoint with the developer password
npm install
npm run build && npm run server        # http://localhost:3000
# or, for UI work with hot reload:
npm run server   # terminal 1, API on :3000
npm run dev      # terminal 2, Vite on :5173, proxies /api
```

`npm run server` needs Node 22.6+ (TypeScript type stripping). The Docker image uses Node 24.

## Deploy

```sh
# once, on the server: /opt/apps/ops-home/.env (chmod 600) with
#   DATABASE_URL=postgres://developer:<password>@clinical-db-postgres-1:5432/clinical_trials
#   TRIAL_OPS_API_TOKEN=<the Trial Ops API token, the same value Patient-AI-Agent expects in /opt/apps/patient-assistant/.env>
server/deploy.sh ops-home
```

The proxy route (`server/proxy/sites/ops-home.caddy`) is already live. If it ever needs re-adding, copy just that file to `/opt/apps/proxy/sites/` and run `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` in `/opt/apps/proxy`. A reload doesn't drop other apps' connections. `server/deploy.sh server/proxy proxy` also works, but it deletes any site file on the server that isn't in the repo.

The container joins `web` (for the proxy) and `clinical-db_default` (to reach Postgres without leaving the host).
