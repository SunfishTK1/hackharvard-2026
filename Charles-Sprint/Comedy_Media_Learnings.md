# Comedy and Media Learnings (Claude, Grok Imagine, xAI voice, Spectrum)

Notes from making First Light (called LastLight until the rebrand) funny and giving it memes, meme videos, voice notes and a one-minute origin film.
Code: `src/brain.ts` (prompt and tools), `src/media.ts` (xAI calls), `src/captions.ts` (meme text), `src/agent.ts` (sending), `film/make-film.ts` (the film).
For cards, contact cards and deploys, see `iMessage_Card_Learnings.md`.

## Making Claude funny

What failed: the first prompt said "always include a joke about Boston". Haiku answered with generic setups ("Why did the rower...?") that ignored what the person said. Asking for "a joke" gets the most average joke.

What worked, all in `PERSONA` in `src/brain.ts`:

- **A bar and a voice.** "A sharp late-night staff writer who grew up in Somerville"; "a line a local would screenshot and send to the group chat". Deadpan, understated, never laughing at its own joke.
- **A method, not a request for jokes.** Find the hook in their message, tie it to one real local detail, break the expectation in the last few words, cut every spare word. Quietly consider three angles and use the most surprising one.
- **Named moves.** Misdirection, a list of three that breaks on the third, a fake official notice (MBTA service alert, regatta rulebook), an oddly precise number, cosmic scale on small Boston problems, callbacks to earlier in the chat.
- **Banned patterns.** "Why did the ...?" setups, puns as the whole joke, announcing the joke, tourist clichés ("wicked", "Dunkin' runs Boston"), opening with "Ah" or "Oh", reusing a premise, punching down.
- **A bank of true local material.** Storrowing on moving day, the B branch, the Smoot, the "statue of three lies", the Eliot Bridge turn, HackHarvard at 4 a.m. Specific true details beat invented ones.
- **An example bar.** Five sample replies at the quality we want, marked "don't reuse".

Before (Haiku 5.5, old prompt): "Why did the rower bring a ladder to the Charles? To get over the Harvard Bridge!"
After (Sonnet 5.5, new prompt), for "make me a meme about the green line being slower than my rowing":
"Filed under the regatta rulebook: facing backwards is not a handicap against the T." plus a meme captioned "Rowing backwards up the Charles / Still beating the B branch".

### Model choice

Same messages through each model, on the server:

| Model | Setting | Typical reply time | Humor |
| --- | --- | --- | --- |
| `claude-haiku-5-5` | low effort | ~1.8 s | Weak, generic. **Default** (the API key has a usage limit). |
| `claude-sonnet-5-5` | low effort | ~2.2 to 3.7 s | Sharp, specific |
| `claude-opus-5-5` | adaptive thinking | ~5.7 s | Good |
| `claude-fable-5-1` | adaptive thinking | ~4.7 s, once 13.6 s | Funniest, but uneven and sometimes slow |

Change it without code: `AGENT_MODEL`, `AGENT_EFFORT` (`low`/`medium`/`high`) and `AGENT_THINKING=on` in the server `.env`.

### API quirks

- Thinking can't be turned off the same way everywhere. Haiku accepts `thinking: { type: "disabled" }`; Sonnet rejects it (it only takes `between_tools`), and Opus and Fable only take `adaptive`. So "off" means **omit `thinking`**.
- Claude often writes a line before a tool call ("I'll make you a meme") and the real reply after it. Keep only the **last** text block.
- The system prompt is long, so it is sent as its own block with `cache_control: { type: "ephemeral" }`. The per-chat context (leaderboard, recent extras) goes in a separate block after it, so the cache still hits.
- To keep memes occasional, the context says how many replies ago the last extra was ("Your last extra in this chat was a meme picture, 3 of your replies ago."). Cooldowns in code back this up: image 60 s, video 5 min, voice 30 s per chat. Only the kinds off cooldown are offered as tools.

## Grok Imagine pictures

- `POST https://api.x.ai/v1/images/generations` with `{ model: "grok-imagine-image-2.0", prompt, aspect_ratio: "1:1", response_format: "b64_json" }`. Returns JPEG as base64. About 12 s and $0.04 each.
- Image models misspell words, so **never ask for text in the image**. Add "No text, letters, signs or captions anywhere in the image" and draw the meme captions ourselves (`src/captions.ts`: resvg, Liberation Sans Narrow, white with a black stroke, shrunk to fit).
- Style words sell the joke: "photorealistic news photo", "security camera still", "Renaissance oil painting", "1990s yearbook photo".
- `quality` takes only `low`, `medium` or `auto`; `high` is rejected with a 400.
- The rate limit is about 6 requests per second. Firing nine at once got a `429`; retrying with backoff worked.
- The xAI key must be stored **without quotes**. A quoted value in `.env` sends the quotes too, and xAI answers "Incorrect API key".

## Grok Imagine video

- `POST /v1/videos/generations` with `{ model, prompt, duration, aspect_ratio, resolution }` returns `{ request_id }`. Poll `GET /v1/videos/{id}` until `status` is `done`, then download `video.url`.
- `grok-imagine-video-1.5-lite`: a 6 s meme video takes about 30 s (480p about 27 s, 720p about 35 s end to end) and costs about $0.12. Videos come with sound.
- `grok-imagine-video-1.5` (full) for the film, image-to-video: pass a keyframe as `image: { url: "data:image/jpeg;base64,..." }`. The output keeps the input image's shape, so pad a square image to 16:9 first.
- A line of dialogue in double quotes can come out as a garbled speech bubble drawn in the frame. Always append "No on-screen text, subtitles, captions or speech bubbles."
- Returned clips run about 0.04 s longer than asked.

## xAI voice (text to speech)

- `POST https://api.x.ai/v1/tts` with `{ text, voice_id, language: "en", output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 128000 }, speed, replace }`. Fast: the whole voice note, including the send, took about 4 s.
- Voices (`GET /v1/tts/voices`) we use: `sirius` (First Light, dry), `helix` (sportscaster), `zagan` (movie trailer), `orion` (documentary). `speed` takes 0.7 to 1.5; the narrator voices sound better a little faster (1.1).
- Inline tags: `[pause] [long-pause] [laugh] [chuckle] [giggle] [sigh] [breath] [inhale] [exhale] [tsk] [tongue-click] [lip-smack] [hum-tune] [cry]`.
- Wrapping tags: `<whisper> <soft> <loud> <emphasis> <slow> <fast> <higher-pitch> <lower-pitch> <build-intensity> <decrease-intensity> <sing-song> <singing>`, closed like HTML.
- Unknown tags are read out loud, so `cleanScript` strips anything not on the lists, plus emoji and URLs.
- We checked with xAI speech to text (`POST /v1/stt`) that tags are performed, not spoken. Leave text normalization off.
- Fix pronunciation with `replace` (`FirstLight` -> `First Light`, `HackHarvard` -> `Hack Harvard`), so the written script keeps the real spelling.
- What makes a voice note funny: one to four short sentences, numbers spelled as said, `[pause]` right before the punchline, two to four tags per clip.

## Sending media with Spectrum

- Pictures and videos: `space.send(attachment(buffer, { name, mimeType }))`.
- Voice notes: `space.send(voice(buffer, { name, mimeType }))` arrives as an iMessage audio message. The SDK converts to m4a with **ffmpeg**, which must be on `PATH` (installed in the `Dockerfile`).
- Send the text first, then the extra. The text sets up the joke; the extra lands as the punchline.
- Make the media **outside** the per-chat queue and queue only the send. Otherwise a 35 s video holds up every reply in that chat.
- A 24 MB, 65 s video went through fine. The container's memory limit is 256 MB, so keep files to tens of MB.
- Admin sends through the running agent (`src/scripts/send-card.ts`):
  - `+1XXXXXXXXXX file /path/in/container.mp4 "caption"` sends a file. Copy it in first with `docker compose cp file app:/tmp/`.
  - `+1XXXXXXXXXX media '{"kind":"voice","voice":"sportscaster","script":"..."}' "caption"` makes and sends one extra, skipping the cooldowns. Check `docker compose logs app` for `agent: sent voice in 4.1 s`.

## The origin film (`film/make-film.ts`)

- The current film is First Light's (`film/out/first-light/firstlight-origin.mp4`); the earlier LastLight cut is in `film/out/`. To make another, edit `SHOTS`, `LOOK` and the title card, and point `OUT` at a new folder so nothing stale is reused.
- The last shot's keyframe uses the same composition as the avatar, so the film ends on the brand image.

- **Narration first.** Generate the voice clips, measure them, and size each shot to its lines. Check the total against `MAX_LENGTH` before paying for any keyframe or video.
- One shared `LOOK` paragraph in every keyframe prompt keeps nine shots looking like one film. Each shot is keyframe (image model) then image-to-video, so the framing is controlled.
- Every step caches its output file in `film/out/`, so a rerun only redoes deleted files.
- **Stale cache bug:** after the narration was tightened (76 s to 65 s), the shots filmed for the old lengths were still cached. The crossfade offsets no longer matched the clip lengths and the cut came out broken (76 s, thousands of decode errors). Two runs writing the same output at once also corrupts it. Now a clip longer than its slot is sped up (at most 1.5x) instead of cut, so cached shots still fit, and the motion still lands.
- Normalize every clip to the same size, frame rate and stereo track before `xfade` / `acrossfade`, or the filter graph fails.
- Always verify the result: `ffmpeg -v error -i film.mp4 -f null -` must print nothing, and `ffprobe` must show the expected length. Then look at a contact sheet (`-vf fps=1/4,scale=426:-2,tile=4x4`).
- The master is about 47 MB. For iMessage, re-encode with `-crf 23 -maxrate 4M -bufsize 8M` (about 24 MB, no visible loss).
- `film/` is excluded from deploys (`.deployignore`, `.dockerignore`). It runs locally.
