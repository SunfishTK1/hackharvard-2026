// Trial Ops: the trial manager's mini-apps, opened from cards the Trial Ops agent sends in
// iMessage. The URL token is the manager's credential; every screen reads the ops views through
// /api/o/<token>/... Same design system as Sage's mini-apps: a thin top bar, an eyebrow over a big
// short headline, gray pages with white cards, and one glass dock (back, the screen's actions, and
// a ••• menu to move between screens). Decisions (enrollments, safety reviews, baseline visits,
// alerts) are prepared here or in chat, and only happen once the manager confirms with Face ID.
import { actionbar, button, h, icons, optionsMenu, roundButton } from "./ui.js?v=9";

const app = document.getElementById("app");
const dock = document.getElementById("dock");
const token = location.pathname.split("/")[2];
const NS = "http://www.w3.org/2000/svg";

const stroke = (body, width = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
Object.assign(icons, {
  back: stroke(`<path d="M15 5l-7 7 7 7"/>`, 2.2),
  bell: stroke(`<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>`),
  decisions: stroke(`<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>`),
  funnel: stroke(`<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>`),
  gauge: stroke(`<path d="M4.5 16a7.5 7.5 0 1 1 15 0"/><path d="M12 16l3.5-4.5"/>`),
  person: stroke(`<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>`),
  study: stroke(`<path d="M9.5 3.5h5M10.5 3.5v5.5L5.5 18a1.8 1.8 0 0 0 1.6 2.5h9.8a1.8 1.8 0 0 0 1.6-2.5L13.5 9V3.5"/>`),
  chart: stroke(`<path d="M4 20h16"/><rect x="5.5" y="11" width="3.5" height="6.5" rx="1"/><rect x="10.25" y="6" width="3.5" height="11.5" rx="1"/><rect x="15" y="13.5" width="3.5" height="4" rx="1"/>`),
  download: stroke(`<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>`),
  message: stroke(`<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z"/>`),
});

// Data ------------------------------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(`/api/o/${token}${path ? `/${path}` : ""}`, body === undefined
    ? { headers: { accept: "application/json" } }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { status: res.status });
  return data;
}
const qs = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]));
  return q.size ? `?${q}` : "";
};

let root = { name: "Trial Ops", manager: null, studies: [] };
const approvals = new Map();

// Navigation: a small stack of { view, params }, mirrored into ?view=… so a reload stays put ------

let current;
const stack = [];
let seq = 0;
/** The loading skeleton, shown only when a screen is slow; any screen shown cancels it. */
let skeleton;
const TITLES = { home: "Home", approvals: "Decisions", alerts: "Alerts", alert: "Alert", study: "Study", participant: "Participant", pipeline: "Pipeline", quality: "Data quality", approval: "Decision", analysis: "Analyses" };
const NAV = [
  { view: "home", icon: "home", label: "Home" },
  { view: "approvals", icon: "decisions", label: "Decisions" },
  { view: "alerts", icon: "bell", label: "Alerts" },
  { view: "pipeline", icon: "funnel", label: "Pipeline" },
  { view: "quality", icon: "gauge", label: "Data quality" },
  { view: "analysis", icon: "chart", label: "Analyses" },
];

const clean = (params) => Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]));
const sync = () => history.replaceState(null, "", `${location.pathname}${qs({ view: current.view, ...current.params })}`);
function go(view, params = {}) {
  if (current) stack.push(current);
  current = { view, params: clean(params) };
  sync();
  render();
}
/** Same screen, other filters: no new back step. */
function swap(params) {
  current = { view: current.view, params: clean(params) };
  sync();
  render();
}
function back() {
  current = stack.pop() ?? { view: "home", params: {} };
  sync();
  render();
}

/**
 * Shows a screen. An optional first argument { page: "white" } picks the page tone (gray by
 * default); { quiet: true } updates it in place, without the entrance animation or scrolling.
 * Action bars go to the dock outside <main>, so no animation moves them.
 */
const show = (...nodes) => {
  const opts = nodes[0] && !nodes[0].nodeType && !Array.isArray(nodes[0]) && typeof nodes[0] === "object" ? nodes.shift() : {};
  const flat = nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
  const isBar = (n) => n.classList?.contains("actionbar");
  clearTimeout(skeleton);
  document.body.dataset.page = opts.page ?? "gray";
  dock.replaceChildren(...flat.filter(isBar));
  app.replaceChildren(...flat.filter((n) => !isBar(n)));
  if (opts.quiet) return;
  app.classList.remove("fade-in"); void app.offsetWidth; app.classList.add("fade-in");
  window.scrollTo(0, 0);
};

async function render() {
  const mine = ++seq;
  const alive = () => mine === seq;
  clearTimeout(skeleton);
  skeleton = setTimeout(() => {
    if (alive()) app.replaceChildren(...["40%", "80%", "100%", "70%"].map((w, i) => h("div", { class: "skeleton", style: `width: ${w}${i === 1 ? "; height: 44px" : ""}` })));
  }, 160);
  try {
    const nodes = await SCREENS[current.view](current.params, alive);
    if (alive() && nodes) show(...nodes);
  } catch (e) {
    if (!alive()) return;
    show(result("warn", null, e.status === 410 ? "This link has expired." : e.status === 404 ? "Not found." : "We couldn't load this.", e.status === 410 ? "Ask Trial Ops in Messages for a fresh one." : e.message), bar());
  } finally {
    if (alive()) clearTimeout(skeleton);
  }
}

/** The glass dock: back (when there is somewhere to go back to), the screen's actions, and the ••• menu. */
function bar(...items) {
  const opts = items[0] && !items[0].nodeType && !Array.isArray(items[0]) && typeof items[0] === "object" ? items.shift() : {};
  const content = items.flat().filter(Boolean);
  const more = roundButton("more", "Go to");
  optionsMenu(more, () => [
    ...NAV.filter((n) => n.view !== current.view || Object.keys(current.params).length).map((n) => ({ icon: n.icon, label: n.label, onclick: () => go(n.view) })),
    ...(opts.menu?.length ? ["-", ...opts.menu] : []),
  ], { label: "Go to" });
  const summary = h("div", { class: "summary nav" }, h("b", {}, opts.title ?? TITLES[current.view]), h("span", {}, opts.subtitle ?? root.manager?.name ?? root.name));
  return actionbar(stack.length ? roundButton("back", "Back", back) : null, ...(content.length ? content : [summary]), more);
}

// Building blocks -------------------------------------------------------------------------------

const header = (eyebrow, title, lede) => h("div", { class: "header" },
  eyebrow ? h("span", { class: "eyebrow" }, eyebrow) : null,
  title ? h("h1", { class: `title${title.length > 26 ? " compact" : ""}` }, title) : null,
  lede ? h("p", { class: "lede" }, lede) : null);
const result = (tone, eyebrow, title, lede) => h("div", { class: "result" },
  h("div", { class: `badge${tone === "good" ? "" : " neutral"}`, html: tone === "good" ? icons.check : tone === "warn" ? icons.info : icons.clock }),
  eyebrow ? h("span", { class: "eyebrow" }, eyebrow) : null,
  h("h1", { class: `title${title.length > 26 ? " compact" : ""}` }, title),
  lede ? h("p", { class: "lede" }, lede) : null);
const sectionHead = (title, link) => h("div", { class: "section-head" },
  h("h2", { class: "section-title" }, title),
  link ? h("button", { type: "button", class: "btn link", onclick: link.onclick }, link.label) : null);
const listCard = (rows, empty) => h("div", { class: "card list" }, rows.length ? rows : h("p", { class: "empty" }, empty ?? "Nothing here."));
const chevron = () => h("span", { class: "chevron", html: icons.chevron });
const sev = (level) => h("span", { class: `sev ${level}`, role: "img", "aria-label": level });
const tag = (text, cls = "muted") => h("span", { class: `tag small ${cls}` }, text);
const sageChip = () => tag("Sage", "chip-sage");

/** A list row: tappable when `onclick` is set. `lead` sits left, `end` right, `meta` is a line of small facts. */
function row({ onclick, lead, title, sub, meta, end, top, bold = true, extra }) {
  const text = h("span", { class: "text" },
    h(bold ? "b" : "span", { class: bold ? null : "label" }, title),
    sub ? h("small", {}, sub) : null,
    meta?.filter(Boolean).length ? h("span", { class: "meta" }, meta.filter(Boolean).map((m) => (m.nodeType ? m : h("span", {}, m)))) : null,
    extra ?? null);
  const children = [lead ?? null, text, end ? h("span", { class: "end" }, end) : null, onclick ? chevron() : null];
  return onclick
    ? h("button", { type: "button", class: `list-row${top ? " top" : ""}`, onclick }, ...children)
    : h("div", { class: `list-row${top ? " top" : ""}` }, ...children);
}
function tile({ label, value, note, ink, onclick }) {
  const body = [h("span", {}, label), h("b", {}, value), note ? h("small", {}, note) : null];
  return onclick ? h("button", { type: "button", class: `tile-btn${ink ? " ink" : ""}`, onclick }, ...body) : h("div", { class: `tile-btn${ink ? " ink" : ""}` }, ...body);
}
function barRow({ label, value, frac, sub, soft, onclick }) {
  const fill = h("div", { class: `fill${soft ? " soft" : ""}`, style: `width: ${Math.max(0, Math.min(1, frac ?? 0)) * 100}%` });
  const body = [h("div", { class: "top" }, h("span", {}, label), h("b", {}, value)), h("div", { class: "track" }, fill), sub ? h("span", { class: "sub" }, sub) : null];
  return onclick ? h("button", { type: "button", class: "bar-row", onclick }, ...body) : h("div", { class: "bar-row" }, ...body);
}
/** Shows the first `limit` rows, then a "Show all" row that reveals the rest. */
function capped(rows, limit = 6) {
  if (rows.length <= limit + 1) return rows;
  const rest = rows.slice(limit);
  const more = h("button", { type: "button", class: "btn link", style: "padding: 0; margin: 4px 0 10px", onclick: () => more.replaceWith(...rest) }, `Show all ${rows.length}`);
  return [...rows.slice(0, limit), more];
}
const svg = (attrs, inner) => {
  const el = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.innerHTML = inner;
  return el;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (n) => (n === null || n === undefined ? "—" : `${n}%`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "STUDY-005-P009" → "P009". */
const shortCode = (code) => code.match(/P\d+$/)?.[0] ?? code;
/** "BP-Link · Hypertension" → "BP-Link"; falls back to the code. */
const studyName = (code) => (root.studies.find((s) => s.code === code)?.short ?? code).split(" · ")[0].split(",")[0];
const STATUS = { consent_pending: "Invited", consented: "Consented", enrolled: "Enrolled", active: "Active", completed: "Completed", withdrawn: "Withdrawn", screen_failed: "Screen failed" };
const ROLE = { principal_investigator: "Investigator", coordinator: "Coordinator", trial_manager: "Trial manager" };
const KIND = {
  confirm_enrollment: "Confirm enrollment", decline_enrollment: "Decline enrollment", activate: "Baseline visit",
  review_safety: "Safety review", acknowledge_alert: "Acknowledge alert", resolve_alert: "Resolve alert",
};
const SEVERITIES = ["critical", "high", "medium", "low"];

/** Study filter chips: All plus one per study. */
function studyChips(selected, pick) {
  const chip = (code, label) => h("button", { type: "button", class: "chip-toggle", "aria-pressed": String((selected ?? "") === code), onclick: () => pick(code || undefined) }, label);
  return h("div", { class: "chips small", role: "group", "aria-label": "Study" }, chip("", "All"), root.studies.map((s) => chip(s.code, studyName(s.code))));
}

/** Prepares a decision on the server, then opens its confirm screen. */
async function decide(kind, targetId) {
  try {
    const { approval } = await api("decide", { kind, targetId });
    approvals.set(approval.id, approval);
    go("approval", { id: approval.id });
  } catch (e) {
    flash(e.message);
  }
}
function flash(message) {
  app.querySelector(".flash")?.remove();
  app.prepend(h("div", { class: "notice flash", role: "alert", style: "margin-bottom: 20px" }, h("span", { html: icons.info, style: "display:contents" }), h("span", { class: "text" }, h("b", {}, "That didn't work."), h("span", {}, message))));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Charts ----------------------------------------------------------------------------------------

/** One numeric series over time: the current readings joined; flagged ones in the accent, corrected ones faded. */
function seriesChart(series) {
  const pts = series.points.filter((p) => p.n !== null && p.n !== undefined);
  if (pts.length < 2) return null;
  const t = pts.map((p) => Date.parse(p.at));
  const t0 = Math.min(...t), t1 = Math.max(...t);
  const values = pts.map((p) => p.n);
  const max = Math.max(...values), min = Math.min(...values);
  let lo = min, hi = max;
  if (hi - lo < 4) { lo -= 2; hi += 2; }
  const L = 34, R = 314, T = 10, B = 92;
  const x = (at) => (t1 === t0 ? (L + R) / 2 : L + ((at - t0) / (t1 - t0)) * (R - L));
  const y = (v) => B - ((v - lo) / (hi - lo)) * (B - T);
  const line = pts.filter((p) => !p.superseded).map((p) => `${x(Date.parse(p.at)).toFixed(1)},${y(p.n).toFixed(1)}`).join(" ");
  const dots = pts.map((p) => `<circle class="${p.superseded ? "superseded" : p.flagged ? "flagged" : ""}" cx="${x(Date.parse(p.at)).toFixed(1)}" cy="${y(p.n).toFixed(1)}" r="${p.flagged && !p.superseded ? 4.2 : 2.4}"><title>${esc(p.day)}: ${esc(p.value)}${p.flagged ? " (flagged)" : ""}${p.superseded ? " (corrected)" : ""}</title></circle>`).join("");
  return svg({ class: "mini-chart", viewBox: "0 0 320 116", role: "img", "aria-label": `${series.label}: ${pts.length} readings from ${pts[0].day} to ${pts.at(-1).day}, between ${min} and ${max}${series.unit ? ` ${series.unit}` : ""}.` },
    `<line x1="${L}" y1="${y(max)}" x2="${R}" y2="${y(max)}"></line><line x1="${L}" y1="${y(min)}" x2="${R}" y2="${y(min)}"></line>
     <polyline points="${line}"></polyline>${dots}
     <text x="0" y="${y(max) + 4}">${esc(max)}</text>${max !== min ? `<text x="0" y="${y(min) + 4}">${esc(min)}</text>` : ""}
     <text x="${L}" y="112">${esc(pts[0].day)}</text><text x="${R}" y="112" text-anchor="end">${esc(pts.at(-1).day)}</text>`);
}

/** Days from signature to enrollment, per signed participant; the ones still waiting ringed in the accent. */
function signatureChart(points, typical) {
  if (!points.length) return null;
  const at = (d) => Date.parse(`${d}T12:00:00Z`);
  const t0 = Math.min(...points.map((p) => at(p.signedOn))), t1 = Math.max(...points.map((p) => at(p.signedOn)), t0 + 86_400_000);
  const top = Math.max(4, ...points.map((p) => p.days), (typical ?? 0) + 1);
  const L = 22, R = 314, T = 10, B = 104;
  const x = (d) => L + ((at(d) - t0) / (t1 - t0)) * (R - L);
  const y = (v) => B - (v / top) * (B - T);
  const day = (d) => new Date(at(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const dots = points.map((p) => `<circle class="${p.waiting ? "wait" : ""}" cx="${x(p.signedOn).toFixed(1)}" cy="${y(p.days).toFixed(1)}" r="${p.waiting ? 5 : 3.2}"><title>${esc(p.participant)}: ${p.days} ${p.days === 1 ? "day" : "days"}${p.waiting ? ", still waiting" : ""}</title></circle>`).join("");
  return svg({ class: "mini-chart", viewBox: "0 0 320 128", role: "img", "aria-label": `Days from consent signature to enrollment for ${points.length} participants${typical !== null ? `; typical ${typical} days` : ""}.` },
    `<line x1="${L}" y1="${B}" x2="${R}" y2="${B}"></line>
     ${typical !== null && typical !== undefined ? `<line class="typical" x1="${L}" y1="${y(typical)}" x2="${R}" y2="${y(typical)}"></line><text x="0" y="${y(typical) + 4}">${typical}d</text>` : ""}
     <text x="0" y="${T + 8}">${top}d</text><text x="0" y="${B}">0</text>
     ${dots}
     <text x="${L}" y="124">${esc(day(points[0].signedOn))}</text><text x="${R}" y="124" text-anchor="end">${esc(day(points.at(-1).signedOn))}</text>`);
}

function ring(rate) {
  const c = 2 * Math.PI * 40;
  return svg({ class: "ring", viewBox: "0 0 96 96", role: "img", "aria-label": rate === null ? "No check-ins due" : `${rate}% of check-ins done` },
    `<circle class="track" cx="48" cy="48" r="40" fill="none" stroke-width="10"></circle>
     <circle class="fill" cx="48" cy="48" r="40" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - (rate ?? 0) / 100)}" transform="rotate(-90 48 48)"></circle>
     <text x="48" y="54" text-anchor="middle" class="big pct">${rate === null ? "—" : `${rate}%`}</text>`);
}

function lifecycle(counts) {
  const order = ["active", "completed", "enrolled", "consented", "consent_pending", "withdrawn", "screen_failed"];
  const total = order.reduce((n, k) => n + (counts[k] ?? 0), 0) || 1;
  return h("div", { class: "lifecycle", role: "img", "aria-label": order.filter((k) => counts[k]).map((k) => `${counts[k]} ${STATUS[k].toLowerCase()}`).join(", ") },
    order.filter((k) => counts[k]).map((k) => h("i", { class: k, style: `width: ${(counts[k] / total) * 100}%` })));
}
const legend = () => h("div", { class: "legend", "aria-hidden": "true" },
  [["active", "Active"], ["enrolled", "Enrolled"], ["consented", "Consented"], ["consent_pending", "Invited"], ["withdrawn", "Left"]].map(([k, label]) =>
    h("span", {}, h("i", { class: k, style: `background: var(--${{ active: "ink", enrolled: "ink-64", consented: "ink-40", consent_pending: "ink-20", withdrawn: "ink-10" }[k]})` }), label)));

// Screens ---------------------------------------------------------------------------------------

const SCREENS = {
  async home() {
    const d = await api("home");
    return [
      header(d.date, d.headline, d.lede),
      h("div", { class: "tiles" }, d.tiles.map((t) => tile({ label: t.label, value: t.value, note: t.note, ink: t.tone === "alert" && t.value !== "0", onclick: () => go(t.link.view, t.link.params) }))),
      sectionHead("All studies"),
      legend(),
      listCard(d.studies.map((s) => row({
        onclick: () => go("study", { code: s.code }),
        title: studyName(s.code),
        sub: [s.short.split(" · ")[1], s.code, s.phase === "Not Applicable" ? null : s.phase, s.managers].filter(Boolean).join(" · "),
        extra: lifecycle(s.counts),
        meta: [
          `${s.signed} of ${s.invited} signed`,
          `${plural(s.openAlerts, "open alert")}${s.highAlerts ? ` · ${s.highAlerts} high` : ""}`,
          `Check-ins ${pct(s.completion7d)}`,
        ],
        end: s.decisions ? [tag(String(s.decisions), "accent")] : null,
      }))),
      sectionHead("What changed", { label: "Alerts", onclick: () => go("alerts") }),
      listCard(capped(d.changes.map(changeRow), 8), "Nothing new in the last day."),
      bar(),
    ];
  },

  async approvals(params) {
    const d = await api(`approvals${qs({ study: params.study })}`);
    const total = d.enrollments.length + d.safety.length + d.activations.length;
    const enrollment = (e) => h("div", { class: "card" },
      h("button", { type: "button", class: "card-head", onclick: () => go("participant", { code: e.participant }) },
        h("h2", {}, e.participant), e.viaSage ? sageChip() : null, h("span", { class: "grow" }), h("small", {}, `Waiting ${e.waiting}`), chevron()),
      h("p", { class: "small muted", style: "margin-top: 2px" }, `${studyName(e.study)} · ${e.site}`),
      h("div", { class: "entries" },
        h("div", {}, h("span", {}, "Consent"), e.consent),
        e.prescreen ? h("div", {}, h("span", {}, "Prescreen"), cap(e.prescreen)) : null,
        e.screeningVisit ? h("div", {}, h("span", {}, "Visit"), `Screening ${e.screeningVisit}`) : null,
        e.assignee ? h("div", {}, h("span", {}, "With"), e.assignee) : null),
      h("div", { class: "decision-actions" },
        button("Confirm", () => decide("confirm_enrollment", e.taskId)),
        button("Decline", () => decide("decline_enrollment", e.taskId), { class: "soft" })));
    const safety = (s) => h("div", { class: "card" },
      h("div", { class: "series-head" }, h("span", { style: "display: flex; align-items: center; gap: 8px; color: var(--ink)" }, sev(s.severity), h("b", { style: "font-size: 15px" }, cap(s.severity))), h("span", {}, `Waiting ${s.waiting}`)),
      h("h2", { style: "margin-top: 8px" }, s.reason),
      h("p", { class: "small muted", style: "margin-top: 4px" }, `${s.participant} · ${s.site}${s.assignee ? ` · ${s.assignee}` : ""}`),
      h("div", { class: "decision-actions" },
        button("Review", () => decide("review_safety", s.taskId)),
        s.alertId ? button("See alert", () => go("alert", { id: s.alertId }), { class: "soft" }) : button("Participant", () => go("participant", { code: s.participant }), { class: "soft" })));
    const activation = (a) => row({
      title: a.participant, sub: `${studyName(a.study)} · ${a.site}`,
      meta: [`Enrolled ${a.enrolled}`, a.confirmedBy ? `by ${a.confirmedBy}` : null, a.viaSage ? sageChip() : null],
      end: [button("Record", () => decide("activate", a.participantId), { class: "soft" })],
    });
    return [
      header(params.study ? studyName(params.study) : "Decisions", total ? `${total} waiting.` : "All clear.", "Nothing changes until you confirm with Face ID."),
      h("div", { class: "filters" }, studyChips(params.study, (code) => swap({ study: code }))),
      d.enrollments.length ? [sectionHead(`Enrollments · ${d.enrollments.length}`), capped(d.enrollments.map(enrollment), 4)] : null,
      d.safety.length ? [sectionHead(`Safety reviews · ${d.safety.length}`), capped(d.safety.map(safety), 4)] : null,
      d.activations.length ? [sectionHead(`Baseline visits · ${d.activations.length}`), listCard(capped(d.activations.map(activation)))] : null,
      total ? null : h("p", { class: "note" }, "No enrollments, safety reviews or baseline visits are waiting."),
      bar(),
    ];
  },

  async approval(params, alive) {
    const a = approvals.get(params.id) ?? (await api(`approval${qs({ id: params.id })}`)).approval;
    approvals.set(a.id, a);
    if (!alive()) return;
    if (["done", "failed", "cancelled"].includes(a.status)) return finishedScreen(a);
    confirmScreen(a, alive);
  },

  async alerts(params) {
    const status = params.status ?? "unresolved";
    const { alerts } = await api(`alerts${qs({ study: params.study, status, severity: params.severity })}`);
    const high = alerts.filter((a) => a.severity === "high" || a.severity === "critical").length;
    const groups = SEVERITIES.map((level) => [level, alerts.filter((a) => a.severity === level)]).filter(([, list]) => list.length);
    const seg = (value, label) => h("button", { type: "button", "aria-pressed": String(status === value), onclick: () => swap({ ...params, status: value === "unresolved" ? undefined : value }) }, label);
    return [
      header(params.study ? `Alerts · ${studyName(params.study)}` : "Alerts",
        status === "resolved" ? `${alerts.length} resolved.` : status === "all" ? `${plural(alerts.length, "alert")}.` : alerts.length ? `${alerts.length} open.` : "None open.",
        status === "resolved" ? "Most recent first." : high ? `${high} high or critical. Assigned to the site's coordinator, or its investigator for safety reviews.` : "Sorted by severity, then most recent."),
      h("div", { class: "filters" },
        h("div", { class: "segmented", role: "group", "aria-label": "Status" }, seg("unresolved", "Open"), seg("all", "All"), seg("resolved", "Resolved")),
        studyChips(params.study, (code) => swap({ ...params, study: code }))),
      groups.map(([level, list]) => [
        h("div", { class: "group-label" }, sev(level), `${cap(level)} · ${list.length}`),
        listCard(capped(list.map(alertRow), 8)),
      ]),
      alerts.length ? null : h("p", { class: "note" }, status === "resolved" ? "Nothing resolved yet." : "No open alerts."),
      bar(),
    ];
  },

  async alert(params) {
    const d = await api(`alert${qs({ id: params.id })}`);
    const timeline = [
      ["Raised", d.when],
      d.acknowledgedAt ? ["Acknowledged", `${d.acknowledgedAt}${d.acknowledgedBy ? ` · ${d.acknowledgedBy}` : ""}`] : null,
      d.resolvedAt ? ["Resolved", `${d.resolvedAt}${d.resolvedBy ? ` · ${d.resolvedBy}` : ""}`] : null,
    ].filter(Boolean);
    const actions = [];
    if (d.status === "open") actions.push(button("Acknowledge", () => decide("acknowledge_alert", d.id), { class: "soft" }));
    if (d.status !== "resolved") actions.push(d.reviewTaskId ? button("Review", () => decide("review_safety", d.reviewTaskId), { class: "grow" }) : button("Resolve", () => decide("resolve_alert", d.id), { class: "grow" }));
    return [
      header(`${cap(d.severity)} · ${studyName(d.study)}`, d.reason, d.recommendedAction ?? null),
      h("div", { class: "badges" }, tag(cap(d.severity), "ink"), tag(cap(d.status)), d.fromSage ? sageChip() : null, d.rule ? tag(d.rule) : null),
      h("div", { class: "card space" }, h("dl", { class: "kv" },
        h("dt", {}, "Participant"), h("dd", {}, h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); go("participant", { code: d.participant }); } }, d.participant)),
        h("dt", {}, "Status"), h("dd", {}, STATUS[d.participantStatus] ?? cap(d.participantStatus)),
        h("dt", {}, "Site"), h("dd", {}, d.site),
        h("dt", {}, "Assigned to"), h("dd", {}, d.assignee ? `${d.assignee}${d.assigneeRole ? `, ${ROLE[d.assigneeRole] ?? d.assigneeRole}` : ""}` : "No one"),
        h("dt", {}, "Type"), h("dd", {}, cap(d.type.replace(/_/g, " "))),
        h("dt", {}, "Age"), h("dd", {}, d.age))),
      sectionHead("Timeline"),
      listCard(timeline.map(([what, when]) => row({ title: what, sub: when, lead: h("span", { class: "mark ink", "aria-hidden": "true" }) })).concat(
        d.resolutionNotes ? [h("p", { class: "quote", style: "margin: 0 0 14px" }, d.resolutionNotes)] : [])),
      d.related.length ? [sectionHead("Same participant"), listCard(d.related.map(alertRow))] : null,
      bar({ menu: [{ icon: "person", label: d.participant, onclick: () => go("participant", { code: d.participant }) }] }, actions),
    ];
  },

  async study(params) {
    const d = await api(`study${qs({ code: params.code })}`);
    const s = d.study;
    const first = d.funnel[0]?.count || 1;
    return [
      header([s.code, s.phase === "Not Applicable" ? null : s.phase].filter(Boolean).join(" · "), `${studyName(s.code)}.`, s.title),
      h("div", { class: "tiles" },
        tile({ label: "Enrolled", value: String(s.enrolled), note: s.target ? `of ${s.target} target` : `${s.participants} participants` }),
        tile({ label: "Decisions", value: String(s.decisions), note: s.decisions ? "Waiting" : "Nothing waiting", ink: s.decisions > 0, onclick: () => go("approvals", { study: s.code }) }),
        tile({ label: "Open alerts", value: String(s.openAlerts), note: s.highAlerts ? `${s.highAlerts} high` : "None high", onclick: () => go("alerts", { study: s.code }) }),
        tile({ label: "Check-ins", value: pct(s.completion7d), note: "Last 7 days", onclick: () => go("quality", { study: s.code }) })),
      sectionHead("Enrollment"),
      h("div", { class: "card" }, h("div", { class: "bars" }, d.funnel.map((f) => barRow({ label: f.stage, value: String(f.count), frac: f.count / first })))),
      d.sage ? [sectionHead("Recruited by Sage"), h("div", { class: "card" },
        h("p", { class: "small muted" }, "People who texted Sage about this study."),
        h("div", { class: "stages" }, [["Texted", d.sage.people], ["Screened", d.sage.prescreened], ["Eligible", d.sage.likelyEligible], ["Signed", d.sage.consented], ["Enrolled", d.sage.enrolled]].map(([label, n]) =>
          h("div", {}, h("b", {}, String(n)), h("span", {}, label), h("i", {}, h("em", { style: `width: ${(n / (d.sage.people || 1)) * 100}%` }))))))] : null,
      sectionHead("Sites"),
      listCard(d.sites.map((x) => row({
        title: x.name, sub: [x.city, x.investigator, x.coordinator].filter(Boolean).join(" · "),
        meta: [`${x.participants} participants · ${x.active} active`, `Check-ins ${pct(x.completion)}`, x.overdue ? `${x.overdue} overdue` : null, x.openAlerts ? plural(x.openAlerts, "open alert") : null],
      }))),
      d.measures.length ? [sectionHead("Check-ins by measure"), h("div", { class: "card" }, h("div", { class: "bars" },
        [...d.measures].sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101)).map((m) => barRow({ label: m.label, value: pct(m.rate), frac: (m.rate ?? 0) / 100, sub: `${m.done} of ${m.due}, last 7 days` }))))] : null,
      sectionHead(`Participants · ${d.participants.length}`),
      listCard(capped(d.participants.map((p) => row({
        onclick: () => go("participant", { code: p.code }),
        title: shortCode(p.code), sub: `${STATUS[p.status] ?? p.status} · ${p.site}`,
        meta: [p.openAlerts ? plural(p.openAlerts, "open alert") : null, p.overdue ? `${p.overdue} overdue` : null, p.lastReading ? `Last reading ${p.lastReading}` : null],
        end: p.viaSage ? [sageChip()] : null,
      })), 8)),
      d.alerts.length ? [sectionHead("Open alerts", d.alerts.length > 5 ? { label: "See all", onclick: () => go("alerts", { study: s.code }) } : null), listCard(d.alerts.slice(0, 5).map(alertRow))] : null,
      d.changes.length ? [sectionHead("What changed"), listCard(d.changes.map(changeRow))] : null,
      bar({ menu: [
        { icon: "decisions", label: `Decisions for ${studyName(s.code)}`, onclick: () => go("approvals", { study: s.code }) },
        { icon: "funnel", label: `Pipeline for ${studyName(s.code)}`, onclick: () => go("pipeline", { study: s.code }) },
        { icon: "gauge", label: `Data quality for ${studyName(s.code)}`, onclick: () => go("quality", { study: s.code }) },
      ] }),
    ];
  },

  async participant(params) {
    const d = await api(`participant${qs({ code: params.code })}`);
    const numeric = d.readings.filter((r) => r.numeric && r.points.some((p) => p.n !== null));
    const other = d.readings.filter((r) => !numeric.includes(r));
    const pendingButtons = d.pending.flatMap((p) => p.kind === "confirm_enrollment"
      ? [button("Confirm enrollment", () => decide("confirm_enrollment", p.id)), button("Decline", () => decide("decline_enrollment", p.id), { class: "soft" })]
      : p.kind === "activate" ? [button("Record baseline visit", () => decide("activate", p.id))]
      : [button("Review", () => decide("review_safety", p.id), { class: "soft" })]);
    return [
      header(`${d.study} · ${studyName(d.study)}`, `${shortCode(d.code)}.`, `${STATUS[d.status] ?? d.status} at ${d.site}.`),
      h("div", { class: "badges" }, tag(STATUS[d.status] ?? d.status, "ink"), d.viaSage ? sageChip() : null, d.eligibility ? tag(cap(d.eligibility.replace(/_/g, " "))) : null),
      d.pending.length ? h("div", { class: "card space" },
        h("h2", {}, d.pending.length === 1 ? "Waiting on you." : `${d.pending.length} waiting on you.`),
        h("div", { class: "entries" }, d.pending.map((p) => h("div", {}, h("span", {}, KIND[p.kind]?.split(" ")[0] ?? ""), p.text))),
        h("div", { class: "decision-actions" }, pendingButtons)) : null,
      h("div", { class: "card overview space" }, ring(d.adherence.rate), h("div", { class: "stat" },
        h("b", {}, d.adherence.due ? `${d.adherence.done} of ${d.adherence.due}` : "None due"),
        h("span", {}, `Check-ins done, last 14 days${d.adherence.overdue ? `. ${d.adherence.overdue} missed.` : "."}`))),
      h("div", { class: "card", style: "margin-top: 12px" }, h("dl", { class: "kv" },
        h("dt", {}, "Study"), h("dd", {}, h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); go("study", { code: d.study }); } }, d.study)),
        h("dt", {}, "Consent"), h("dd", {}, d.consent ? `${d.consent.version}, ${d.consent.status}${d.consent.signed ? ` ${d.consent.signed}` : ""}` : "None"),
        d.enrolled ? [h("dt", {}, "Enrolled"), h("dd", {}, `${d.enrolled}${d.confirmedBy ? `, by ${d.confirmedBy}` : ""}`)] : null,
        d.activated ? [h("dt", {}, "Active since"), h("dd", {}, d.activated)] : null,
        d.arm ? [h("dt", {}, "Arm"), h("dd", {}, d.arm)] : null,
        d.nextVisit ? [h("dt", {}, "Next visit"), h("dd", {}, d.nextVisit)] : null)),
      numeric.length || other.length ? sectionHead("Readings, 3 weeks") : null,
      numeric.map((s) => {
        const last = s.points.filter((p) => !p.superseded).at(-1) ?? s.points.at(-1);
        const flagged = s.points.filter((p) => p.flagged && !p.superseded).length;
        const corrected = s.points.filter((p) => p.superseded).length;
        return h("div", { class: "card", style: "margin-top: 12px" },
          h("div", { class: "series-head" }, h("h2", {}, s.label), h("span", {}, plural(s.points.length, "reading"))),
          h("div", { class: "series-value" }, h("b", {}, last.value), h("span", {}, `${s.unit ?? ""}${s.unit ? " · " : ""}${last.day}`)),
          seriesChart(s),
          flagged || corrected ? h("div", { class: "chart-key" },
            flagged ? h("span", {}, h("i", { class: "flagged" }), `${flagged} flagged`) : null,
            corrected ? h("span", {}, h("i", { class: "superseded" }), `${corrected} corrected`) : null) : null);
      }),
      other.map((s) => {
        const yesNo = s.points.every((p) => p.value === "Yes" || p.value === "No");
        const recent = s.points.slice(-14);
        return h("div", { class: "card", style: "margin-top: 12px" },
          h("div", { class: "series-head" }, h("h2", {}, s.label), h("span", {}, yesNo ? `Yes on ${recent.filter((p) => p.value === "Yes").length} of ${recent.length}` : plural(s.points.length, "answer"))),
          yesNo
            ? h("div", { class: "dots", role: "img", "aria-label": recent.map((p) => `${p.day} ${p.value}`).join(", ") }, recent.map((p) => h("i", { class: p.value === "Yes" ? "" : "no", title: `${p.day}: ${p.value}` })))
            : h("div", { class: "entries" }, s.points.slice(-5).reverse().map((p) => h("div", {}, h("span", {}, p.day),
                h("span", { class: /^(none|no|nothing)/i.test(p.value) ? "quiet" : "", style: "width: auto; padding: 0; font-size: 15px" }, p.value)))));
      }),
      d.alerts.length ? [sectionHead("Alerts"), listCard(capped(d.alerts.map((a) => alertRow(a, { here: true })), 5))] : null,
      sectionHead("Messages"),
      h("div", { class: "card" },
        h("p", { class: "small" }, `${plural(d.messages.inbound, "message")} from them, ${plural(d.messages.outbound, "message")} to them.${d.messages.lastInbound ? ` Last reply ${d.messages.lastInbound}.` : " No replies yet."}`),
        d.messages.last ? [h("p", { class: "quote" }, d.messages.last.body), h("p", { class: "tiny", style: "margin-top: 6px" }, `${d.messages.last.direction === "inbound" ? "From them" : "To them"} · ${d.messages.last.when}`)] : null),
      d.timeline.length ? [sectionHead("Timeline"), listCard(capped(d.timeline.map((e) => row({ title: e.text, sub: e.when, bold: false })), 6))] : null,
      bar({ menu: [{ icon: "study", label: studyName(d.study), onclick: () => go("study", { code: d.study }) }] }),
    ];
  },

  async pipeline(params) {
    const d = await api(`pipeline${qs({ study: params.study })}`);
    const typical = d.medians[1]?.days ?? null;
    return [
      header(params.study ? `Pipeline · ${studyName(params.study)}` : "Pipeline", d.headline, d.lede),
      h("div", { class: "filters" }, studyChips(params.study, (code) => swap({ study: code }))),
      h("div", { class: "tiles three" }, d.medians.map((m) => tile({ label: m.label, value: m.days === null ? "—" : [String(m.days), h("small", {}, m.days === 1 ? " day" : " days")], note: m.note }))),
      sectionHead("By study"),
      listCard(d.stages.map((s) => {
        const top = s.invited || 1;
        return row({
          onclick: () => go("study", { code: s.study }),
          title: studyName(s.study), sub: [s.short.split(" · ")[1], s.study, s.declined ? `${s.declined} declined` : null].filter(Boolean).join(" · "),
          extra: h("div", { class: "stages" }, [["Invited", s.invited], ["Opened", s.opened], ["Signed", s.signed], ["Enrolled", s.enrolled], ["Active", s.active]].map(([label, n]) =>
            h("div", {}, h("b", {}, String(n)), h("span", {}, label), h("i", {}, h("em", { style: `width: ${(n / top) * 100}%` }))))),
        });
      })),
      d.points.length ? [sectionHead("Signature to enrollment"), h("div", { class: "card" },
        h("p", { class: "small muted" }, "Days an investigator took to confirm each signed participant, last 45 days."),
        signatureChart(d.points, typical),
        h("div", { class: "chart-key" }, h("span", {}, h("i", {}), "Confirmed"), h("span", {}, h("i", { class: "wait" }), `Still waiting · ${d.points.filter((p) => p.waiting).length}`),
          typical !== null ? h("span", {}, h("i", { class: "typ" }), `Typical, ${typical} ${typical === 1 ? "day" : "days"}`) : null))] : null,
      d.stuck.length ? [sectionHead(`Stuck · ${d.stuck.length}`), listCard(capped(d.stuck.map((s) => row({
        onclick: () => go("participant", { code: s.participant }),
        title: s.what, sub: `${s.participant} · ${studyName(s.study)}`, bold: false, end: [tag(s.age, s.days >= 7 ? "ink" : "muted")],
      })), 6))] : null,
      d.sage.length ? [sectionHead("Recruited by Sage"), listCard(d.sage.map((s) => row({
        title: studyName(s.study), sub: `${plural(s.people, "person", "people")} texted Sage`,
        extra: h("div", { class: "stages" }, [["Screened", s.prescreened], ["Eligible", s.likelyEligible], ["Review", s.needsReview], ["Signed", s.consented], ["Enrolled", s.enrolled]].map(([label, n]) =>
          h("div", {}, h("b", {}, String(n)), h("span", {}, label), h("i", {}, h("em", { style: `width: ${(n / (s.people || 1)) * 100}%` }))))),
      })))] : null,
      bar(),
    ];
  },

  async analysis(params, alive) {
    if (!params.id) return analysisList();
    await analysisScreen(params.id, alive);
  },

  async quality(params) {
    const d = await api(`quality${qs({ study: params.study })}`);
    const person = (code) => () => go("participant", { code });
    const all = !params.study;
    const sections = [
      d.completion.length ? [sectionHead("Check-ins by site"), h("div", { class: "card" }, h("div", { class: "bars" },
        [...d.completion].sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101)).map((c) => barRow({
          label: c.site, value: pct(c.rate), frac: (c.rate ?? 0) / 100,
          sub: `${all ? `${studyName(c.study)} · ` : ""}${c.done} of ${c.due} done${c.overdue ? `, ${c.overdue} missed` : ""}`,
        }))))] : null,
      d.measures.length ? [sectionHead("By measure"), h("div", { class: "card" }, h("div", { class: "bars" },
        capped([...d.measures].sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101)).map((m) => barRow({
          label: m.label, value: pct(m.rate), frac: (m.rate ?? 0) / 100, sub: `${all ? `${studyName(m.study)} · ` : ""}${m.done} of ${m.due}`, soft: true,
        })), 6)))] : null,
      d.silent.length ? [sectionHead(`Gone quiet · ${d.silent.length}`), listCard(capped(d.silent.map((s) => row({
        onclick: person(s.participant), title: shortCode(s.participant), sub: `${studyName(s.study)} · ${s.site}`,
        end: [h("small", {}, s.lastReply === "never" ? "No replies yet" : `Last reply ${s.lastReply}`)],
      }))))] : null,
      d.flagged.length ? [sectionHead(`Flagged for review · ${d.flagged.length}`), listCard(capped(d.flagged.map((f) => row({
        onclick: person(f.participant), lead: h("span", { class: "sev high" }), title: `${f.measure} ${f.value}`, sub: `${f.participant} · ${f.when}`,
      }))))] : null,
      d.corrections.length ? [sectionHead(`Corrections · ${d.corrections.length}`), listCard(capped(d.corrections.map((c) => row({
        onclick: person(c.participant), title: `${c.measure}: ${c.from} → ${c.to}`, sub: `${c.participant} · ${c.when}`, bold: false,
      }))))] : null,
      d.undelivered.length ? [sectionHead("Undelivered messages"), listCard(d.undelivered.map((u) => row({
        onclick: person(u.participant), title: shortCode(u.participant), sub: `${studyName(u.study)} · ${u.when}`, end: [tag(u.error.replace(/_/g, " "))],
      })))] : null,
      d.gaps.length ? [sectionHead("Device gaps"), listCard(d.gaps.map((g) => row({
        onclick: person(g.participant), title: `${g.measure}, ${g.days} days`, sub: `${g.participant} · last ${g.from}`, bold: false,
      })))] : null,
    ].filter(Boolean);
    return [
      header(params.study ? `Data quality · ${studyName(params.study)}` : "Data quality", d.headline, d.lede),
      h("div", { class: "filters" }, studyChips(params.study, (code) => swap({ study: code }))),
      sections,
      sections.length ? null : h("p", { class: "note" }, "Nothing to show yet."),
      bar(),
    ];
  },
};

// Analyses: heavy work on the cloud computer, started from chat. The same screen opens from an
// iMessage card and in the ops website's side panel (an iframe about 420px wide), so it stays one
// fluid column. While it runs: the four phases, a ticking timer, the machine, and the live log.

const ANALYSIS_STATUS = { running: "Running", done: "Done", failed: "Failed", cancelled: "Stopped" };
const PHASE_WORD = { starting: "Starting", installing: "Installing", loading: "Loading data", analyzing: "Analyzing", saving: "Saving", done: "Done", failed: "Failed", cancelled: "Stopped" };
const PHASE_TEXT = {
  starting: "Starting the computer.", installing: "Installing tools.", loading: "Loading the data.", analyzing: "Analyzing.",
  saving: "Saving the report.", done: "Done.", failed: "It didn't finish.", cancelled: "Stopped.",
};
const COMPUTER_STATE = { starting: "Starting", ready: "Ready", stopped: "Stopped", deleted: "Deleted", failed: "Failed" };
const STEP_STATE = { done: "done", active: "in progress", todo: "not started", failed: "failed" };
const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const FILE_KIND = { image: "Image", table: "Table", document: "Document", other: "File" };
/** 125 → "2:05"; 3725 → "1:02:05". */
const stopwatch = (seconds) => {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
};
/** 8 → "8 s"; 192 → "3 min 12 s"; 3900 → "1 h 5 min". */
const duration = (seconds) => {
  const s = Math.round(seconds ?? 0);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};

async function analysisList() {
  const { analyses } = await api("analyses");
  return [
    header("Analyses", analyses.length ? `${plural(analyses.length, "analysis", "analyses")}.` : "None yet.",
      "Bigger questions run on a cloud computer. Ask Trial Ops in Messages to start one."),
    analyses.length ? listCard(analyses.map((a) => row({
      onclick: () => go("analysis", { id: a.id }), title: a.title, sub: a.request,
      meta: [
        tag(a.status === "running" ? PHASE_WORD[a.phase] ?? "Running" : ANALYSIS_STATUS[a.status] ?? a.status, a.status === "running" ? "ink" : "muted"),
        a.status === "running" && a.elapsedSeconds !== undefined ? `${duration(a.elapsedSeconds)} so far` : a.finished ?? a.when,
        a.status !== "running" && a.elapsedSeconds ? `took ${duration(a.elapsedSeconds)}` : null,
      ],
    })).map((r) => { r.querySelector("small")?.classList.add("clamp"); return r; }), "No analyses yet.") : null,
    bar(),
  ];
}

/** The four phases: done (check), active (a calm pulse), to do, failed (!), or where it was stopped (–). */
function stepper(phases, stopped) {
  return h("ol", { class: "stepper", "aria-label": "Progress" }, phases.map((p) => {
    const state = stopped && p.state !== "done" && p.state !== "todo" ? "stopped" : p.state;
    return h("li", { class: `step ${state}`, "aria-current": state === "active" ? "step" : null },
      state === "done" ? h("span", { class: "dot", "aria-hidden": "true", html: icons.check }) : h("span", { class: "dot", "aria-hidden": "true" }, state === "failed" ? "!" : state === "stopped" ? "–" : null),
      h("span", { class: "label" }, p.label),
      h("span", { class: "sr-only" }, `, ${state === "stopped" ? "stopped here" : STEP_STATE[state] ?? state}`));
  }));
}

/** The log: phase rows as labels, steps with their purpose, time and exit code; tap a step for its output. */
function logList(log, open, rerender, live = false) {
  const items = [];
  const last = log.findLastIndex((e) => e.kind !== "phase");
  log.forEach((e, i) => {
    if (e.kind === "phase") {
      items.push(h("div", { class: "log-phase" }, h("span", {}, e.text), h("small", {}, e.when)));
      return;
    }
    const failed = e.exitCode !== undefined && e.exitCode !== null && e.exitCode !== 0;
    const now = live && i === last && (e.exitCode === undefined || e.exitCode === null);
    const expanded = open.has(i);
    const body = [
      h("span", { class: failed ? "fail-dot" : now ? "pulse small" : "ok-dot", role: failed || now ? "img" : null, "aria-label": failed ? `Failed, exit code ${e.exitCode}` : now ? "Running now" : null, "aria-hidden": failed || now ? null : "true" }),
      h("span", { class: "text" }, h("span", { class: "label" }, e.text), h("small", {}, [e.when, failed ? `Exit code ${e.exitCode}` : null].filter(Boolean).join(" · "))),
      e.seconds !== undefined && e.seconds !== null ? tag(duration(e.seconds)) : null,
      e.detail ? h("span", { class: `chevron${expanded ? " open" : ""}`, html: icons.chevron }) : null,
    ];
    items.push(e.detail
      ? h("button", { type: "button", class: "list-row log-step", "aria-expanded": String(expanded), onclick: () => { if (expanded) open.delete(i); else open.add(i); rerender(); } }, ...body)
      : h("div", { class: "list-row log-step" }, ...body));
    if (e.detail && expanded) items.push(h("pre", { class: "log-detail" }, e.detail));
  });
  return h("div", { class: "card list log" }, items.length ? items : h("p", { class: "empty" }, "Nothing has run yet."));
}

/** The analysis report: live while it runs (polled every 3 s, the timer ticking in between), then the result. */
async function analysisScreen(id, alive) {
  const ui = { open: new Set(), stopping: false, busy: false, message: "" };
  let a = await api(`analysis${qs({ id })}`);
  let fetchedAt = Date.now();
  if (!alive()) return;
  const elapsed = () => (a.elapsedSeconds ?? 0) + (a.status === "running" ? (Date.now() - fetchedAt) / 1000 : 0);

  const stop = async () => {
    ui.busy = true;
    paint();
    try {
      a = (await api("analysis/cancel", { id })).analysis;
      fetchedAt = Date.now();
      ui.message = "";
    } catch (e) {
      ui.message = e.message;
    }
    ui.busy = false;
    ui.stopping = false;
    if (alive()) paint();
  };
  const shutdown = async () => {
    ui.busy = true;
    paint();
    try {
      const r = await api("computer/shutdown", {});
      a = { ...a, computer: r.computer ?? a.computer };
      ui.message = "The computer is shut down.";
    } catch (e) {
      ui.message = e.message;
    }
    ui.busy = false;
    if (alive()) paint();
  };

  function dock() {
    if (a.status === "running" && a.canCancel) {
      return ui.stopping
        ? actionbar(button("Keep running", () => { ui.stopping = false; paint(); }, { class: "plain" }),
            button(ui.busy ? "Stopping…" : "Stop now", stop, { class: "grow ink", disabled: ui.busy }))
        : bar(button("Stop analysis", () => { ui.stopping = true; paint(); }, { class: "soft grow" }));
    }
    if (a.status !== "running" && a.computer?.status === "ready") {
      return bar(button(ui.busy ? "Shutting down…" : "Shut down computer", shutdown, { class: "soft grow", disabled: ui.busy }));
    }
    return bar();
  }

  function paint(first = false) {
    const running = a.status === "running";
    const paragraphs = (a.summary ?? "").split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
    const images = (a.files ?? []).filter((f) => f.kind === "image");
    const others = (a.files ?? []).filter((f) => f.kind !== "image");
    const c = a.computer;
    const machine = c ? [`${COMPUTER_STATE[c.status] ?? cap(c.status)}`, `${c.cpu} CPU`, `${c.memory} GB`, c.status === "ready" || c.status === "starting" ? `stops after ${c.idleStopMinutes ?? 30} idle minutes` : null].filter(Boolean).join(" · ") : null;
    const log = a.log ?? (a.progress ?? []).map((p) => ({ kind: "step", when: p.when, text: p.text }));
    const ended = a.status === "failed" || a.status === "cancelled";
    show({ quiet: !first },
      h("div", { class: "header" }, h("span", { class: "eyebrow" }, "Analysis"), h("h1", { class: "title compact" }, a.title)),
      h("p", { class: "quote request" }, a.request),
      h("div", { class: `card run${running ? " live" : ""}`, role: running ? "status" : null },
        h("div", { class: "run-head" },
          running ? h("span", { class: "pulse", "aria-hidden": "true" }) : null,
          h("b", {}, running ? PHASE_TEXT[a.phase] ?? "Working on it." : PHASE_TEXT[a.status === "done" ? "done" : a.status] ?? cap(a.status)),
          h("span", { class: "grow" }),
          running
            ? h("b", { class: "elapsed", "aria-label": `${duration(elapsed())} so far` }, stopwatch(elapsed()))
            : a.elapsedSeconds ? h("span", { class: "took" }, `Took ${duration(a.elapsedSeconds)}`) : null),
        a.phases?.length ? stepper(a.phases, a.status === "cancelled") : null,
        machine ? h("p", { class: "machine" }, h("span", { html: icons.gauge, style: "display:contents" }), `Cloud computer · ${machine}`) : null),
      ui.message ? h("p", { class: "note", role: "status" }, ui.message) : null,
      a.status === "failed" ? h("div", { class: "notice space" }, h("span", { html: icons.info, style: "display:contents" }),
        h("span", { class: "text" }, h("b", {}, "It didn't finish."), h("span", {}, a.error ?? "Something went wrong on the cloud computer."))) : null,
      a.status === "cancelled" ? h("div", { class: "notice space" }, h("span", { html: icons.info, style: "display:contents" }),
        h("span", { class: "text" }, h("b", {}, "Stopped before it finished."), h("span", {}, "Nothing more runs, and nothing was saved."))) : null,
      ended ? h("p", { class: "note" }, "Ask Trial Ops to rerun it.") : null,
      running ? [sectionHead("Live log"), logList(log, ui.open, () => paint(), true)] : null,
      paragraphs.length ? [sectionHead("Summary"), h("div", { class: "card prose" }, paragraphs.map((t) => h("p", {}, t)))] : null,
      a.findings?.length ? [sectionHead("Findings"), listCard(a.findings.map((t) => row({ lead: h("span", { class: "sev" }), title: t, bold: false, top: true })))] : null,
      images.map((f) => h("a", { class: "figure", href: f.url, target: "_blank", rel: "noopener", "aria-label": `Open ${f.name}` },
        h("img", { src: f.url, alt: f.name.replace(/[-_]/g, " ").replace(/\.\w+$/, ""), loading: "lazy" }))),
      others.length ? [sectionHead("Files"), listCard(others.map((f) => h("a", { class: "list-row", href: f.url, download: f.name },
        h("span", { class: "file-icon", html: icons.download }), h("span", { class: "text" }, h("span", { class: "label" }, f.name), h("small", {}, `${FILE_KIND[f.kind] ?? "File"} · ${size(f.size)}`)))))] : null,
      !running && log.length ? (() => {
        const how = h("details", { class: "how" }, h("summary", {}, ended ? "What ran" : "How it was done"), logList(log, ui.open, () => { paint(); }));
        if (ui.howOpen) how.open = true;
        how.addEventListener("toggle", () => { ui.howOpen = how.open; });
        return how;
      })() : null,
      dock());
  }

  paint(true);
  // The timer ticks every second between polls.
  const tick = setInterval(() => {
    if (!alive() || a.status !== "running") return clearInterval(tick);
    const el = app.querySelector(".run .elapsed");
    if (el) el.textContent = stopwatch(elapsed());
  }, 1000);
  while (a.status === "running") {
    await new Promise((r) => setTimeout(r, 3000));
    if (!alive()) return;
    if (ui.busy) continue;
    try {
      a = await api(`analysis${qs({ id })}`);
      fetchedAt = Date.now();
    } catch { continue; }
    if (!alive()) return;
    paint();
  }
}

function alertRow(a, { here } = {}) {
  return row({
    onclick: () => go("alert", { id: a.id }), top: true, lead: sev(a.severity),
    title: a.reason, bold: false,
    sub: here ? null : `${a.participant} · ${a.site}`,
    meta: [
      a.age === "today" ? a.when.replace(/^Today /, "") : a.age,
      a.assignee ? `${a.assignee}${a.assigneeRole ? `, ${ROLE[a.assigneeRole] ?? a.assigneeRole}` : ""}` : "Unassigned",
      a.status === "open" ? null : cap(a.status),
      a.fromSage ? sageChip() : null,
    ],
  });
}
function changeRow(c) {
  return row({
    onclick: c.link ? () => go(c.link.view, c.link.params) : undefined, top: true,
    lead: h("span", { class: `sev ${c.kind === "need" ? "high" : "low"}` }),
    title: c.text, bold: false, sub: c.where,
    meta: [h("b", {}, c.tag), c.when],
  });
}

// Decisions: confirm with Face ID, here or in Safari ---------------------------------------------

/** Face ID right in this page: a passkey with a platform authenticator (Safari on iPhone). */
async function faceIdHere() {
  const sw = window.SimpleWebAuthnBrowser;
  try {
    return Boolean(sw?.browserSupportsWebAuthn() && window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()));
  } catch {
    return false;
  }
}

function confirmScreen(a, alive) {
  const error = h("div", { class: "error", role: "alert" });
  const note = a.needsNote || a.kind === "decline_enrollment"
    ? h("textarea", { class: "field", rows: 4, placeholder: a.notePrompt ?? "Add a note.", "aria-label": a.notePrompt ?? "Note" }, a.note ?? "")
    : null;
  const waiting = h("div", { class: "hidden" });
  const confirm = h("button", { type: "button", class: "btn grow" }, h("span", { html: icons.faceidBold, style: "display:contents" }), "Confirm with Face ID");
  const cancel = button("Cancel", async () => {
    cancel.disabled = true;
    try { approvals.set(a.id, (await api("approval/cancel", { id: a.id })).approval); } catch { /* it may already be gone */ }
    if (stack.length) back(); else leave("approvals");
  }, { class: "plain" });
  const dockBar = actionbar(cancel, confirm);

  const finish = (approval) => {
    approvals.set(approval.id, approval);
    if (alive()) finishedScreen(approval);
  };
  const poll = async () => {
    const started = Date.now();
    while (alive() && Date.now() - started < 15 * 60_000) {
      await new Promise((r) => setTimeout(r, 2500));
      if (!alive()) return;
      const { approval } = await api(`approval${qs({ id: a.id })}`).catch(() => ({}));
      if (approval && ["done", "failed", "cancelled"].includes(approval.status)) return finish(approval);
    }
  };

  confirm.onclick = async () => {
    const text = note?.value.trim() || null;
    if ((a.needsNote || a.kind === "decline_enrollment") && !text) {
      error.textContent = "Add a note first.";
      note.focus();
      return;
    }
    confirm.disabled = true;
    error.textContent = "";
    try {
      if (await faceIdHere()) {
        const sw = window.SimpleWebAuthnBrowser;
        const { mode, options } = await api("approval/options", { id: a.id });
        const response = mode === "register" ? await sw.startRegistration({ optionsJSON: options }) : await sw.startAuthentication({ optionsJSON: options });
        return finish((await api("approval/verify", { id: a.id, response, note: text })).approval);
      }
      // Photon's iMessage view can't use passkeys: finish in Safari from the link we text.
      const { url } = await api("approval/handoff", { id: a.id, note: text });
      note?.setAttribute("readonly", "");
      waiting.replaceChildren(h("div", { class: "waiting" },
        h("b", {}, "Check Messages."),
        h("span", {}, "Open the link to confirm with Face ID in Safari. This page moves on by itself.")));
      waiting.classList.remove("hidden");
      confirm.replaceChildren("Open the link");
      confirm.onclick = () => window.open(url, "_blank");
      confirm.disabled = false;
      poll();
    } catch (e) {
      error.textContent = e?.name === "NotAllowedError" ? "Face ID was cancelled." : e?.message || String(e);
      confirm.disabled = false;
    }
  };

  show({ page: "white" },
    h("div", { class: "header" }, h("span", { class: "eyebrow" }, KIND[a.kind] ?? "Decision"), h("h1", { class: "title compact" }, a.title),
      a.preparedBy === "agent" ? h("p", { class: "lede" }, "Prepared in chat. Check it before you confirm.") : null),
    h("div", { class: "decision" },
      a.lines.length ? h("div", { class: "card list lines" }, a.lines.map((text) => row({ title: text, bold: false }))) : null,
      note ? [h("label", { class: "field-label" }, h("b", {}, a.kind === "decline_enrollment" ? "Why." : a.kind === "review_safety" ? "Your assessment." : "Note."),
        h("small", {}, "It goes on the record with your decision.")), note] : null,
      a.sageFollowUp ? h("p", { class: "follow-up" }, h("span", { html: icons.message, style: "display:contents" }), "Sage will let them know in Messages once it's done.") : null,
      waiting,
      error),
    dockBar);
}

function finishedScreen(a) {
  const done = a.status === "done";
  const cancelled = a.status === "cancelled";
  show({ page: "white" },
    result(done ? "good" : "warn", KIND[a.kind] ?? "Decision",
      done ? "Done." : cancelled ? "Cancelled." : "Couldn't finish.",
      done ? a.outcome ?? a.title : cancelled ? "Nothing changed." : a.error ?? "Nothing changed. Try again."),
    a.lines?.length && done ? h("div", { class: "card list lines space" }, a.lines.map((text) => row({ title: text, bold: false }))) : null,
    actionbar(
      stack.length && stack.at(-1).view !== "approvals" ? button("Back", back, { class: "plain" }) : null,
      button("Back to decisions", () => leave("approvals"), { class: "grow" })));
}

/** Leaves the decision screen for another, without keeping the decision in the back stack. */
function leave(view) {
  current = stack.at(-1)?.view === view ? stack.pop() : { view, params: {} };
  sync();
  render();
}

// Start -----------------------------------------------------------------------------------------

async function boot() {
  try {
    root = { ...root, ...(await api("")) };
  } catch (e) {
    show({ page: "white" }, result("warn", null, e.status === 410 ? "This link has expired." : "We couldn't open this.", e.status === 410 ? "Ask Trial Ops in Messages for a fresh one." : e.message));
    return;
  }
  root.studies ??= [];
  document.getElementById("brand").textContent = root.name || "Trial Ops";
  document.getElementById("study").textContent = root.manager?.name ?? "";
  const url = new URLSearchParams(location.search);
  const view = url.get("view");
  if (url.get("approval")) current = { view: "approval", params: { id: url.get("approval") } };
  else if (view && SCREENS[view]) {
    url.delete("view");
    current = { view, params: Object.fromEntries(url) };
  } else current = { view: SCREENS[root.view] ? root.view : "home", params: clean(root.params) };
  sync();
  render();
}

boot();
