// Face ID in Safari for a card opened where it can't run (Photon's iMessage view). The one-time
// link names the pending action; a passkey (Face ID) verifies the person, the server completes the
// action, and the card in Messages moves on by itself.
import { actionbar, h, icons } from "./ui.js?v=10";

const app = document.getElementById("app");
const dock = document.getElementById("dock");
const token = location.pathname.split("/")[2];
const show = (...nodes) => {
  const opts = nodes[0] && !nodes[0].nodeType && !Array.isArray(nodes[0]) && typeof nodes[0] === "object" ? nodes.shift() : {};
  const flat = nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
  const bar = (n) => n.classList?.contains("actionbar");
  document.body.dataset.page = opts.page ?? "white";
  dock.replaceChildren(...flat.filter(bar));
  app.replaceChildren(...flat.filter((n) => !bar(n)));
  app.classList.remove("fade-in"); void app.offsetWidth; app.classList.add("fade-in");
};
const fmt = (iso) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

async function call(path, body) {
  const res = await fetch(`/api/v/${token}${path ? `/${path}` : ""}`, body === undefined
    ? { headers: { accept: "application/json" } }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { status: res.status });
  return data;
}

const result = (tone, eyebrow, title, lede) => h("div", { class: "result" },
  h("div", { class: `badge${tone === "good" ? "" : " neutral"}`, html: tone === "good" ? icons.check : icons.info }),
  eyebrow ? h("span", { class: "eyebrow" }, eyebrow) : null,
  h("h1", { class: `title${title.length > 30 ? " question" : ""}` }, title),
  lede ? h("p", { class: "lede" }, lede) : null);
const section = (text) => h("h2", { class: "section-title" }, text);

function done(info, result_) {
  if (result_.action === "view_document") {
    document.body.dataset.kind = "document";
    return show({ page: "gray" },
      h("div", { class: "header" }, h("span", { class: "eyebrow" }, result_.participantCode ? `Participant ${result_.participantCode}` : "Your documents"), h("h1", { class: "title" }, "Your documents.")),
      result_.visit ? [section("Next visit"), h("div", { class: "card next-visit" }, h("b", {}, result_.visit.label), h("small", {}, result_.visit.location ?? result_.visit.site))] : null,
      result_.signature ? [section(result_.signature.title), h("div", { class: "card" }, h("dl", { class: "kv" },
        h("dt", {}, "Signed by"), h("dd", {}, result_.signature.name), h("dt", {}, "When"), h("dd", {}, fmt(result_.signature.signedAt)),
        h("dt", {}, "Verified"), h("dd", {}, result_.signature.method === "passkey" ? "Face ID" : "Typed name")))] : null,
      result_.document ? [section("The form you signed"), h("div", { class: "card list" },
        result_.document.sections.map((s) => h("details", {}, h("summary", {}, s.heading), h("p", {}, s.body))))] : null);
  }
  show(result("good", "Informed consent", "Signed.", `${result_.name}, your consent form is signed${result_.signedAt ? ` (${fmt(result_.signedAt)})` : ""}.`),
    h("p", { class: "note" }, "Head back to Messages. The card has moved on, and Sage will text you about booking your visit."));
}

async function boot() {
  let info;
  try {
    info = await call("");
  } catch (e) {
    return show(result("warn", null, e.status === 410 ? "This link has expired." : "We couldn't open this.", e.message));
  }
  document.getElementById("brand").textContent = info.assistantName;
  document.getElementById("study").textContent = info.study;
  if (info.done) return done(info, info.result);

  const signing = info.action === "sign_consent";
  const error = h("div", { class: "error", role: "alert" });
  const button = h("button", { type: "button", class: "btn grow", onclick: async () => {
    button.disabled = true;
    error.textContent = "";
    try {
      const sw = window.SimpleWebAuthnBrowser;
      const { mode, options } = await call("options", {});
      const response = mode === "register" ? await sw.startRegistration({ optionsJSON: options }) : await sw.startAuthentication({ optionsJSON: options });
      done(info, await call("verify", { response }));
    } catch (e) {
      error.textContent = (e.name === "NotAllowedError" ? "Face ID was cancelled or isn't set up on this phone. Tap the button to try again." : e.message)
        + " If Face ID won't work, go back to the card in Messages and tap \"Can't use Face ID?\" to sign by typing your full name.";
      button.disabled = false;
    }
  } }, h("span", { html: icons.faceidBold, style: "display:contents" }), "Continue with Face ID");

  show(
    h("div", { class: "verify-head" },
      h("span", { class: "faceid", html: icons.faceid, role: "img", "aria-label": "Face ID" }),
      h("span", { class: "eyebrow" }, signing ? `Signing as ${info.name}` : "Your documents"),
      h("h1", { class: "title" }, "Confirm it's you."),
      h("p", { class: "lede" }, signing
        ? `You're signing "${info.title}". The first time, your iPhone saves a passkey for Sage. Your face never leaves your phone.`
        : "Open your signed forms and visit details. Your face never leaves your phone.")),
    error,
    actionbar(button));
}

boot();
