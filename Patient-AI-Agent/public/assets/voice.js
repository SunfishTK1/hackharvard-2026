// Answer by voice: a live conversation with Grok (xAI Voice Agent API). The server hands over a
// short-lived secret and the session (Sage's instructions, the questions, a record_answer tool);
// the page streams the microphone as 24 kHz PCM, plays Grok's voice, and checks every answer Grok
// records with the server, exactly like a tap. Nothing is sent until the person reviews and submits.
// Layout: one orb, Sage's words in big type, what was heard so far, and a glass bar with a mute
// toggle, the primary action, and an options menu.
import { actionbar, api, h, icons, optionsMenu, roundButton } from "./ui.js?v=10";

const RATE = 24000;
const STATES = {
  idle: "Tap to start.",
  connecting: "One moment.",
  thinking: "One moment.",
  speaking: "Sage is speaking.",
  listening: "Listening.",
  hearing: "Listening.",
  muted: "Your microphone is off.",
  done: "All done.",
};

const toBase64 = (bytes) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/**
 * Runs the voice screen. `items` are [{ key, label }] for the heard-so-far list; `onAnswer(key,
 * value, display)` keeps each checked answer; `onFinish()` runs when Grok has asked everything (or
 * they end with answers); `onExit()` goes back to the buttons.
 */
export function voiceScreen({ show, eyebrow, title, hint, items, onAnswer, onFinish, onExit }) {
  const labels = new Map(items.map((i) => [i.key, i.label]));
  const heard = new Map();
  // The checked values so far, sent with each answer so the server can cross-check them.
  const values = new Map();
  let ctx, stream, ws, node, playHead = 0, finishing = false, closed = false, responding = false, muted = false, started = false;
  const playing = new Set();
  // Tool calls from the response in progress; answered together once it's done.
  let calls = [];

  const orb = h("button", { type: "button", class: "voice-orb", "aria-label": "Start talking with Sage" },
    h("span", { class: "glyph g-mic", html: icons.mic }),
    h("span", { class: "glyph g-muted", html: icons.micOff }),
    h("span", { class: "glyph g-done", html: icons.check }),
    h("span", { class: "bars", "aria-hidden": "true" }, h("i"), h("i"), h("i")));
  const state = h("p", { class: "voice-state", "aria-live": "polite" });
  const caption = h("p", { class: "voice-caption", "aria-live": "polite" });
  const you = h("p", { class: "voice-you" });
  const hintLine = h("p", { class: "voice-hint" }, hint ?? "Sage asks. You answer out loud. Nothing is sent until you check it.");
  const list = h("div", { class: "card list" });
  const heardBlock = h("div", { class: "voice-heard hidden" }, h("h2", { class: "section-title" }, "Heard so far"), list);
  const error = h("div", { class: "error", role: "alert" });
  const mic = roundButton("mic", "Mute microphone", () => setMuted(!muted));
  mic.setAttribute("aria-pressed", "false");
  mic.disabled = true;
  const primary = h("button", { type: "button", class: "btn plain grow", onclick: () => end() }, "Not now");
  const more = roundButton("more", "More options");

  let current = "idle";
  const setState = (name) => {
    current = name;
    const shown = muted && (name === "listening" || name === "hearing") ? "muted" : name;
    orb.dataset.state = shown;
    state.textContent = STATES[shown];
    orb.setAttribute("aria-label", shown === "idle" ? "Start talking with Sage" : shown === "muted" ? "Unmute and talk" : STATES[shown]);
  };
  const setMuted = (value) => {
    muted = value;
    mic.setAttribute("aria-pressed", String(muted));
    mic.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
    mic.innerHTML = muted ? icons.micOff : icons.mic;
    stream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    setState(current);
  };
  const renderList = () => {
    heardBlock.classList.toggle("hidden", heard.size === 0);
    primary.textContent = heard.size ? "Review answers" : "Not now";
    primary.className = `btn grow${heard.size ? "" : " plain"}`;
    list.replaceChildren(...[...heard].map(([key, display]) => h("div", { class: "row" },
      h("span", { class: "mark on", "aria-hidden": "true" }),
      h("span", { class: "text" }, h("small", {}, labels.get(key) ?? key), h("b", {}, display)))));
  };

  const stopPlayback = () => {
    for (const source of playing) { try { source.stop(); } catch {} }
    playing.clear();
    playHead = ctx ? ctx.currentTime : 0;
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { ws?.close(); } catch {}
    stream?.getTracks().forEach((t) => t.stop());
    node?.disconnect();
    stopPlayback();
    ctx?.close().catch(() => {});
  };
  // Leave the voice screen: to the review if anything was heard, otherwise back to the buttons.
  const end = () => { cleanup(); heard.size ? onFinish() : onExit(); };

  const play = (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    if (!pcm.length) return;
    const buffer = ctx.createBuffer(1, pcm.length, RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    playHead = Math.max(playHead, ctx.currentTime + 0.03);
    source.start(playHead);
    playHead += buffer.duration;
    playing.add(source);
    source.onended = () => {
      playing.delete(source);
      listen();
    };
    if (!finishing) setState("speaking");
  };
  // Audio arrives in bursts, so "listening" waits until the whole response has played.
  const listen = () => {
    if (!playing.size && !responding && !finishing && !closed) setState("listening");
  };

  const send = (event) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(event));

  const handleTool = async (msg) => {
    let output;
    if (msg.name === "record_answer") {
      if (!playing.size) setState("thinking");
      let args = {};
      try { args = JSON.parse(msg.arguments || "{}"); } catch {}
      output = await api("voice-answer", { key: args.key, answer: args.answer, heard: Object.fromEntries(values) }).catch((e) => ({ ok: false, error: e.message }));
      if (output.ok) {
        if (output.value === null) values.delete(output.key); else values.set(output.key, output.value);
        onAnswer(output.key, output.value, output.display);
        heard.set(output.key, output.display);
        renderList();
      }
    } else if (msg.name === "finish") {
      finishing = true;
      output = { ok: true };
    } else output = { ok: false, error: "Unknown tool" };
    return { call_id: msg.call_id, output };
  };

  // A response can call several tools (an answer and finish, say): return every result, then ask
  // for one reply. After finish, that reply is Sage's closing line, and the screen ends with it.
  const responseDone = async () => {
    responding = false;
    if (calls.length) {
      const results = await Promise.all(calls);
      calls = [];
      for (const { call_id, output } of results) send({ type: "conversation.item.create", item: { type: "function_call_output", call_id, output: JSON.stringify(output) } });
      send({ type: "response.create" });
    } else if (finishing) done();
    else listen();
  };

  const done = () => {
    // Let Sage finish her last sentence, then hand over to the review screen.
    const wait = Math.max(0, (playHead - ctx.currentTime) * 1000) + 600;
    setTimeout(() => setState("done"), Math.max(0, wait - 600));
    setTimeout(() => { cleanup(); onFinish(); }, wait + 400);
  };

  // Ask Sage to say the last question again (only between turns, so it never talks over itself).
  const repeat = () => {
    if (!started || responding || playing.size) return;
    send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Sorry, could you repeat the last question?" }] } });
    send({ type: "response.create" });
  };

  const start = async () => {
    if (started) { if (muted) setMuted(false); return; }
    started = true;
    orb.disabled = true;
    hintLine.remove();
    error.textContent = "";
    setState("connecting");
    try {
      ctx = new AudioContext({ sampleRate: RATE });
      await ctx.resume();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch {
      cleanup();
      return unavailable();
    }
    let session;
    try {
      session = await api("voice-session", {});
    } catch (e) {
      cleanup();
      closed = false;
      started = false;
      error.textContent = e.message;
      orb.disabled = false;
      setState("idle");
      return;
    }
    await ctx.audioWorklet.addModule("/assets/pcm-capture.js?v=9");
    node = new AudioWorkletNode(ctx, "pcm-capture");
    ctx.createMediaStreamSource(stream).connect(node);
    const ratio = ctx.sampleRate / RATE;
    let pending = [];
    node.port.onmessage = ({ data }) => {
      if (muted) { orb.style.setProperty("--level", "0"); pending = []; return; }
      // Level for the orb's halo.
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      orb.style.setProperty("--level", Math.min(1, Math.sqrt(sum / data.length) * 6).toFixed(3));
      // Resample to 24 kHz if the device ignored the requested rate, then send ~100 ms at a time.
      for (let i = 0; i < data.length / ratio; i++) pending.push(data[Math.floor(i * ratio)]);
      if (pending.length >= RATE / 10) {
        const pcm = new Int16Array(pending.length);
        for (let i = 0; i < pending.length; i++) pcm[i] = Math.max(-1, Math.min(1, pending[i])) * 0x7fff;
        pending = [];
        send({ type: "input_audio_buffer.append", audio: toBase64(new Uint8Array(pcm.buffer)) });
      }
    };

    ws = new WebSocket(session.url, [`xai-client-secret.${session.token}`]);
    ws.onopen = () => {
      send({ type: "session.update", session: session.session });
      send({ type: "response.create" });
      mic.disabled = false;
      orb.disabled = false;
    };
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case "response.created": responding = true; caption.textContent = ""; break;
        case "response.output_audio.delta": play(msg.delta); break;
        case "response.output_audio_transcript.delta": caption.textContent += msg.delta ?? ""; break;
        case "input_audio_buffer.speech_started":
          stopPlayback();
          you.textContent = "";
          setState("hearing");
          break;
        case "conversation.item.input_audio_transcription.updated":
        case "conversation.item.input_audio_transcription.completed":
          if (msg.transcript) you.textContent = `“${msg.transcript}”`;
          break;
        case "response.function_call_arguments.done": calls.push(handleTool(msg)); break;
        case "response.done": responseDone(); break;
        case "error": if (!closed) error.textContent = msg.error?.message ?? "Something went wrong with voice."; break;
      }
    };
    ws.onclose = () => {
      if (!closed && !finishing) {
        cleanup();
        error.textContent = "The voice connection closed. Your answers so far are kept.";
        mic.disabled = true;
        setState("idle");
      }
    };
  };

  // Shown when the microphone can't be used in this view.
  const unavailable = () => show(
    h("div", { class: "result" },
      h("div", { class: "badge big", html: icons.micOff }),
      h("span", { class: "eyebrow" }, eyebrow),
      h("h1", { class: "title" }, "Voice isn't available here."),
      h("p", { class: "lede" }, "This screen can't use your microphone. Send Sage a voice message in the chat, or answer with the buttons.")),
    actionbar(h("button", { type: "button", class: "btn grow", onclick: onExit }, "Use the buttons")));

  optionsMenu(more, () => [
    { icon: "repeat", label: "Repeat the question", onclick: repeat },
    { icon: muted ? "mic" : "micOff", label: muted ? "Unmute microphone" : "Mute microphone", onclick: () => setMuted(!muted) },
    { icon: "buttons", label: "Use buttons instead", onclick: () => { cleanup(); onExit(); } },
    "-",
    { icon: "close", label: "End voice", onclick: end },
  ], { label: "Voice options" });

  orb.addEventListener("click", start);
  setState("idle");
  show(
    h("div", { class: "header center" }, h("span", { class: "eyebrow" }, eyebrow), h("h1", { class: "title" }, title)),
    h("div", { class: "voice-stage" }, h("div", { class: "voice-ring" }, orb), state, hintLine),
    caption, you, heardBlock, error,
    actionbar(mic, primary, more));
  return { cleanup };
}
