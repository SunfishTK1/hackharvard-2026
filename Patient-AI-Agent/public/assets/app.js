// Mini-app views. The URL token picks the form; the server says which kind it is.
import { api, h, icons } from "./ui.js";

const app = document.getElementById("app");
let model;

const show = (...nodes) => { app.replaceChildren(...nodes); app.classList.remove("fade-in"); void app.offsetWidth; app.classList.add("fade-in"); window.scrollTo(0, 0); };
const header = (title, subtitle) => h("div", { class: "header" },
  h("span", { class: "chip" }, `${model.trial.shortTitle}${model.trial.synthetic ? " · demo study" : ""} · ${model.assistantName}`), h("h1", {}, title), subtitle ? h("p", { class: "muted" }, subtitle) : null);
const actionbar = (...buttons) => h("div", { class: "actionbar" }, h("div", { class: "inner" }, ...buttons));
const button = (label, onclick, extra = {}) => h("button", { type: "button", class: `btn ${extra.class ?? ""}`, onclick, disabled: extra.disabled }, label);
const result = (tone, title, message, ...rest) => h("div", { class: "result" },
  h("div", { class: `badge ${tone}`, html: tone === "good" ? icons.check : tone === "warn" ? icons.info : icons.clock }), h("h2", {}, title), message ? h("p", { class: "muted" }, message) : null, ...rest);
const backToChat = () => h("p", { class: "small muted center" }, "You can close this and head back to the chat.");
const fmt = (iso, opts) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", ...opts }).format(new Date(iso));

async function boot() {
  try {
    model = await api("");
  } catch (e) {
    show(h("div", { class: "result" }, h("div", { class: "badge warn", html: icons.info }), h("h2", {}, e.status === 410 ? "This link has expired" : "We couldn't open this"),
      h("p", { class: "muted" }, e.message)));
    return;
  }
  document.body.dataset.kind = model.kind;
  document.title = model.title;
  ({ prescreen, info, consent, schedule, checkin, document: documents })[model.kind]();
}

// Prescreen ---------------------------------------------------------------------------------

function prescreen() {
  const { questions, answers: saved, result: done } = model.data;
  if (done) return show(header("Pre-screening"), prescreenResult(done));
  const answers = { ...saved };
  if (model.person.firstName && !answers.first_name) answers.first_name = model.person.firstName;
  const visible = () => questions.filter((q) => !q.showIf || (q.showIf.in ? q.showIf.in.includes(answers[q.showIf.key]) : answers[q.showIf.key] === q.showIf.equals));
  let index = -1;

  const intro = () => show(
    header(model.person.firstName ? `Hi ${model.person.firstName}, let's see if it's a fit` : "Let's see if the study is a fit", `${visible().length} quick questions, about 2 minutes.`),
    h("div", { class: "card stack" },
      h("p", {}, "Your answers help the study team see whether this study might be right for you. Only the study team sees them."),
      h("p", { class: "small muted" }, "There are no wrong answers, and answering doesn't sign you up for anything.")),
    actionbar(button("Start", () => { index = 0; step(); })));

  const input = (q) => {
    const value = answers[q.key];
    if (q.type === "yes_no") { const el = h("pa-yes-no"); el.value = value ?? null; return el; }
    if (q.type === "choice" || q.type === "multi_choice") {
      const el = h("pa-options", { multiple: q.type === "multi_choice" });
      el.options = q.options;
      el.value = value ?? null;
      return el;
    }
    if (q.type === "number" || q.type === "scale") { const el = h("pa-number", { min: q.min, max: q.max, unit: q.unit, label: q.prompt }); el.value = value ?? ""; return el; }
    return h("input", { class: "text-input", type: "text", value: value ?? "", autocomplete: q.key === "first_name" ? "given-name" : "off", "aria-label": q.prompt });
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
    });
    const sync = () => { next.disabled = !valid(read()); error.textContent = ""; };
    field.addEventListener("change", sync);
    field.addEventListener("input", sync);
    // Single choices advance on tap, like a native questionnaire.
    if (q.type === "yes_no" || q.type === "choice") field.addEventListener("change", () => setTimeout(() => next.click(), 180));
    show(
      h("div", { class: "header" }, h("span", { class: "chip" }, `Question ${index + 1} of ${list.length}`)),
      h("pa-progress", { value: index, max: list.length }),
      h("h2", {}, q.prompt), q.help ? h("p", { class: "muted small" }, q.help) : null,
      field, error, !q.required ? h("p", { class: "tiny" }, "Optional") : null,
      actionbar(button("Back", () => { index--; index < 0 ? intro() : step(); }, { class: "secondary back" }), next));
    sync();
    if (field.tagName === "INPUT") setTimeout(() => field.focus(), 250);
  };

  const label = (q) => {
    const v = answers[q.key];
    if (v === undefined || v === null) return "–";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (Array.isArray(v)) return v.map((x) => q.options?.find((o) => o.value === x)?.label ?? x).join(", ");
    return q.options?.find((o) => o.value === v)?.label ?? `${v}${q.unit ? ` ${q.unit}` : ""}`;
  };

  const review = () => {
    const list = visible();
    const error = h("div", { class: "error", role: "alert" });
    const submit = button("Send my answers", async () => {
      submit.disabled = true;
      error.textContent = "";
      try {
        const res = await api("prescreen", { answers: Object.fromEntries(list.filter((q) => q.key in answers).map((q) => [q.key, answers[q.key]])) });
        show(header("Pre-screening"), prescreenResult(res));
      } catch (e) {
        error.textContent = e.errors ? Object.values(e.errors)[0] : e.message;
        submit.disabled = false;
      }
    });
    show(
      header("Check your answers", "Tap any answer to change it."),
      h("pa-progress", { value: list.length, max: list.length }),
      h("div", { class: "card" }, list.map((q, i) => h("button", { type: "button", class: "option", style: "border:0;padding:12px 0;min-height:0;border-radius:0;background:none", onclick: () => { index = i; step(); } },
        h("span", { class: "grow" }, h("span", { class: "small muted", style: "display:block" }, q.prompt), h("b", {}, label(q)))))),
      error,
      actionbar(button("Back", () => { index = list.length - 1; step(); }, { class: "secondary back" }), submit));
  };

  intro();
}

function prescreenResult(res) {
  const tone = res.status === "likely_eligible" ? "good" : res.status === "needs_review" ? "neutral" : "warn";
  return result(tone, res.title, res.message, backToChat());
}

// Study info -------------------------------------------------------------------------------

function info() {
  const d = model.data;
  show(
    header("About the study", model.trial.title),
    d.summary ? h("div", { class: "card" }, h("p", { style: "margin:0" }, d.summary)) : null,
    h("div", { class: "facts", style: "margin-top:12px" }, d.facts.map((f) => h("div", { class: "fact" }, h("span", {}, f.label), h("b", {}, f.value)))),
    h("div", { class: "card", style: "margin-top:12px" }, h("h2", {}, "What happens"),
      h("ul", { class: "timeline" }, d.steps.map((v) => h("li", {}, h("span", { class: "dot" }),
        h("div", {}, h("b", {}, v.name), h("div", { class: "small muted" }, v.detail)))))),
    d.sites.length ? h("div", { class: "card" }, h("h2", {}, "Where"), d.sites.map((s) => h("p", {}, h("b", {}, s.name), h("br"), h("span", { class: "muted small" }, s.city)))) : null,
    d.sections.length ? h("div", { class: "card" }, h("h2", {}, "Common questions"),
      d.sections.map((s) => h("details", {}, h("summary", {}, s.heading), h("p", {}, s.body)))) : null,
    h("p", { class: "small muted center", style: "margin-top:18px" }, `Questions? Just text ${model.assistantName} back.`));
}

// Consent ------------------------------------------------------------------------------------

function consent() {
  const { document: doc, signature, personName } = model.data;
  if (signature) return consentSigned(signature, doc);
  const note = doc.generated
    ? h("p", { class: "small muted" }, "This is a plain-language walkthrough of the approved consent form. Ask us any time for a copy of the full form.")
    : null;
  const acknowledged = new Set();
  const keyPoints = doc.sections.filter((s) => s.key_point);

  const read = () => {
    const progress = h("pa-progress", { value: acknowledged.size, max: keyPoints.length });
    const counter = h("span", { class: "chip" }, `Key points ${acknowledged.size} of ${keyPoints.length}`);
    const next = button("Continue", check, { disabled: acknowledged.size < keyPoints.length });
    const update = () => {
      progress.setAttribute("value", acknowledged.size);
      counter.textContent = `Key points ${acknowledged.size} of ${keyPoints.length}`;
      next.disabled = acknowledged.size < keyPoints.length;
    };
    show(
      h("div", { class: "header" }, counter, h("h1", {}, doc.title), h("p", { class: "muted" }, `Version ${doc.version}. Take your time; you can ask ${model.assistantName} anything along the way.`)),
      progress,
      h("div", { class: "card" }, h("p", { style: "margin:0" }, doc.summary), note),
      h("div", { class: "card", style: "margin-top:12px" }, doc.sections.map((s) => h("div", { class: "section" },
        s.key_point ? h("span", { class: "keypoint" }, "Key point") : null, h("h3", {}, s.heading), h("p", { class: "muted", style: "margin:0" }, s.body),
        s.key_point ? h("label", { class: "ack" }, h("input", { type: "checkbox", checked: acknowledged.has(s.id),
          onchange: (ev) => { ev.target.checked ? acknowledged.add(s.id) : acknowledged.delete(s.id); update(); } }), "I understand") : null))),
      doc.signable ? actionbar(next) : h("p", { class: "small muted center" }, "This form isn't ready to sign yet. The study team will text you when it is."));
  };

  // Teach-back: once every question has an answer, the server checks them (the answer key never
  // reaches the page) and says which need another look. Signing re-checks them.
  const check = () => {
    const feedback = {};
    const next = button("Continue", agree, { disabled: true });
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
    show(
      header("Quick check", "Three questions to make sure the key points are clear."),
      doc.comprehension.map((c) => {
        feedback[c.id] = h("div", { class: "feedback" });
        const options = h("pa-options");
        options.options = c.options.map((label, i) => ({ value: String(i), label }));
        if (c.id in answers) options.value = String(answers[c.id]);
        options.addEventListener("change", () => { answers[c.id] = Number(options.value); evaluate(); });
        return h("div", { class: "card stack" }, h("h3", {}, c.question), options, feedback[c.id]);
      }),
      actionbar(button("Back", read, { class: "secondary back" }), next));
    evaluate();
  };
  const answers = {};

  const agree = () => {
    const statements = [
      "I have read this consent form and had the chance to ask questions.",
      "I understand that taking part is voluntary and I can stop at any time.",
      "I agree to take part in this study.",
    ];
    const checked = new Set();
    const name = h("input", { class: "text-input", type: "text", autocomplete: "name", placeholder: "Your full name", value: personName || "" });
    const next = button("Continue to sign", () => sign(name.value.trim(), [...checked]), { disabled: true });
    const update = () => { next.disabled = checked.size < statements.length || name.value.trim().split(/\s+/).length < 2; };
    name.addEventListener("input", update);
    show(
      header("Your agreement", "Check each statement and type your name as your signature."),
      h("div", { class: "card" }, statements.map((s) => h("label", { class: "agree" },
        h("input", { type: "checkbox", onchange: (ev) => { ev.target.checked ? checked.add(s) : checked.delete(s); update(); } }), h("span", {}, s)))),
      h("div", { class: "card stack" }, h("h3", {}, "Full name"), name),
      actionbar(button("Back", check, { class: "secondary back" }), next));
    update();
  };

  const sign = (signedName, agreements) => {
    const error = h("div", { class: "error", role: "alert" });
    const verify = h("pa-verify", { action: "sign_consent", label: "Sign with Face ID", name: signedName });
    verify.addEventListener("verified", async (ev) => {
      try {
        const res = await api("consent", { verificationId: ev.detail.verificationId, signedName, agreements, answers });
        consentSigned({ name: res.name, signedAt: res.signedAt, method: ev.detail.method, version: doc.version }, doc, true);
      } catch (e) { error.textContent = e.message; }
    });
    show(header("Sign the form", `Signing as ${signedName}.`), h("div", { class: "card" }, verify), error,
      actionbar(button("Back", agree, { class: "secondary back" })));
  };

  read();
}

function consentSigned(sig, doc, justNow = false) {
  show(
    header(justNow ? "You're all set" : "Consent form"),
    result("good", justNow ? "Consent signed" : "You've signed this form", justNow ? "Thank you. We'll text you next about booking your screening visit." : null,
      h("div", { class: "card", style: "text-align:left;margin-top:12px" }, h("dl", { class: "kv" },
        h("dt", {}, "Form"), h("dd", {}, `${doc.title} v${sig.version}`),
        h("dt", {}, "Signed by"), h("dd", {}, sig.name),
        h("dt", {}, "When"), h("dd", {}, fmt(sig.signedAt)),
        h("dt", {}, "Verified"), h("dd", {}, sig.method === "passkey" ? "Face ID" : "Typed name"),
        sig.hash ? h("dt", {}, "Fingerprint") : null, sig.hash ? h("dd", { class: "small" }, `${sig.hash.slice(0, 16)}…`) : null)),
      h("p", { class: "small muted", style: "margin-top:14px" }, "You can withdraw at any time by texting us."), backToChat()));
}

// Scheduling -----------------------------------------------------------------------------------

function schedule() {
  const d = model.data;
  const booked = (b, justNow) => show(
    header(justNow ? "You're booked" : "Your screening visit"),
    result("good", b.label, b.site,
      h("a", { class: "btn secondary", href: `${location.pathname.replace(/\/$/, "")}/visit.ics`, style: "margin-top:14px" }, h("span", { class: "icon", html: icons.calendar }), "Add to calendar"),
      h("div", { class: "card", style: "text-align:left;margin-top:14px" }, h("h3", {}, "What to bring"),
        h("ul", { class: "muted", style: "margin:6px 0 0;padding-left:20px" }, d.bring.map((item) => h("li", {}, item)))),
      h("button", { type: "button", class: "btn ghost", onclick: picker, style: "margin-top:10px" }, "Pick a different time"),
      backToChat()));

  const picker = () => {
    const slots = h("pa-slots");
    const error = h("div", { class: "error", role: "alert" });
    const confirm = button("Choose a time", null, { disabled: true });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      error.textContent = "";
      try { booked(await api("schedule", slots.value), true); }
      catch (e) { error.textContent = e.message; confirm.disabled = false; if (e.status === 409) model = await api(""); }
    });
    slots.addEventListener("change", () => {
      confirm.disabled = !slots.value;
      confirm.textContent = slots.value ? `Book ${slots.value.label}` : "Choose a time";
    });
    show(header("Book your screening visit", "About an hour. Pick whichever works best for you."), slots, error, actionbar(confirm));
    slots.data = d;
  };

  d.booked ? booked(d.booked) : picker();
}

// Daily check-in ---------------------------------------------------------------------------------

function checkin() {
  const { measures, submitted } = model.data;
  if (submitted) return show(header("Check-in"), result("good", "You're checked in", "Thanks for today.", backToChat()));
  const fields = measures.map((m) => {
    let el;
    if (m.valueType === "boolean") el = h("pa-yes-no");
    else if (m.valueType === "scale") el = h("pa-scale", { min: m.min ?? 0, max: m.max ?? 10, label: m.label });
    else if (m.valueType === "choice") {
      el = h("pa-options");
      el.options = m.choices.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, " ") }));
    } else if (m.valueType === "text") el = h("input", { class: "text-input", type: "text", "aria-label": m.label, maxlength: 500 });
    else el = h("pa-number", { min: m.min, max: m.max, unit: m.unit, step: m.valueType === "integer" ? 1 : 0.5, label: m.label });
    return { m, el };
  });
  const error = h("div", { class: "error", role: "alert" });
  const submit = button("Done", async () => {
    submit.disabled = true;
    error.textContent = "";
    try {
      await api("checkin", { values: Object.fromEntries(fields.map(({ m, el }) => [m.code, el.tagName === "INPUT" ? el.value.trim() || null : el.value])) });
      show(header("Check-in"), result("good", "You're checked in", "Thanks for today.", backToChat()));
    } catch (e) { error.textContent = e.message; submit.disabled = false; }
  });
  show(
    header(model.person.firstName ? `How was today, ${model.person.firstName}?` : "How was today?", "Under a minute. Skip anything that doesn't apply."),
    fields.map(({ m, el }) => h("div", { class: "card stack" }, h("h3", {}, m.prompt || m.label), el)),
    error, actionbar(submit));
}

// Documents (behind Face ID) ----------------------------------------------------------------------

function documents() {
  const verify = h("pa-verify", { action: "view_document", label: "Open with Face ID" });
  const error = h("div", { class: "error", role: "alert" });
  verify.addEventListener("verified", async (ev) => {
    try {
      const d = await api("document", { verificationId: ev.detail.verificationId });
      show(
        header("Your documents", d.participantCode ? `Participant ${d.participantCode}` : undefined),
        d.visit ? h("div", { class: "card" }, h("h2", {}, "Next visit"), h("p", {}, h("b", {}, d.visit.label), h("br"), h("span", { class: "muted" }, d.visit.location ?? d.visit.site))) : null,
        d.signature ? h("div", { class: "card" }, h("h2", {}, d.signature.title), h("dl", { class: "kv" },
          h("dt", {}, "Signed by"), h("dd", {}, d.signature.name), h("dt", {}, "When"), h("dd", {}, fmt(d.signature.signedAt)),
          h("dt", {}, "Verified"), h("dd", {}, d.signature.method === "passkey" ? "Face ID" : "Typed name"),
          h("dt", {}, "Fingerprint"), h("dd", { class: "small" }, `${d.signature.hash.slice(0, 16)}…`))) : null,
        d.document ? h("div", { class: "card" }, h("h2", {}, "The form you signed"),
          d.document.sections.map((s) => h("details", {}, h("summary", {}, s.heading), h("p", {}, s.body)))) : null,
        backToChat());
    } catch (e) { error.textContent = e.message; }
  });
  show(header("Your documents", "Your signed consent form and visit details are private. Confirm it's you to open them."), h("div", { class: "card" }, verify), error);
}

boot();
