// Reusable mini-app components (Web Components, light DOM so the page styles apply), plus the glass
// action bar and its options menu. Each input element exposes `.value` and fires `change`.
//   <pa-progress value max>   <pa-options multiple>   <pa-yes-no compact>   <pa-number min max step unit>
//   <pa-scale min max>        <pa-slots>              <pa-verify action>

/** Tiny DOM builder: h("div", { class: "card", onclick }, "text", child). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "html") el.innerHTML = value;
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child.nodeType ? child : String(child));
  return el;
}

const line = (body, width = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const icons = {
  check: line(`<path d="M5 12.5l4.5 4.5L19 7.5"/>`, 2.6),
  info: line(`<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>`, 2),
  clock: line(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`, 2),
  calendar: line(`<rect x="3.5" y="5" width="17" height="15.5" rx="3.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>`),
  pulse: line(`<path d="M3 12h4l2.5-5 5 10 2.5-5h4"/>`),
  phone: line(`<path d="M6.6 3.5h2.6l1.7 4.4-2.1 1.4a11.5 11.5 0 0 0 5.9 5.9l1.4-2.1 4.4 1.7v2.6a2.1 2.1 0 0 1-2.2 2.1A16.6 16.6 0 0 1 4.5 5.7a2.1 2.1 0 0 1 2.1-2.2z"/>`),
  pause: line(`<rect x="6.5" y="5" width="3.5" height="14" rx="1.2"/><rect x="14" y="5" width="3.5" height="14" rx="1.2"/>`),
  heart: line(`<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>`),
  home: line(`<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15V15H9v5.5H5.5A1.5 1.5 0 0 1 4 19z"/>`),
  minus: line(`<path d="M5 12h14"/>`, 2.4),
  plus: line(`<path d="M12 5v14M5 12h14"/>`, 2.4),
  more: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>`,
  mic: line(`<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>`, 2),
  micOff: line(`<path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16"/>`, 2),
  repeat: line(`<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4"/>`),
  buttons: line(`<rect x="3.5" y="4" width="17" height="6" rx="3"/><rect x="3.5" y="14" width="17" height="6" rx="3"/>`),
  close: line(`<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>`),
  chevron: line(`<path d="M9 5l7 7-7 7"/>`, 2.2),
  document: line(`<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5M10 13h5.5M10 16.5h5.5"/>`),
  // Face ID glyph: corners, eyes, nose, smile.
  faceid: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 20V12a4 4 0 0 1 4-4h8M44 8h8a4 4 0 0 1 4 4v8M56 44v8a4 4 0 0 1-4 4h-8M20 56h-8a4 4 0 0 1-4-4v-8M24 24v4M40 24v4M32 26v10h-3M24 42c4 4 12 4 16 0"/></svg>`,
  faceidBold: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 20V12a4 4 0 0 1 4-4h8M44 8h8a4 4 0 0 1 4 4v8M56 44v8a4 4 0 0 1-4 4h-8M20 56h-8a4 4 0 0 1-4-4v-8M24 24v4M40 24v4M32 26v10h-3M24 42c4 4 12 4 16 0"/></svg>`,
};
export const icon = (name) => h("span", { html: icons[name], style: "display:contents" });

/** JSON API for the current form. Throws Error with `.status` and server fields on failure. */
export async function api(path, body) {
  const token = location.pathname.split("/")[2];
  const res = await fetch(`/api/f/${token}${path ? `/${path}` : ""}`, body === undefined
    ? { headers: { accept: "application/json" } }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), data, { status: res.status });
  return data;
}

// The glass action bar ---------------------------------------------------------------------------

/** A floating glass bar: actionbar(button, button). Pass { column: true } first to stack them. */
export function actionbar(...items) {
  const opts = items[0] && !items[0].nodeType && !Array.isArray(items[0]) && typeof items[0] === "object" ? items.shift() : {};
  const inner = h("div", { class: `inner glass${opts.column ? " column" : ""}` }, ...items);
  return h("div", { class: "actionbar" }, h("div", { class: "dock" }, inner));
}
export const button = (label, onclick, extra = {}) => h("button", { type: "button", class: `btn ${extra.class ?? ""}`, onclick, disabled: extra.disabled, "aria-label": extra.label }, label);
export const roundButton = (name, label, onclick) => h("button", { type: "button", class: "btn round", "aria-label": label, onclick, html: icons[name] });

/**
 * An options menu in glass, opened by `trigger` (a button in an action bar). `items` (or a function
 * returning them, read each time it opens) are { icon, label, onclick } | { icon, label, href } |
 * "-" (a group break). Springs open from the trigger's corner; closes on a pick, a tap outside, or
 * Escape.
 */
export function optionsMenu(trigger, items, { align = "right", label = "More options" } = {}) {
  let menu = null;
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const close = () => {
    if (!menu) return;
    menu.remove();
    menu = null;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keys, true);
  };
  const outside = (ev) => { if (menu && !menu.contains(ev.target) && !trigger.contains(ev.target)) close(); };
  const keys = (ev) => {
    if (!menu) return;
    const list = [...menu.querySelectorAll(".menu-item")];
    const at = list.indexOf(document.activeElement);
    if (ev.key === "Escape") { close(); trigger.focus(); }
    else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); list[(at + (ev.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus(); }
  };
  const open = (viaKeyboard) => {
    const dock = trigger.closest(".dock");
    menu = h("div", { class: `menu glass${align === "left" ? " left" : ""}`, role: "menu", "aria-label": label },
      (typeof items === "function" ? items() : items).filter(Boolean).map((item) => {
        if (item === "-") return h("div", { class: "menu-sep", "aria-hidden": "true" });
        const body = [h("span", { html: icons[item.icon], style: "display:contents" }), item.label];
        const pick = (ev) => { close(); item.onclick?.(ev); };
        return item.href
          ? h("a", { class: "menu-item", role: "menuitem", href: item.href, target: item.target, onclick: pick }, ...body)
          : h("button", { type: "button", class: "menu-item", role: "menuitem", onclick: pick }, ...body);
      }));
    dock.prepend(menu);
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keys, true);
    if (viaKeyboard) menu.querySelector(".menu-item")?.focus();
  };
  trigger.addEventListener("click", (ev) => (menu ? close() : open(ev.detail === 0)));
  return { close, get open() { return Boolean(menu); } };
}

// Inputs -----------------------------------------------------------------------------------------

const fire = (el) => el.dispatchEvent(new Event("change", { bubbles: true }));

class Progress extends HTMLElement {
  static observedAttributes = ["value", "max"];
  connectedCallback() { this.render(); }
  attributeChangedCallback() { this.render(); }
  render() {
    const max = Number(this.getAttribute("max") || 1), value = Number(this.getAttribute("value") || 0);
    this.setAttribute("role", "progressbar");
    this.setAttribute("aria-valuemin", "0");
    this.setAttribute("aria-valuemax", String(max));
    this.setAttribute("aria-valuenow", String(value));
    if (!this.bar) this.append((this.bar = h("div", { class: "bar" })));
    this.bar.style.width = `${Math.min(100, (value / max) * 100)}%`;
  }
}

/** Single or multiple choice from `options` [{value, label, hint?}]: rows, the mark on the right. */
class Options extends HTMLElement {
  #options = [];
  #value = [];
  set options(list) { this.#options = list ?? []; this.render(); }
  get value() { return this.hasAttribute("multiple") ? [...this.#value] : this.#value[0] ?? null; }
  set value(v) { this.#value = v === null || v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]; this.render(); }
  render() {
    const multi = this.hasAttribute("multiple");
    this.setAttribute("role", "group");
    this.replaceChildren(...this.#options.map((o) => h("button", {
      type: "button", class: "option", "data-multi": multi || null, "aria-pressed": String(this.#value.includes(o.value)),
      onclick: () => {
        this.#value = multi
          ? (this.#value.includes(o.value) ? this.#value.filter((v) => v !== o.value) : [...this.#value, o.value])
          : [o.value];
        this.render();
        fire(this);
      },
    }, o.hint ? h("span", { class: "text" }, h("b", {}, o.label), h("small", {}, o.hint)) : h("span", {}, o.label), h("span", { class: "mark", "aria-hidden": "true" }))));
  }
}

/** Yes or No: two rows like any choice, or (compact) two pills side by side. */
class YesNo extends HTMLElement {
  #value = null;
  connectedCallback() { this.render(); }
  get value() { return this.#value; }
  set value(v) { this.#value = typeof v === "boolean" ? v : null; this.render(); }
  render() {
    this.setAttribute("role", "group");
    const compact = this.hasAttribute("compact");
    const pick = (v) => () => { this.#value = v; this.render(); fire(this); };
    const choice = (v, label) => compact
      ? h("button", { type: "button", class: "pill-choice", "aria-pressed": String(this.#value === v), onclick: pick(v) }, label)
      : h("button", { type: "button", class: "option", "aria-pressed": String(this.#value === v), onclick: pick(v) }, h("span", {}, label), h("span", { class: "mark", "aria-hidden": "true" }));
    this.replaceChildren(choice(true, "Yes"), choice(false, "No"));
  }
}

/** A number between round minus and plus buttons; the value can also be typed. */
class NumberInput extends HTMLElement {
  connectedCallback() {
    if (this.input) return;
    const step = Number(this.getAttribute("step") || 1);
    const label = this.getAttribute("label") || "Number";
    this.input = h("input", { type: "text", inputmode: step % 1 ? "decimal" : "numeric", "aria-label": label, placeholder: this.getAttribute("placeholder") || "–", oninput: () => fire(this) });
    const nudge = (dir) => () => {
      const min = this.getAttribute("min"), max = this.getAttribute("max");
      const start = this.input.value.trim() === "" ? Number(this.getAttribute("start") ?? min ?? 0) - dir * step : Number(this.input.value) || 0;
      let n = start + dir * step;
      if (min !== null) n = Math.max(Number(min), n);
      if (max !== null) n = Math.min(Number(max), n);
      this.input.value = String(Math.round(n * 10) / 10);
      fire(this);
    };
    const short = label.toLowerCase();
    const unit = this.hasAttribute("bare") ? null : this.getAttribute("unit");
    this.replaceChildren(
      h("button", { type: "button", class: "step", "aria-label": `Lower ${short}`, onclick: nudge(-1), html: icons.minus }),
      unit ? h("div", { class: "grow" }, this.input, h("span", { class: "unit" }, unit)) : this.input,
      h("button", { type: "button", class: "step", "aria-label": `Raise ${short}`, onclick: nudge(1), html: icons.plus }));
    if (this.pending !== undefined) this.input.value = this.pending;
  }
  get value() { const v = this.input?.value.trim(); return v ? Number(v) : null; }
  set value(v) { if (this.input) this.input.value = v ?? ""; else this.pending = v ?? ""; }
}

/** 0-10 style slider with a big number and a plain-language label. */
class Scale extends HTMLElement {
  #touched = false;
  connectedCallback() {
    if (this.range) return;
    const min = Number(this.getAttribute("min") ?? 0), max = Number(this.getAttribute("max") ?? 10);
    this.labels = (this.getAttribute("labels") || "None,Mild,Moderate,Severe,Worst imaginable").split(",");
    this.out = h("div", { class: "value" }, "–");
    this.caption = h("div", { class: "label" }, "Slide to answer");
    this.range = h("input", { type: "range", min, max, step: 1, value: Math.round((min + max) / 2), "aria-label": this.getAttribute("label") || "Rating",
      oninput: () => { this.#touched = true; this.render(); fire(this); } });
    this.replaceChildren(this.out, this.caption, this.range, h("div", { class: "ends" }, h("span", {}, `${min} · ${this.labels[0]}`), h("span", {}, `${max} · ${this.labels.at(-1)}`)));
    if (this.pending !== undefined) this.value = this.pending;
  }
  render() {
    const v = Number(this.range.value), max = Number(this.range.max);
    this.out.textContent = String(v);
    this.caption.textContent = this.labels[Math.min(this.labels.length - 1, Math.round((v / max) * (this.labels.length - 1)))];
  }
  get value() { return this.#touched ? Number(this.range.value) : null; }
  set value(v) {
    if (v === null || v === undefined) return;
    if (!this.range) { this.pending = v; return; }
    this.range.value = String(v);
    this.#touched = true;
    this.render();
  }
}

/** Site, day and time picker. `data` = { sites, slots, timeZone, preferredSite }. Value: { siteId, start, label, when, where }. */
class Slots extends HTMLElement {
  #data = { sites: [], slots: [], timeZone: "UTC" };
  #site = null;
  #day = null;
  #value = null;
  set data(d) {
    this.#data = d;
    const preferred = d.sites.find((s) => s.code === d.preferredSite && d.slots.some((x) => x.siteId === s.id));
    this.#site = preferred?.id ?? d.sites.find((s) => d.slots.some((x) => x.siteId === s.id))?.id ?? null;
    this.#day = null;
    this.render();
  }
  get value() { return this.#value; }
  render() {
    const { sites, slots, timeZone } = this.#data;
    const mine = slots.filter((s) => s.siteId === this.#site);
    const days = [...new Set(mine.map((s) => s.localDate))];
    if (!days.includes(this.#day)) this.#day = days[0] ?? null;
    // Each slot is shown in its site's time zone.
    const fmt = (slot, opts) => new Intl.DateTimeFormat("en-US", { timeZone: slot.timeZone ?? timeZone, ...opts }).format(new Date(slot.start));
    const siteName = (id) => sites.find((s) => s.id === id)?.city || sites.find((s) => s.id === id)?.name;
    const parts = [];
    if (sites.length > 1) {
      parts.push(h("div", { class: "segmented", role: "group", "aria-label": "Location" }, sites.map((s) => h("button", {
        type: "button", "aria-pressed": String(s.id === this.#site),
        onclick: () => { this.#site = s.id; this.#value = null; this.render(); fire(this); },
      }, s.city || s.name))));
    }
    if (!days.length) {
      parts.push(h("p", { class: "lede" }, "No open times at this site in the next two weeks. Try another site, or text us and we'll find a time."));
    } else {
      const picked = mine.find((s) => s.localDate === this.#day);
      parts.push(h("h2", { class: "month" }, fmt(picked, { month: "long" })));
      parts.push(h("div", { class: "days", role: "group", "aria-label": "Day" }, days.map((d) => {
        const sample = mine.find((s) => s.localDate === d);
        return h("button", { type: "button", class: "day", "aria-pressed": String(d === this.#day), "aria-label": fmt(sample, { weekday: "long", month: "long", day: "numeric" }),
          onclick: () => { this.#day = d; this.#value = null; this.render(); fire(this); } },
        h("small", {}, fmt(sample, { weekday: "short" })), h("b", {}, fmt(sample, { day: "numeric" })));
      })));
      parts.push(h("div", { class: "times", role: "group", "aria-label": "Time" }, mine.filter((s) => s.localDate === this.#day).map((s) => h("button", {
        type: "button", class: "time", "aria-pressed": String(this.#value?.start === s.start && this.#value?.siteId === s.siteId),
        onclick: () => {
          this.#value = {
            siteId: s.siteId, start: s.start,
            label: `${fmt(s, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${siteName(s.siteId)}`,
            when: `${fmt(s, { weekday: "short", month: "short", day: "numeric" })} · ${fmt(s, { hour: "numeric", minute: "2-digit" })}`,
            where: siteName(s.siteId),
          };
          this.render();
          fire(this);
        },
      }, fmt(s, { hour: "numeric", minute: "2-digit" })))));
    }
    this.replaceChildren(...parts);
  }
}

/**
 * Identity check before a sensitive action, laid out as one screen: the Face ID glyph, the
 * eyebrow/title/lede attributes, then status. Its primary button is `.button`, which the view puts
 * in the glass action bar. Emits "verified" { verificationId, method } when the page verified, or
 * "completed" { ...result } when Safari finished the action (handoff).
 * - In the Sage app: native Face ID (window.webkit.messageHandlers.sageNative).
 * - In a browser with passkeys: Face ID through WebAuthn, right here.
 * - In Photon's iMessage view (no passkeys): set `handoff` (starts the action, returns { url })
 *   and `poll` (resolves { done, result }); Face ID then happens in Safari.
 * Typing a full name is always available as the fallback.
 */
class Verify extends HTMLElement {
  button = h("button", { type: "button", class: "btn grow", disabled: true }, h("span", { html: icons.faceidBold, style: "display:contents" }), "Face ID");
  async connectedCallback() {
    if (this.ready) return;
    this.ready = true;
    const action = this.getAttribute("action");
    const label = this.getAttribute("label") || "Verify with Face ID";
    const error = h("div", { class: "error", role: "alert" });
    const sw = window.SimpleWebAuthnBrowser;
    const native = window.webkit?.messageHandlers?.sageNative;
    let inPage = Boolean(native);
    if (!inPage) {
      try { inPage = Boolean(sw?.browserSupportsWebAuthn() && (await sw.platformAuthenticatorIsAvailable())); } catch { inPage = false; }
    }
    const viaSafari = !inPage && typeof this.handoff === "function";
    const faceId = inPage || viaSafari;

    const verified = (result) => this.dispatchEvent(new CustomEvent("verified", { detail: result, bubbles: true }));
    const completed = (result) => this.dispatchEvent(new CustomEvent("completed", { detail: result, bubbles: true }));
    const setButton = (content, onclick) => {
      this.button.replaceChildren(...content);
      this.button.onclick = onclick;
      this.button.disabled = false;
    };

    const nameInput = h("input", { class: "field pill", type: "text", autocomplete: "name", placeholder: "First and last name", "aria-label": "Your full name", value: this.getAttribute("name") || "" });
    const typed = async () => {
      this.button.disabled = true;
      error.textContent = "";
      try { verified({ ...(await api("verify", { action, method: "typed_name", name: nameInput.value })), method: "typed_name", name: nameInput.value.trim() }); }
      catch (e) { error.textContent = e.message; this.button.disabled = false; }
    };
    const typedWrap = h("div", { class: "hidden", style: "margin-top: 28px; text-align: left" },
      h("p", { class: "small muted", style: "margin: 0 4px 10px" }, "Type your full name to confirm it's you. We'll record that you verified this way."),
      nameInput,
      faceId ? h("button", { type: "button", class: "btn soft", style: "width: 100%; margin-top: 10px", onclick: typed }, "Confirm it's me") : null);
    const useTyped = () => {
      typedWrap.classList.remove("hidden");
      nameInput.focus();
    };

    const face = async () => {
      this.button.disabled = true;
      error.textContent = "";
      try {
        if (viaSafari) return await safari();
        if (native) {
          const { challenge, keyTag } = await api("device-challenge", { action });
          const proof = await native.postMessage({ type: "faceid", challenge, keyTag, reason: label });
          verified({ ...(await api("verify", { action, method: "device_key", challenge, ...proof })), method: "passkey" });
        } else {
          const { mode, options } = await api("verify-options", { action });
          const response = mode === "register" ? await sw.startRegistration({ optionsJSON: options }) : await sw.startAuthentication({ optionsJSON: options });
          verified({ ...(await api("verify", { action, method: "passkey", response })), method: "passkey" });
        }
      } catch (e) {
        error.textContent = e?.name === "NotAllowedError" ? "Face ID was cancelled or isn't allowed here. Try again, or type your name instead." : (e?.message || String(e));
        this.button.disabled = false;
      }
    };

    // Face ID in Safari: open the one-time link, then wait here until Safari finishes the action.
    const waiting = h("div", { class: "hidden" });
    const safari = async () => {
      const { url } = await this.handoff();
      window.open(url, "_blank");
      cantUse.classList.add("hidden");
      waiting.replaceChildren(
        h("div", { class: "waiting" }, h("b", {}, "Finish in Safari."), h("span", {}, "Confirm with Face ID there, then come back. This page moves on by itself.")),
        h("p", { class: "small muted center", style: "margin-top: 16px" }, "Didn't open? We also texted you the link. Close this card and tap it."));
      waiting.classList.remove("hidden");
      setButton(["Open Safari again"], () => window.open(url, "_blank"));
      const started = Date.now();
      while (this.isConnected && Date.now() - started < 15 * 60_000) {
        await new Promise((r) => setTimeout(r, 2000));
        const status = await this.poll().catch(() => undefined);
        if (status?.done) return completed(status.result);
      }
    };

    const cantUse = h("button", { type: "button", class: "btn link", onclick: useTyped }, "Can't use Face ID?");
    const eyebrow = this.getAttribute("eyebrow"), title = this.getAttribute("heading"), lede = this.getAttribute("lede");
    this.replaceChildren(
      h("div", { class: "verify-head" },
        h("span", { class: "faceid", html: icons.faceid, role: "img", "aria-label": "Face ID" }),
        eyebrow ? h("span", { class: "eyebrow" }, eyebrow) : null,
        title ? h("h1", { class: "title" }, title) : null,
        h("p", { class: "lede" }, faceId
          ? lede ?? (viaSafari ? "Face ID confirms it's really you. It opens in Safari for a moment. Your face never leaves your phone." : "Face ID confirms it's really you. Your face never leaves your phone.")
          : "Face ID isn't available here, so confirm by typing your full name."),
        faceId ? h("div", { style: "margin-top: 20px" }, cantUse) : null),
      waiting, typedWrap, error);
    if (faceId) setButton([h("span", { html: icons.faceidBold, style: "display:contents" }), label], face);
    else {
      typedWrap.classList.remove("hidden");
      setButton(["Confirm it's me"], typed);
    }
  }
}

customElements.define("pa-progress", Progress);
customElements.define("pa-options", Options);
customElements.define("pa-yes-no", YesNo);
customElements.define("pa-number", NumberInput);
customElements.define("pa-scale", Scale);
customElements.define("pa-slots", Slots);
customElements.define("pa-verify", Verify);
