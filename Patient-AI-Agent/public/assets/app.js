// Mini-app views. The URL token picks the form; the server says which kind it is. Layout follows the
// "Sage Mini-App Components" design canvas: a thin top bar, an eyebrow over a big short headline,
// white pages with gray cards or gray pages with white cards, and one glass action bar.
import { actionbar, api, button, h, icons, optionsMenu, roundButton } from "./ui.js?v=9";
import { voiceScreen } from "./voice.js?v=9";

const app = document.getElementById("app");
const dock = document.getElementById("dock");
let model;

/**
 * Shows a screen. An optional first argument { page: "gray" } picks the page tone. Nodes can be
 * lists or empty slots; action bars go to the dock outside <main>, so no animation moves them.
 */
const show = (...nodes) => {
  const opts = nodes[0] && !nodes[0].nodeType && !Array.isArray(nodes[0]) && typeof nodes[0] === "object" ? nodes.shift() : {};
  const flat = nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
  const bar = (n) => n.classList?.contains("actionbar");
  document.body.dataset.page = opts.page ?? "white";
  dock.replaceChildren(...flat.filter(bar));
  app.replaceChildren(...flat.filter((n) => !bar(n)));
  app.classList.remove("fade-in"); void app.offsetWidth; app.classList.add("fade-in");
  window.scrollTo(0, 0);
};
const header = (eyebrow, title, lede, opts = {}) => h("div", { class: `header${opts.center ? " center" : ""}` },
  eyebrow ? h("span", { class: "eyebrow" }, eyebrow) : null,
  title ? h("h1", { class: `title${opts.question || title.length > 34 ? " question" : ""}` }, title) : null,
  lede ? h("p", { class: "lede" }, lede) : null);
const result = (tone, eyebrow, title, lede) => h("div", { class: "result" },
  h("div", { class: `badge${tone === "good" ? "" : " neutral"}`, html: tone === "good" ? icons.check : tone === "warn" ? icons.info : icons.clock }),
  eyebrow ? h("span", { class: "eyebrow" }, eyebrow) : null,
  h("h1", { class: `title${title.length > 30 ? " question" : ""}` }, title),
  lede ? h("p", { class: "lede" }, lede) : null);
const backToChat = () => h("p", { class: "note" }, "You can close this and head back to the chat.");
const voicePill = (onclick) => h("button", { type: "button", class: "btn plain", onclick }, h("span", { html: icons.mic, style: "display:contents" }), "Voice");
const sectionTitle = (text) => h("h2", { class: "section-title" }, text);
const fmt = (iso, opts) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", ...opts }).format(new Date(iso));
const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const NS = "http://www.w3.org/2000/svg";
const svg = (attrs, inner) => {
  const el = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.innerHTML = inner;
  return el;
};

async function boot() {
  try {
    model = await api("");
  } catch (e) {
    show(result("warn", null, e.status === 410 ? "This link has expired." : "We couldn't open this.", e.message));
    return;
  }
  document.body.dataset.kind = model.kind;
  document.title = model.title;
  document.getElementById("brand").textContent = model.assistantName;
  document.getElementById("study").textContent = model.trial.shortTitle;
  ({ prescreen, info, consent, schedule, checkin, study, document: documents })[model.kind]();
}

// Prescreen ---------------------------------------------------------------------------------

function prescreen() {
  const { questions, answers: saved, result: done } = model.data;
  if (done) return prescreenResult(done);
  const answers = { ...saved };
  if (model.person.firstName && !answers.first_name) answers.first_name = model.person.firstName;
  const visible = () => questions.filter((q) => !q.showIf || (q.showIf.in ? q.showIf.in.includes(answers[q.showIf.key]) : answers[q.showIf.key] === q.showIf.equals));
  let index = -1;

  const intro = () => show(
    header(model.person.firstName ? `Hi, ${model.person.firstName}.` : "Pre-screening", "See if it's a fit.",
      "Your answers help the study team see whether this study might be right for you. Only the study team sees them."),
    h("div", { class: "bento space" },
      h("div", { class: "tile" }, h("div", { class: "stat" }, h("b", {}, String(visible().length)), h("span", {}, "Questions."))),
      h("div", { class: "tile" }, h("div", { class: "stat" }, h("b", {}, "2"), h("span", {}, "Minutes."))),
      h("div", { class: "tile wide" }, h("div", { class: "stat" }, h("b", { style: "font-size: 28px" }, "Say it or tap it."), h("span", {}, "Tap Voice to answer out loud with Sage.")))),
    h("p", { class: "note" }, "No wrong answers. Answering doesn't sign you up for anything."),
    actionbar(voicePill(talk), button("Start", () => { index = 0; step(); }, { class: "grow" })));

  // Voice: Grok asks every question out loud; answers land in the same review screen.
  const talk = () => voiceScreen({
    show,
    eyebrow: "Answer by voice",
    title: "Let's talk it through.",
    items: questions.map((q) => ({ key: q.key, label: q.prompt })),
    onAnswer: (key, value) => { if (value === null) delete answers[key]; else answers[key] = value; },
    onFinish: () => review("Answer by voice"),
    onExit: () => intro(),
  });

  // "Does this describe you? Diagnosed hypertension" under the headline "Diagnosed hypertension."
  // reads as "Does this describe you?".
  const promptFor = (q) => {
    const head = q.title.replace(/\.$/, "");
    return q.prompt.toLowerCase().endsWith(head.toLowerCase()) && q.prompt.length > head.length + 4 ? q.prompt.slice(0, -head.length).trim() : q.prompt;
  };

  const input = (q) => {
    const value = answers[q.key];
    if (q.type === "yes_no") { const el = h("pa-yes-no"); el.value = value ?? null; return el; }
    if (q.type === "choice" || q.type === "multi_choice") {
      const el = h("pa-options", { multiple: q.type === "multi_choice" });
      el.options = q.options;
      el.value = value ?? null;
      return el;
    }
    if (q.type === "number" || q.type === "scale") {
      const el = h("pa-number", { min: q.min, max: q.max, unit: q.unit, label: q.prompt, start: q.min != null && q.max != null ? Math.round((q.min + q.max) / 2) : q.min ?? 0 });
      el.value = value ?? "";
      return el;
    }
    return h("input", { class: "field pill", type: "text", value: value ?? "", autocomplete: q.key === "first_name" ? "given-name" : "off", "aria-label": q.prompt });
  };

  const step = () => {
    const list = visible();
    if (index >= list.length) return review();
    const q = list[index];
    const field = input(q);
    const error = h("div", { class: "error", role: "alert" });
    const read = () => (field.tagName === "INPUT" ? field.value.trim() || null : field.value);
    const valid = (v) => {
      if (v === null || v === "" || (Array.isArray(v) && !v.length)) return !q.required;
      if ((q.type === "number" || q.type === "scale") && (Number.isNaN(v) || (q.min != null && v < q.min) || (q.max != null && v > q.max))) return false;
      return true;
    };
    const next = button(index === list.length - 1 ? "Review" : "Next", () => {
      const v = read();
      if (!valid(v)) { error.textContent = q.type === "number" ? `Enter a number${q.max != null ? ` from ${q.min ?? 0} to ${q.max}` : ""}.` : "Please answer to continue."; return; }
      if (v === null) delete answers[q.key]; else answers[q.key] = v;
      index++;
      step();
    }, { class: "grow" });
    const sync = () => { next.disabled = !valid(read()); error.textContent = ""; };
    field.addEventListener("change", sync);
    field.addEventListener("input", sync);
    // Single choices advance on tap, like a native questionnaire.
    if (q.type === "yes_no" || q.type === "choice") field.addEventListener("change", () => setTimeout(() => next.click(), 220));
    show(
      h("pa-progress", { value: index, max: list.length }),
      h("div", { class: "header", style: "margin-top: 40px" },
        h("span", { class: "eyebrow" }, `Question ${index + 1} of ${list.length}`),
        // A short headline ("Pregnancy.") over the question, as in the design; long prompts stand alone.
        q.title ? [h("h1", { class: "title" }, q.title), h("p", { class: "prompt" }, promptFor(q))] : h("h1", { class: "title question" }, q.prompt),
        q.help ? h("p", { class: "lede", style: "font-size: 15px; margin-top: 10px" }, q.help) : !q.required ? h("p", { class: "lede", style: "font-size: 15px; margin-top: 10px" }, "Optional.") : null),
      h("div", { style: "margin-top: 40px" }, field), error,
      actionbar(button("Back", () => { index--; index < 0 ? intro() : step(); }, { class: "plain" }), next));
    sync();
    if (field.tagName === "INPUT") setTimeout(() => field.focus(), 250);
  };

  const label = (q) => {
    const v = answers[q.key];
    if (v === undefined || v === null) return "Skipped";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (Array.isArray(v)) return v.map((x) => q.options?.find((o) => o.value === x)?.label ?? x).join(", ");
    return q.options?.find((o) => o.value === v)?.label ?? `${v}${q.unit ? ` ${q.unit}` : ""}`;
  };

  const review = (eyebrow = "Pre-screening") => {
    const list = visible();
    const error = h("div", { class: "error", role: "alert" });
    const submit = button("Send my answers", async () => {
      submit.disabled = true;
      error.textContent = "";
      try {
        prescreenResult(await api("prescreen", { answers: Object.fromEntries(list.filter((q) => q.key in answers).map((q) => [q.key, answers[q.key]])) }));
      } catch (e) {
        error.textContent = e.errors ? Object.values(e.errors)[0] : e.message;
        submit.disabled = false;
      }
    }, { class: "grow" });
    show(
      header(eyebrow, "Check your answers.", "Tap any answer to change it."),
      h("div", { class: "card list space" }, list.map((q, i) => h("button", { type: "button", class: "row tall", onclick: () => { index = i; step(); } },
        h("span", { class: "text" }, h("small", {}, q.prompt), h("b", {}, label(q))),
        h("span", { class: "chevron", html: icons.chevron })))),
      h("p", { class: "note" }, "Nothing is sent until you tap Send."),
      error,
      actionbar(button("Back", () => { index = list.length - 1; step(); }, { class: "plain" }), submit));
  };

  intro();
}

function prescreenResult(res) {
  const tone = res.status === "likely_eligible" ? "good" : res.status === "needs_review" ? "neutral" : "warn";
  show(result(tone, "Pre-screening", res.title, res.message), backToChat());
}

// Study info -------------------------------------------------------------------------------

function info() {
  const d = model.data;
  show({ page: "gray" },
    header("Study overview", "The study, in brief.", d.summary || model.trial.title),
    d.facts.length ? h("div", { class: "bento space" }, d.facts.map((f) => h("div", { class: "tile" }, h("span", {}, f.label), h("b", {}, f.value)))) : null,
    d.steps.length ? [sectionTitle("What happens"), h("div", { class: "card list" }, h("ul", { class: "timeline", style: "margin: 0" }, d.steps.map((v, i) => h("li", {},
      h("span", { class: `mark${i === 0 ? " next" : ""}`, "aria-hidden": "true" }),
      h("div", { class: "text" }, h("b", {}, v.name), h("div", { class: "small muted" }, v.detail))))))] : null,
    d.sites.length ? [sectionTitle("Where"), h("div", { class: "card" }, d.sites.map((s, i) => h("div", { style: i ? "margin-top: 12px" : "" }, h("b", {}, s.name), h("div", { class: "small muted" }, s.city))))] : null,
    d.sections.length ? [sectionTitle("Common questions"), h("div", { class: "card list" }, d.sections.map((s) => h("details", {}, h("summary", {}, s.heading), h("p", {}, s.body))))] : null,
    h("p", { class: "note" }, `Questions? Just text ${model.assistantName} back.`));
}

// Consent ------------------------------------------------------------------------------------

function consent() {
  const { document: doc, signature, personName } = model.data;
  if (signature) return consentSigned(signature, doc);
  const acknowledged = new Set();
  const keyPoints = doc.sections.filter((s) => s.key_point);
  const others = doc.sections.filter((s) => !s.key_point);
  const answers = {};

  const read = () => {
    const progress = h("pa-progress", { value: acknowledged.size, max: keyPoints.length });
    const counter = h("span", {}, `${acknowledged.size} of ${keyPoints.length}`);
    const next = button("Continue", check, { class: "grow", disabled: acknowledged.size < keyPoints.length });
    const update = () => {
      progress.setAttribute("value", acknowledged.size);
      counter.textContent = `${acknowledged.size} of ${keyPoints.length}`;
      next.disabled = acknowledged.size < keyPoints.length;
    };
    const count = keyPoints.length;
    show({ page: "gray" },
      header("Informed consent", count ? `${WORDS[count] ?? count} thing${count === 1 ? "" : "s"} to know.` : doc.title,
        `${doc.title}. Version ${doc.version}. Take your time, and ask ${model.assistantName} anything along the way.`),
      count ? h("div", { class: "progress-row" }, progress, counter) : null,
      doc.summary ? h("div", { class: "card gap", style: "margin-top: 20px" }, h("p", {}, doc.summary),
        doc.generated ? h("p", { class: "small muted", style: "margin-top: 8px" }, "A plain-language walkthrough of the approved consent form. Ask any time for a copy of the full form.") : null) : null,
      keyPoints.map((s) => h("div", { class: "card section" },
        h("h2", {}, s.heading), h("p", {}, s.body),
        h("label", { class: "ack" }, h("input", { type: "checkbox", checked: acknowledged.has(s.id),
          onchange: (ev) => { ev.target.checked ? acknowledged.add(s.id) : acknowledged.delete(s.id); update(); } }), "I understand"))),
      others.length ? [sectionTitle("The full form"), h("div", { class: "card list" }, others.map((s) => h("details", {}, h("summary", {}, s.heading), h("p", {}, s.body))))] : null,
      doc.signable ? actionbar(next) : h("p", { class: "note" }, "This form isn't ready to sign yet. The study team will text you when it is."));
  };

  // Teach-back: once every question has an answer, the server checks them (the answer key never
  // reaches the page) and says which need another look. Signing re-checks them.
  const check = () => {
    const feedback = {};
    const next = button("Continue", agree, { class: "grow", disabled: true });
    const evaluate = async () => {
      if (Object.keys(answers).length < doc.comprehension.length) return;
      let wrong = [];
      try { await api("consent", { answers, dryRun: true }); } catch (e) { wrong = e.wrong ?? doc.comprehension.map((c) => c.id); }
      for (const c of doc.comprehension) {
        const ok = !wrong.includes(c.id);
        feedback[c.id].className = `feedback ${ok ? "good" : "bad"}`;
        feedback[c.id].textContent = ok ? "That's right." : "Not quite. Take another look at the form, or ask us.";
      }
      next.disabled = wrong.length > 0;
    };
    show({ page: "gray" },
      header("Quick check", `${WORDS[doc.comprehension.length] ?? doc.comprehension.length} questions.`, "To make sure the key points are clear."),
      h("div", { class: "space" }, doc.comprehension.map((c) => {
        feedback[c.id] = h("div", { class: "feedback" });
        const options = h("pa-options");
        options.options = c.options.map((label, i) => ({ value: String(i), label }));
        if (c.id in answers) options.value = String(answers[c.id]);
        options.addEventListener("change", () => { answers[c.id] = Number(options.value); evaluate(); });
        return h("div", { class: "card stack" }, h("h2", {}, c.question), options, feedback[c.id]);
      })),
      actionbar(button("Back", read, { class: "plain" }), next));
    evaluate();
  };

  const agree = () => {
    const statements = [
      "I have read this consent form and had the chance to ask questions.",
      "I understand that taking part is voluntary and I can stop at any time.",
      "I agree to take part in this study.",
    ];
    const checked = new Set();
    const name = h("input", { id: "signed-name", class: "field pill", type: "text", autocomplete: "name", placeholder: "First and last name", value: personName || "" });
    const next = button("Continue to sign", () => sign(name.value.trim().replace(/\s+/g, " "), [...checked]), { class: "grow", disabled: true });
    const update = () => { next.disabled = checked.size < statements.length || name.value.trim().split(/\s+/).length < 2; };
    name.addEventListener("input", update);
    show({ page: "gray" },
      header("Your agreement", "In your words.", "Check each statement, then type your full name as your signature."),
      h("div", { class: "card list space" }, statements.map((s) => h("label", { class: "agree" },
        h("input", { type: "checkbox", onchange: (ev) => { ev.target.checked ? checked.add(s) : checked.delete(s); update(); } }), h("span", {}, s)))),
      h("label", { class: "field-label", for: "signed-name" }, h("b", {}, "Full name"), h("small", {}, "This is your signature. Check the spelling.")),
      name,
      actionbar(button("Back", check, { class: "plain" }), next));
    update();
  };

  const sign = (signedName, agreements) => {
    const error = h("div", { class: "error", role: "alert" });
    const verify = h("pa-verify", { action: "sign_consent", label: "Sign with Face ID", name: signedName, eyebrow: `Signing as ${signedName}`, heading: "Sign the form." });
    // Where Face ID can't run in this view, Safari signs with these exact answers after Face ID.
    verify.handoff = () => api("handoff", { action: "sign_consent", signedName, agreements, answers });
    verify.poll = () => api("handoff-status?action=sign_consent");
    verify.addEventListener("verified", async (ev) => {
      try {
        const res = await api("consent", { verificationId: ev.detail.verificationId, signedName, agreements, answers });
        consentSigned({ name: res.name, signedAt: res.signedAt, method: ev.detail.method, version: doc.version, hash: res.hash }, doc, true);
      } catch (e) { error.textContent = e.message; }
    });
    verify.addEventListener("completed", (ev) => {
      consentSigned({ name: ev.detail.name, signedAt: ev.detail.signedAt, method: "passkey", version: doc.version, hash: ev.detail.hash }, doc, true);
    });
    show(verify, error, actionbar(button("Back", agree, { class: "plain" }), verify.button));
  };

  read();
}

function consentSigned(sig, doc, justNow = false) {
  show(
    result("good", "Informed consent", justNow ? "Signed." : "You've signed.", justNow ? "Thank you. We'll text you next about booking your screening visit." : null),
    h("div", { class: "card space" }, h("dl", { class: "kv" },
      h("dt", {}, "Form"), h("dd", {}, `v${sig.version}`),
      h("dt", {}, "Signed by"), h("dd", {}, sig.name),
      h("dt", {}, "When"), h("dd", {}, fmt(sig.signedAt, { dateStyle: "medium", timeStyle: undefined })),
      h("dt", {}, "Verified"), h("dd", {}, sig.method === "passkey" ? "Face ID" : "Typed name"),
      sig.hash ? h("dt", {}, "Fingerprint") : null, sig.hash ? h("dd", { class: "mono" }, `${sig.hash.slice(0, 12)}…`) : null)),
    h("p", { class: "note" }, `You can stop at any time. Just text ${model.assistantName}.`), backToChat());
}

// Scheduling -----------------------------------------------------------------------------------

function schedule() {
  const d = model.data;
  const calendar = `${location.pathname.replace(/\/$/, "")}/visit.ics`;
  const booked = (b, justNow) => show(
    result("good", "Screening visit", justNow ? "You're booked." : "Your visit.", `${b.label}. ${b.site}.`),
    h("div", { class: "card space" }, h("h2", {}, "What to bring"),
      h("ul", { style: "margin: 10px 0 0; padding-left: 20px" }, d.bring.map((item) => h("li", {}, item)))),
    backToChat(),
    actionbar({ column: true }, h("a", { class: "btn", href: calendar }, h("span", { html: icons.calendar, style: "display:contents" }), "Add to calendar"),
      button("Pick a different time", picker, { class: "plain" })));

  const picker = () => {
    const slots = h("pa-slots");
    const error = h("div", { class: "error", role: "alert" });
    const when = h("b", {}, "Choose a time");
    const where = h("span", {}, "About an hour");
    const confirm = button("Book", null, { disabled: true });
    confirm.style.padding = "0 32px";
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      error.textContent = "";
      try { booked(await api("schedule", slots.value), true); }
      catch (e) { error.textContent = e.message; confirm.disabled = false; if (e.status === 409) { model = await api(""); slots.data = model.data; } }
    });
    slots.addEventListener("change", () => {
      confirm.disabled = !slots.value;
      when.textContent = slots.value ? slots.value.when : "Choose a time";
      where.textContent = slots.value ? `${slots.value.where} · About an hour` : "About an hour";
    });
    show(
      header("Screening visit", "Book your visit.", "About an hour. Pick whichever works best for you."),
      h("div", { class: "space" }, slots), error,
      actionbar(h("div", { class: "summary" }, when, where), confirm));
    slots.data = d;
  };

  d.booked ? booked(d.booked) : picker();
}

// Check-in -----------------------------------------------------------------------------------------

/**
 * The check-in questions; `onSaved(progress)` runs after the server stores them. After a voice
 * check-in, `prefill` holds what Sage heard and the form is a review: nothing is saved until Done.
 */
function checkinForm({ measures, onSaved, back, latest = {}, prefill = null }) {
  const name = model.person.firstName;
  const numeric = (m) => ["number", "integer"].includes(m.valueType);
  const fields = measures.map((m) => {
    let el;
    if (m.valueType === "boolean") el = h("pa-yes-no", { compact: true });
    else if (m.valueType === "scale") el = h("pa-scale", { min: m.min ?? 0, max: m.max ?? 10, label: m.label });
    else if (m.valueType === "choice") {
      el = h("pa-options");
      el.options = m.choices.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, " ") }));
    } else if (m.valueType === "text") el = h("input", { id: `m-${m.code}`, class: "field", type: "text", maxlength: 500, placeholder: "Optional" });
    else {
      const start = latest[m.code] ?? (m.min != null && m.max != null ? Math.round((m.min + m.max) / 2) : m.min ?? 0);
      el = h("pa-number", { min: m.min, max: m.max, unit: m.unit, step: m.valueType === "integer" ? 1 : 0.5, label: m.label, start, bare: true, placeholder: latest[m.code] ?? "–" });
    }
    if (prefill && m.code in prefill) {
      if (el.tagName === "INPUT") el.value = String(prefill[m.code]);
      else el.value = prefill[m.code];
    }
    return { m, el };
  });
  const error = h("div", { class: "error", role: "alert" });
  const submit = button("Done", async () => {
    submit.disabled = true;
    error.textContent = "";
    try {
      const res = await api("checkin", { values: Object.fromEntries(fields.map(({ m, el }) => [m.code, el.tagName === "INPUT" ? el.value.trim() || null : el.value])) });
      onSaved(res.progress);
    } catch (e) { error.textContent = e.message; submit.disabled = false; }
  }, { class: "grow" });
  // Voice: Grok asks the check-in out loud, then the answers are sent in one go.
  const again = () => checkinForm({ measures, onSaved, back, latest });
  const talk = () => {
    const values = {};
    voiceScreen({
      show,
      eyebrow: "Daily check-in",
      title: "Let's talk it through.",
      hint: "About a minute. Read your numbers off the cuff. Nothing is sent until you check it.",
      items: measures.map((m) => ({ key: m.code, label: m.label })),
      onAnswer: (key, value) => { if (value === null) delete values[key]; else values[key] = value; },
      // What Sage heard opens as the form, to check and fix before it's saved.
      onFinish: () => (Object.keys(values).length ? checkinForm({ measures, onSaved, back, latest, prefill: values }) : again()),
      onExit: again,
    });
  };
  // Blood pressure reads like the cuff: "Systolic", "mmHg, the top number".
  const short = (m) => m.label.replace(/ blood pressure$/i, "").replace(/^\w/, (c) => c.toUpperCase());
  const hint = (m) => /systolic/i.test(m.label) ? `${m.unit}, the top number` : /diastolic/i.test(m.label) ? `${m.unit}, the bottom number` : m.unit;
  const readings = fields.filter(({ m }) => numeric(m));
  const rest = fields.filter(({ m }) => !numeric(m));
  show({ page: "gray" },
    prefill
      ? header("Answer by voice", "Check what Sage heard.", "Fix anything that's off, then tap Done. Nothing is saved until you do.")
      : header(name ? `Hi, ${name}.` : "Daily check-in", "How was today?", "Under a minute. Skip anything that doesn't apply."),
    readings.length ? h("div", { class: "card list space" }, readings.map(({ m, el }) => h("div", { class: "reading" },
      h("div", { class: "text" }, h("b", {}, short(m)), m.unit ? h("small", {}, hint(m)) : null), el))) : null,
    rest.map(({ m, el }) => h("div", { class: "card stack", style: "margin-top: 12px" },
      m.valueType === "text" ? h("label", { for: `m-${m.code}` }, h("h2", {}, m.prompt || m.label)) : h("h2", {}, m.prompt || m.label), el)),
    error,
    actionbar(back ? button("Back", back, { class: "plain" }) : null, voicePill(talk), submit));
}

/** A line chart of one or two series on a shared scale (ink first, then the accent). */
function chart(series, labels, aria) {
  const all = series.flatMap((s) => s.points.filter((p) => p !== null));
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 6) { lo -= 3; hi += 3; }
  const x = (i) => 20 + i * 46, y = (v) => 100 - ((v - lo) / (hi - lo)) * 82;
  const tones = ["ink", "accent"];
  const lines = series.map((s, n) => {
    const pts = s.points.map((v, i) => (v === null ? null : [x(i), y(v)])).filter(Boolean);
    const last = pts.at(-1);
    return `<polyline class="${tones[n]}" points="${pts.map((p) => p.join(",")).join(" ")}"></polyline>${last ? `<circle class="${tones[n]}" cx="${last[0]}" cy="${last[1]}" r="4.5"></circle>` : ""}`;
  }).join("");
  return svg({ class: "chart", viewBox: "0 0 320 128", role: "img", "aria-label": aria },
    `<line x1="10" y1="18" x2="310" y2="18"></line><line x1="10" y1="100" x2="310" y2="100"></line>${lines}
     <text x="20" y="122">${labels[0]}</text><text x="296" y="122" text-anchor="end">Today</text>`);
}

/** This week's check-ins and reading trends: a record, never an interpretation. */
function progressView(progress) {
  if (!progress) return null;
  const weekday = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const labels = progress.streak.map((d) => weekday(d.day));
  const trends = [...progress.trends];
  const take = (re) => { const i = trends.findIndex((t) => re.test(`${t.code} ${t.label}`)); return i < 0 ? null : trends.splice(i, 1)[0]; };
  const sys = take(/systolic/i), dia = take(/diastolic/i);
  const cards = [];
  if (sys && dia) {
    cards.push(h("div", { class: "card" },
      h("div", { class: "chart-head" }, h("h2", {}, "Your blood pressure"), h("span", {}, `${sys.unit ?? "mmHg"} · 7 days`)),
      h("div", { class: "chart-values" },
        h("div", {}, h("b", {}, sys.latest ?? "–"), h("span", {}, h("i", { "aria-hidden": "true" }), "Top (systolic)")),
        h("div", {}, h("b", {}, dia.latest ?? "–"), h("span", {}, h("i", { class: "accent", "aria-hidden": "true" }), "Bottom (diastolic)"))),
      chart([sys, dia], labels, `Blood pressure over the last 7 days. Latest ${sys.latest ?? "none"} over ${dia.latest ?? "none"}.`)));
  } else trends.unshift(...[sys, dia].filter(Boolean));
  for (const t of trends) {
    cards.push(h("div", { class: "card" },
      h("div", { class: "chart-head" }, h("h2", {}, t.label), h("span", {}, `${t.unit ? `${t.unit} · ` : ""}7 days`)),
      h("div", { class: "chart-values" }, h("div", {}, h("b", {}, t.latest ?? "–"), h("span", {}, h("i", { "aria-hidden": "true" }), "Latest"))),
      chart([t], labels, `${t.label} over the last 7 days. Latest ${t.latest ?? "none"}.`)));
  }
  if (cards.length) cards.at(-1).append(h("p", { class: "chart-note" }, "A record of what you reported. Your study doctor reviews it. Ask them what it means for you."));
  return [
    h("div", { class: "card space" }, h("h2", {}, "This week"),
      h("div", { class: "streak" }, progress.streak.map((d) => h("div", {},
        h("span", {}, d.label),
        h("i", { class: d.status, role: "img", "aria-label": `${weekday(d.day)}: ${d.status === "done" ? "checked in" : d.status === "today" ? "today" : "missed"}` }))))),
    cards.map((c) => { c.style.marginTop = "12px"; return c; }),
  ];
}

function checkedIn(progress, back) {
  const name = model.person.firstName;
  show({ page: "gray" },
    result("good", "Daily check-in", "Checked in.", `Thanks${name ? `, ${name}` : ""}.${progress ? ` ${progress.daysReported} of 7 days this week.` : ""}`),
    progressView(progress),
    back ? actionbar(button("Back to your study", back, { class: "grow" })) : backToChat());
}

function checkin() {
  const { measures, submitted, progress } = model.data;
  if (submitted) return checkedIn(progress);
  checkinForm({ measures, onSaved: (p) => checkedIn(p) });
}

// Your study -------------------------------------------------------------------------------------

function study() {
  const d = model.data;
  const latest = Object.fromEntries((d.trends ?? []).filter((t) => t.latest !== null).map((t) => [t.code, t.latest]));
  const checkIn = () => checkinForm({ measures: d.measures, back: home, latest, onSaved: (p) => { Object.assign(d, p); checkedIn(p, home); } });
  const upcoming = () => d.visits.filter((v) => v.status === "upcoming");
  // "Systolic blood pressure, Diastolic blood pressure, Pulse" reads as "Blood pressure and pulse".
  const taskName = (title) => title.replace(/systolic blood pressure, diastolic blood pressure/i, "Blood pressure")
    .replace(/, ([^,]+)$/, (_, last) => ` and ${last.toLowerCase()}`);

  const home = () => {
    const percent = d.day && d.totalDays ? Math.min(1, d.day / d.totalDays) : 0;
    const circumference = 2 * Math.PI * 40;
    const ring = svg({ class: "ring", viewBox: "0 0 96 96", role: "img", "aria-label": d.week ? `Week ${d.week} of ${d.weeks}` : "Study progress" },
      `<circle class="track" cx="48" cy="48" r="40" fill="none" stroke-width="10"></circle>
       <circle class="fill" cx="48" cy="48" r="40" fill="none" stroke-width="10" stroke-linecap="round"
         stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - percent)}" transform="rotate(-90 48 48)"></circle>
       ${d.week ? `<text x="48" y="53" text-anchor="middle" class="big">${d.week}</text><text x="48" y="68" text-anchor="middle" class="small">of ${d.weeks} weeks</text>` : ""}`);
    const next = upcoming()[0];
    const statusLabel = { done: "Done", due: "Due now", missed: "Missed", later: "Later" };
    const stat = d.assessments.due
      ? [`${d.assessments.done} of ${d.assessments.due}`, "Check-ins done, last 2 weeks"]
      : [`${d.daysReported} of 7`, "Days checked in this week"];
    const more = roundButton("more", "More options");
    const bar = actionbar(button("Report a symptom", symptom, { class: "grow" }), more);
    optionsMenu(more, [
      { icon: "calendar", label: "All visits", onclick: visits },
      { icon: "pulse", label: "Daily check-in", onclick: checkIn },
      d.contactPhone ? { icon: "phone", label: "Talk to the study team", href: `tel:${d.contactPhone}` } : { icon: "phone", label: "Talk to the study team", onclick: () => leave("talk") },
      "-",
      { icon: "pause", label: "Pause or stop", onclick: () => leave() },
    ]);
    show({ page: "gray" },
      header(d.week && d.day ? `Week ${d.week} · Day ${d.day}` : d.participantCode ?? model.trial.shortTitle, "Your study.", `${model.trial.title}.`),
      h("div", { class: "card overview", style: "margin-top: 28px" }, ring, h("div", { class: "stat" }, h("b", {}, stat[0]), h("span", {}, stat[1]))),
      d.tasks.length ? [sectionTitle("Today"), h("div", { class: "card list" }, d.tasks.map((t) => {
        const done = t.status === "done";
        const body = [
          h("span", { class: `mark${done ? " done" : ""}`, "aria-hidden": "true" }),
          h("span", { class: "text" }, h("span", { class: "label" }, taskName(t.title)), h("small", {}, `${t.time} · ${statusLabel[t.status]}`)),
        ];
        return done ? h("div", { class: "row done" }, ...body) : h("button", { type: "button", class: "row", onclick: checkIn, "aria-label": `${t.title}, ${statusLabel[t.status]}. Check in.` }, ...body);
      }))] : null,
      sectionTitle("Next visit"),
      next
        ? h("button", { type: "button", class: "card next-visit", style: "width: 100%; border: 0; text-align: left; cursor: pointer", onclick: visits },
          h("b", {}, next.when.split(",").slice(0, 2).join(",")), h("span", {}, next.label), h("small", {}, next.where))
        : h("div", { class: "card" }, h("p", { class: "muted" }, "Your study team schedules visits with you. They'll show up here.")),
      bar);
  };

  const symptom = () => {
    const picked = new Set();
    let severity = null;
    const urgentBox = h("div");
    const error = h("div", { class: "error", role: "alert" });
    const note = h("input", { id: "symptom-note", class: "field pill", type: "text", placeholder: "For example, dizzy when standing", maxlength: 300 });
    const urgent = () => severity === "severe" || [...picked].some((s) => d.symptoms.find((x) => x.value === s)?.urgent);
    const urgentBlock = (title, body) => h("div", { class: "urgent", role: "alert" },
      h("div", { class: "text" }, h("b", {}, title), h("span", {}, body)),
      h("a", { class: "call", href: "tel:911" }, h("span", { html: icons.phone, style: "display:contents" }), "Call 911"));
    const refresh = () => urgentBox.replaceChildren(urgent() ? urgentBlock("This could be urgent.", "Call 911 or go to the nearest emergency room now. You can tell the study team afterwards.") : "");
    const chips = d.symptoms.map((s) => {
      const chip = h("button", { type: "button", class: "chip-toggle", "aria-pressed": "false" }, s.label);
      chip.addEventListener("click", () => {
        picked.has(s.value) ? picked.delete(s.value) : picked.add(s.value);
        chip.setAttribute("aria-pressed", String(picked.has(s.value)));
        refresh();
      });
      return chip;
    });
    const levels = [["mild", "Mild", "Noticeable"], ["moderate", "Moderate", "Gets in the way"], ["severe", "Severe", "Can't do much"]].map(([value, label, hint]) => {
      const b = h("button", { type: "button", "aria-pressed": "false" }, h("b", {}, label), h("small", {}, hint));
      b.addEventListener("click", () => {
        severity = value;
        for (const other of levels) other.setAttribute("aria-pressed", String(other === b));
        refresh();
      });
      return b;
    });
    const send = button("Send to the study team", async () => {
      error.textContent = "";
      send.disabled = true;
      try {
        const res = await api("symptom", { symptoms: [...picked], severity, note: note.value });
        show(
          result("good", "Report a symptom", "Sent.", `The study team has your report about ${res.labels.toLowerCase()} and will follow up.`),
          res.urgent ? urgentBlock("If it's an emergency, call 911 first.", "Then let the study team know.") : null,
          res.contactPhone ? h("div", { class: "notice", style: "margin-top: 12px" }, h("span", { html: icons.phone, style: "display:contents" }),
            h("div", { class: "text" }, h("b", {}, "Study team"), h("a", { href: `tel:${res.contactPhone}` }, res.contactPhone))) : null,
          actionbar(button("Back to your study", home, { class: "grow" })));
      } catch (e) { error.textContent = e.message; send.disabled = false; }
    }, { class: "grow" });
    show(
      header("Report a symptom", "How are you feeling?", "Pick anything that's new or worse. The study team sees this right away."),
      h("div", { class: "chips space", role: "group", "aria-label": "Symptoms" }, chips),
      h("h2", { class: "section-title", style: "margin-left: 0" }, "How bad is it?"),
      h("div", { class: "levels", role: "group", "aria-label": "Severity" }, levels),
      urgentBox,
      h("label", { class: "field-label", for: "symptom-note", style: "margin-left: 0" }, h("b", {}, "Anything else?"), h("small", {}, "Optional")),
      note, error,
      actionbar(button("Back", home, { class: "plain" }), send));
  };

  const visits = () => {
    const error = h("div", { class: "error", role: "alert" });
    let open = upcoming()[0]?.id ?? null;
    const list = h("div", { class: "card list space" });
    const render = () => {
      const nextId = upcoming()[0]?.id;
      list.replaceChildren(...d.visits.map((v) => {
        const done = v.status === "done", next = v.id === nextId, expanded = open === v.id;
        return h("button", { type: "button", class: "visit", "aria-expanded": String(expanded), onclick: () => { open = expanded ? null : v.id; render(); } },
          h("span", { class: `mark${done ? " ink" : next ? " next" : ""}`, "aria-hidden": "true" }),
          h("span", { class: "text" },
            h("span", { class: "top" }, h("b", {}, v.label), h("span", { class: `tag${done ? " muted" : next ? " accent" : ""}` }, done ? "Done" : next ? "Next" : "Upcoming")),
            h("span", { class: "when" }, v.when),
            expanded ? h("span", { class: "details" }, v.where) : null));
      }));
    };
    render();
    const change = h("button", { type: "button", class: "btn link", onclick: async () => {
      change.disabled = true;
      try {
        await api("visit-change", {});
        change.replaceWith(h("div", { class: "notice", style: "margin-top: 12px" }, h("span", { html: icons.info, style: "display:contents" }),
          h("div", { class: "text" }, h("b", {}, "Got it."), h("span", {}, "The study team will reach out to find a new time."))));
      } catch (e) { error.textContent = e.message; change.disabled = false; }
    } }, "Need a different time?");
    const hasNext = upcoming().length > 0;
    show({ page: "gray" },
      header(d.weeks ? `${d.weeks} weeks${d.site ? ` · ${d.site}` : ""}` : "Study visits", "Your visits.", d.visits.length ? "Tap a visit for details." : null),
      d.visits.length ? list : h("div", { class: "card space" }, h("p", {}, `Your study team schedules visits with you. ${model.assistantName} will send them here.`)),
      hasNext ? h("div", { class: "center", style: "margin-top: 12px" }, change) : null, error,
      actionbar(button("Back", home, { class: "plain" }),
        hasNext ? h("a", { class: "btn grow", href: `${location.pathname.replace(/\/$/, "")}/visit.ics` }, "Add next visit to calendar") : null));
  };

  const leave = (preset = "pause") => {
    let choice = preset;
    const options = h("pa-options");
    options.options = [
      { value: "pause", label: "Pause reminders for 3 days", hint: `You stay in the study. ${model.assistantName} goes quiet for a few days.` },
      { value: "talk", label: "Talk to the study team first", hint: "A coordinator calls you, usually the same day." },
      { value: "stop", label: "Stop taking part", hint: "You can leave at any time, for any reason." },
    ];
    options.value = choice;
    const error = h("div", { class: "error", role: "alert" });
    const note = h("input", { id: "leave-note", class: "field pill", type: "text", placeholder: "For example, too many readings", maxlength: 300 });
    const go = async (btn) => {
      btn.disabled = true;
      error.textContent = "";
      try {
        const res = await api("leave", { choice, note: note.value });
        show(result(res.choice === "stop" ? "neutral" : "good", null, res.title, res.message), backToChat());
      } catch (e) { error.textContent = e.message; btn.disabled = false; }
    };
    const confirmStop = () => show(
      header("Before you go", "Stop taking part?"),
      h("div", { class: "card stack space" }, [
        "There's no penalty, and your usual care doesn't change.",
        "Check-ins and reminders stop today.",
        "The study team may call once to check on your health and arrange returning any study equipment.",
        "What you've already shared stays in the study, as the consent form explained.",
      ].map((line) => h("p", {}, line))),
      h("label", { class: "field-label", for: "leave-note" }, h("b", {}, "Anything you'd like the team to know?"), h("small", {}, "Optional")),
      note, error,
      actionbar(button("Back", () => leave(choice), { class: "plain" }), button("Stop taking part", (ev) => go(ev.currentTarget), { class: "grow" })));
    const labels = { pause: "Pause reminders", talk: "Ask for a call", stop: "Continue" };
    const next = button(labels[choice], (ev) => (choice === "stop" ? confirmStop() : go(ev.currentTarget)), { class: "grow" });
    options.addEventListener("change", () => {
      choice = options.value;
      next.textContent = labels[choice];
    });
    show(
      header("Your choice", "Need a break?", "Taking part is always your choice. Pick what would help most."),
      h("div", { class: "space" }, options), error,
      actionbar(button("Back", home, { class: "plain" }), next));
  };

  /** The week so far: check-in streak and reading trends, from the weekly summary card. */
  const week = () => show({ page: "gray" },
    header(d.week ? `Week ${d.week} of ${d.weeks}` : "This week", "Your week.", `${d.daysReported} of 7 days checked in.${model.person.firstName ? ` Nice work, ${model.person.firstName}.` : ""}`),
    progressView(d),
    actionbar(button("Back", home, { class: "plain" }), button("Check in now", checkIn, { class: "grow" })));

  const open = { symptom, visit: visits, week }[d.view];
  open ? open() : home();
}

// Documents ---------------------------------------------------------------------------------------

function documents() {
  const verify = h("pa-verify", { action: "view_document", label: "Open with Face ID", eyebrow: "Your documents", heading: "Open your documents.",
    lede: "Your signed consent form and visit details are private. Face ID confirms it's you." });
  const error = h("div", { class: "error", role: "alert" });
  verify.handoff = () => api("handoff", { action: "view_document" });
  verify.poll = () => api("handoff-status?action=view_document");
  verify.addEventListener("completed", (ev) => render(ev.detail));
  verify.addEventListener("verified", async (ev) => {
    try { render(await api("document", { verificationId: ev.detail.verificationId })); }
    catch (e) { error.textContent = e.message; }
  });
  const render = (d) => show({ page: "gray" },
    header(d.participantCode ? `Participant ${d.participantCode}` : "Your documents", "Your documents.", null),
    d.visit ? [sectionTitle("Next visit"), h("div", { class: "card next-visit" }, h("b", {}, d.visit.label), h("small", {}, d.visit.location ?? d.visit.site))] : null,
    d.signature ? [sectionTitle(d.signature.title), h("div", { class: "card" }, h("dl", { class: "kv" },
      h("dt", {}, "Signed by"), h("dd", {}, d.signature.name), h("dt", {}, "When"), h("dd", {}, fmt(d.signature.signedAt)),
      h("dt", {}, "Verified"), h("dd", {}, d.signature.method === "passkey" ? "Face ID" : "Typed name"),
      h("dt", {}, "Fingerprint"), h("dd", { class: "mono" }, `${d.signature.hash.slice(0, 12)}…`)))] : null,
    d.document ? [sectionTitle("The form you signed"), h("div", { class: "card list" }, d.document.sections.map((s) => h("details", {}, h("summary", {}, s.heading), h("p", {}, s.body))))] : null,
    backToChat());
  show(verify, error, actionbar(verify.button));
}

boot();
