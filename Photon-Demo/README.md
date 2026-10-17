# Photon-Demo

An iMessage AI agent built on **Photon 2.0 (beta)** with **Claude Haiku 5.5**. Text the agent's number from your phone and it texts back.

```
iPhone ──iMessage──▶ Photon line ──Socket.IO event──▶ src/agent.ts ──▶ Claude Haiku 5.5
   ▲                                                       │
   └──────────── reply via Photon sendMessage ◀────────────┘
```

## How it works

1. `src/events.ts` keeps a Socket.IO connection open to Photon's live event stream and receives a `message.received` event for each text.
2. `src/agent.ts` ignores everything except a person's text in a direct chat. It shows the typing bubble and reads the last 20 messages of that conversation back from Photon.
3. `src/brain.ts` asks Claude for a reply.
4. The reply goes out through `photon.projects.sendMessage`. Its idempotency key is the incoming message ID, so a replayed event never sends a second reply.
5. After each handled event the agent saves a replay cursor to `.data/cursor.json`. A restart picks up any texts that arrived while it was down.

The agent keeps no chat history of its own; Photon stores it.

## Mini-apps

Text **apps** to see the menu. Claude decides when to use these tools (`src/tools.ts`):

| Tool | Try texting | What happens |
| --- | --- | --- |
| `build_mini_app` | "build me a dinner poll for my friends" | Claude writes a full single-file web app in the background (`src/miniapps.ts`). The agent hosts it at `https://apps.74-208-206-131.sslip.io/m/<id>/` and texts the link about a minute later. |
| `edit_mini_app` | "make the poll buttons bigger" | Rebuilds that app at the same link and keeps its saved data. Only the person who asked for the app can change it. |
| `set_reminder` | "remind me in 20 min to stretch" | Saved in `.data/reminders.json`; the agent texts at that time, even after a restart. |
| (chat games) | "let's play 20 questions" | Claude runs the game in the conversation. |

Each app gets a JSON store at `./state` (`GET` to read, `PUT` to save, 64 KB at most) that everyone with the link shares. That's what makes group polls, leaderboards and shared lists work. Apps may load libraries only from cdnjs, jsDelivr and unpkg, and can't send data anywhere except their own state.

To build an app for someone without them asking (they must have texted the line before):

```sh
# on the server, in /opt/apps/photon-demo
docker compose exec -e MINI_APP_EFFORT=high agent node src/scripts/build-app.ts +14155550123 "Title" "Detailed brief"
```

Native iMessage reactions, polls and threaded replies aren't available on Photon's shared lines; Photon rejects them with `SPACE_NOT_SENDABLE`. That's why polls are mini-apps.

## Setup

Requires Node.js 24 or later. Node runs the `.ts` files directly, with no build step.

```sh
cd Photon-Demo
npm install
npm run doctor      # checks keys, project, iMessage line, event stream and Claude; sends no texts
npm start           # run the agent (npm run dev restarts on file changes)
```

Settings are read from the repo-root `.env` (`photon_20_beta_key`, `photon_project_id`, `Anthropic_API_Key`), then from `Photon-Demo/.env`, then from real environment variables. `.env.example` lists every setting.

### Get a number to text

The Photon project needs an iMessage line. On a **shared** line, each person who wants to text the agent needs an assignment:

- In the dashboard: open [app.beta.photon.codes](https://app.beta.photon.codes), go to **iMessage**, add your own phone number or iMessage email, and assign a number from the shared pool.
- From the CLI (the key needs `platforms:write`): `npm run assign-line -- +14155550123`

Then, from that phone or email, **start a new iMessage chat** with the assigned number and say hi. A shared line can only reply to someone who has messaged it since their assignment, and only in one-on-one chats. Make sure the message goes as iMessage (blue), not SMS.

## Deploy

The agent runs on the team server as the Compose project `/opt/apps/photon-demo` (see [`../server/README.md`](../server/README.md)). To ship changes:

```sh
server/deploy.sh Photon-Demo     # from the repo root
```

Its secrets live in `/opt/apps/photon-demo/.env` on the server (`PHOTON_API_KEY`, `PHOTON_PROJECT_ID`, `ANTHROPIC_API_KEY`). The replay cursor is kept in the `agent-data` volume. Don't run `npm start` locally while the server copy is running, or both will answer every text.

## Customize

| What | Where |
| --- | --- |
| Personality and instructions | `SYSTEM_PROMPT` in `src/brain.ts` |
| Model and effort | `AGENT_MODEL`, `AGENT_EFFORT` (default `claude-haiku-5-5`, `low` for fast replies) |
| How much history the model sees | `HISTORY_LIMIT` |
| Who the agent answers | `ALLOWED_SENDERS` (comma-separated handles) |
| Tools (web search, calendars and so on) | Add `tools` to the `messages.create` call in `src/brain.ts` |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `403` from Photon | The key needs `project:read` and `project:write`, and must belong to `PHOTON_PROJECT_ID`. |
| Agent online but nothing arrives | You texted the assigned number from the assigned handle, as iMessage, in a direct chat. `npm run doctor` lists the assignments. |
| Reply logged but not on the phone | A send is accepted asynchronously. Check **API Activities** in the Photon dashboard. |
| `Claude API rate limit (429)` | The Anthropic key is at its limit. The agent texts back a short apology instead. |

## Files

```
src/agent.ts               entry point: event → typing → history → Claude (with tools) → reply
src/brain.ts               Claude tool runner and system prompt
src/tools.ts               tools Claude can call: build/edit mini-app, set reminder
src/miniapps.ts            mini-app builder, storage, and web server (/m/<id>/, /m/<id>/state)
src/reminders.ts           scheduled texts, saved to disk
src/photon.ts              Photon client helpers (filter, history, send, typing)
src/events.ts              Socket.IO event stream with replay cursor
src/config.ts              settings from .env files and the environment
src/scripts/doctor.ts      setup checks
src/scripts/assign-line.ts assign a shared iMessage number to a sender
src/scripts/send.ts        text someone first: npm run send -- +14155550123 "message"
src/scripts/build-app.ts   build a mini-app for someone and text them the link
```

`npm run send` works from any machine with the keys, and only for people who have texted the line since their assignment. When they reply, the agent sees its own message in the conversation history.

Docs: [Photon 2.0 beta](https://photon.codes/docs/beta/get-started/imessage) · [Live events](https://photon.codes/docs/beta/websocket) · [API reference](https://photon.codes/docs/beta/api-reference)
