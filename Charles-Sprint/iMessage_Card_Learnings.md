# iMessage Card Learnings (Photon Spectrum)

Notes from building Charles Sprint as an iMessage mini app on Photon Spectrum (`spectrum-ts@^12.11.0`).
They cover how cards render, how to update them in place, and what tripped us up.

## Project and line

- Spectrum Cloud project: `hackharvard-2026`. Credentials live in `.env` (`PROJECT_ID`, `PROJECT_SECRET`); never commit or print them.
- The project sends from Photon's shared iMessage line **+1 415-605-6081**.
- On a shared line, the agent can only message **registered project users**. If a user has no phone number on the project, sends fail with `account_phone_missing`. Fix it on the Photon dashboard (add the user's phone), not in code.
- Inbound messages from anyone texting the line arrive on `app.messages`, so "text the number to get a card" works without registration for replies.

## Two kinds of cards

| Builder | Extension that opens | Needs |
| --- | --- | --- |
| `app(url, { layout, live })` from `spectrum-ts` | Photon's own Spectrum extension (`codes.photon.Spectrum.MessagesExtension`, team `P8XT6232SL`). It opens `url` in a web view. | Nothing extra. Works for anyone with iMessage. |
| `customizedMiniApp({ appName, teamId, extensionBundleId, appStoreId?, url, layout, live? })` from `spectrum-ts/providers/imessage` | Your own Messages extension (for us the Swift target in `ios/`). | A 10-character Apple Team ID and a signed, installed app. Recipients without it are pointed to `appStoreId` if set. |

## `live` decides whether the card is cut off

- `live: true`: the extension draws the bubble itself, inside the transcript. For Photon's web extension this means **the web page is rendered inside the small chat bubble**. A full game does not fit, so it looks cut off. This was the cause of our cutoff bug.
- `live` unset or `false`: iMessage draws a **static** `MSMessageTemplateLayout` card from `layout` (image + captions). Tapping it opens the extension in the **expanded sheet**, nearly full screen, where the game has room.
- Use static cards for anything interactive. Put the "glanceable" info (record, leaderboard) into the card image and captions instead.

## Layout rules (validated by zod before send)

- Slots: `caption`, `subcaption`, `trailingCaption`, `trailingSubcaption`, `image`, `imageTitle`, `imageSubtitle`, `summary`.
- At least one of `caption`, `subcaption`, `trailingCaption`, `trailingSubcaption`, `image` must be set.
- `image` and `imageTitle` must be set **together**. `imageSubtitle` requires `image`.
- Every string must be non-empty. Use a placeholder like `–` rather than `""`.
- `image` is JPEG bytes as a `Uint8Array`. iMessage draws `imageTitle`/`imageSubtitle` over the bottom-left of the image, so keep that corner free of important art.
- `summary` is the fallback text for surfaces that cannot draw the card (notifications, older devices). It is not a visible slot.
- The image is shown about 250-300 pt wide, so text drawn into it must be large (title 50 px+, key number 120 px+ on a 1200 x 800 image).

## Dynamic card images

- We render the card image on the server: SVG string -> `@resvg/resvg-js` (PNG pixels) -> `jpeg-js` (JPEG bytes). Background art is `public/card-bg.jpg`, embedded in the SVG as a base64 data URI.
- `node:24-slim` ships **no fonts**, so resvg draws no text. Install fonts in the Dockerfile (`fonts-liberation`) and pass `font: { loadSystemFonts: true, defaultFontFamily: "Liberation Sans" }`.
- resvg ships per-platform native binaries as optional deps. The lockfile from macOS already lists `@resvg/resvg-js-linux-x64-gnu`, and `npm ci` inside the glibc (`-slim`, not Alpine) image installs it. The server is x86_64.
- Cache the rendered JPEG by a key of what it shows (record, top 3, last race), since renders take tens of milliseconds.

## Updating a card in place

- `space.send(card)` returns the sent `Message`. For card sends it carries `miniAppCardSession` (`chatGuid`, `messageGuid`, `sessionId`, `targetMessageGuid`).
- Update in place with `space.send(edit(newCard, sentMessage))` or `sentMessage.edit(newCard)`. This calls Advanced iMessage `updateCustomizedMiniApp(session, ...)` and replaces the bubble instead of posting a new one.
- Edits **require** `miniAppCardSession` from the original send. Without it the SDK throws `mini app card edits require a miniAppCardSession from the original send`.
- After each edit the SDK writes the new session back onto the target message object. Persist the latest session if you need edits after a restart.
- Only outbound messages can be edited (`edit()` checks `direction === "outbound"`). The target must pass the SDK's `isMessage` check, so pass a real `Message`, not a hand-made object.
- After a restart: rebuild the space with `imessage(app).space.get(spaceId)` and the message with `space.getMessage(messageId)`, then attach the saved session. If that fails, fall back to a plain text result instead of spamming new cards.
- Text edits work only for `text` content; cards must be edited with `app` or `customizedMiniApp` content.

## Linking a game run back to its chat

- The web game runs inside Photon's extension and has no access to the chat. Put a random per-chat token in the card URL (`?c=<token>`), have the page send it with the score, and map token -> `{ spaceId, card messageId, session }` on the server.
- Validate the token format server-side and treat it as a capability: anyone holding it can post a result to that chat.

## Inbound cards

- Cards sent from a user's extension (for example our Swift extension updating its own card) arrive as `app` content. `await content.url()` gives the URL, so encode results in it (`t=` seconds, `n=` name).
- Inbound app layouts drop `imageTitle`/`imageSubtitle` (no image bytes arrive). `imessage(message).miniApp` has the raw metadata, including `sessionId`.

## Effects and replies

- `effect(text, imessage.effect.message.confetti)` sends a screen effect. We use it for course records only.
- Queue replies per `space.id` so answers arrive in order.

## Agent identity (LastLight contact card)

- The project profile holds the agent's name and photo: `photon spectrum profile update --first-name LastLight --project <id>` and `photon spectrum avatar upload <png> --project <id>`.
- `photon spectrum avatar upload` needs Bun. Under Node it fails with `Bun is not defined`; run it as `bun "$(npm root -g)/@photon-ai/cli/dist/photon.js" spectrum avatar upload ...`.
- The profile only reaches the iMessage account on **dedicated** lines (`photon spectrum profile sync`; automatic name/photo sharing is gated behind `imessageSynced`). On a shared line, `nativeContactCard()` / `space.shareContactCard()` shares Photon's shared Apple account card, not ours.
- On a shared line, send a vCard instead: `contact({ name, phones, org, urls, note, photo: { mimeType, read } })`. Saved contacts show our name and photo.
- Shared-line users can be assigned **different numbers** (one teammate got +1 415-605-6081, another +1 628-289-3536), so one hard-coded number is wrong for someone.
- In shared mode `space.phone` is the literal string `"shared"`, not a number. Putting it in a vCard gives a card with no usable phone number.
- Look the number up instead: `GET https://spectrum.photon.codes/projects/<id>/users` with `Authorization: Basic base64(PROJECT_ID:PROJECT_SECRET)` returns `{ data: { users: [{ phoneNumber, assignedPhoneNumber, ... }] } }`. Map the chat's address (the end of a DM chat id, `any;-;+15551234567`) to `assignedPhoneNumber`. See `src/lines.ts`; `IMESSAGE_LINE` is the fallback.
- Text CONTACT to the agent, or run `send-card.ts +1XXXXXXXXXX contact`, to send the LastLight card.

## LastLight's brain (Claude)

- Every text goes to Claude (`claude-haiku-5-5`, low effort, about 1.5 to 2.5 s). The system prompt is `SYSTEM_PROMPT` in `src/brain.ts`: persona, a joke in every reply about Boston, MIT, the Head of the Charles or HackHarvard tied to the message, and the game rules.
- Claude attaches things through tools (`send_race_card`, `send_leaderboard`, `send_contact_card`). The agent sends the text first, then the attachments. A chat without a race card always gets one.
- Each request includes the current leaderboard and whether the chat has a card. History is the last 20 turns per chat, in memory only.
- Race results are announced in LastLight's voice (`brain.announce`), with confetti for course records.
- Web search is Anthropic's server tool (`web_search_20260318`, `max_uses: 3`, location Boston), listed next to our own tools in the tool runner, which also handles `pause_turn`. Replies that search take about 7 s instead of about 2 s. Claude often writes "let me look that up" before searching, so only text after the last `server_tool_use` / `web_search_tool_result` block is sent.
- Without `ANTHROPIC_API_KEY`, or when Claude fails, the agent falls back to fixed replies plus a joke from `src/jokes.ts`.
- To test the prompt on the server without texting: pipe a script that imports `/app/src/brain.ts` into `docker compose exec -T app node --input-type=module`.

## Native Swift extension

- `ios/` is generated with XcodeGen (`ios/project.yml`). Set `CHARLES_TEAM_ID` in `ios/Config/Local.xcconfig` (gitignored) to sign.
- Building needs the iOS simulator runtime that matches the Xcode SDK (we needed iOS 18.4, build `22E238`). Remove it later with `xcrun simctl runtime delete 22E238`.
- To make the agent send native cards, set `IMESSAGE_TEAM_ID` (and optionally `IMESSAGE_EXTENSION_BUNDLE_ID`, `IMESSAGE_APP_STORE_ID`) in the server `.env`. Without them it sends the web card.

## Deploying and sending a test card

- Deploy: `server/deploy.sh Charles-Sprint`. The server prompts for a password, so SSH needs an askpass helper exported in the same command.
- Live at https://sprint.hackharvard2026.velroi.com behind the shared Caddy proxy (`server/proxy/sites/charles-sprint.caddy`).
- Send a card through the running agent (so it can edit that card later): `docker compose exec -T app node src/scripts/send-card.ts +1XXXXXXXXXX [web|native]`. The script calls a localhost-only admin port inside the container.
- `docker compose exec -T` reads stdin. Inside an `ssh host bash -s <<EOF` script it swallows the rest of the script, so add `</dev/null` to each exec.
- The app runs `.ts` files directly with Node 24's type stripping. Node rejects syntax that needs compiling, such as constructor parameter properties (`constructor(private x: T)`), and the container crash-loops. `tsc` did not catch it until we set `"erasableSyntaxOnly": true` in `tsconfig.json`.
