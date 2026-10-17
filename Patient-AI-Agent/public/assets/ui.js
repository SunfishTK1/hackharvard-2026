// Reusable mini-app components (Web Components, light DOM so the page styles apply).
// Each input element exposes `.value` and fires a `change` event; none depend on the views.
//   <pa-progress value max>   <pa-options multiple>   <pa-yes-no>   <pa-number min max step unit>
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

export const icons = {
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>`,
  // Face ID glyph: corners, eyes, nose, smile.
  faceid: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 20V12a6 6 0 0 1 6-6h8M44 6h8a6 6 0 0 1 6 6v8M58 44v8a6 6 0 0 1-6 6h-8M20 58h-8a6 6 0 0 1-6-6v-8"/>
    <path d="M22 24v4M42 24v4M32 24v12h-3M24 44c4 4 12 4 16 0"/></svg>`,
};

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

/** Single or multiple choice from `options` [{value, label}]. */
class Options extends HTMLElement {
  #options = [];
  #value = [];
  set options(list) { this.#options = list ?? []; this.render(); }
  get value() { return this.hasAttribute("multiple") ? [...this.#value] : this.#value[0] ?? null; }
  set value(v) { this.#value = v === null || v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]; this.render(); }
  render() {
    const multi = this.hasAttribute("multiple");
    this.setAttribute("role", multi ? "group" : "radiogroup");
    this.replaceChildren(...this.#options.map((o) => h("button", {
      type: "button", class: "option", "data-multi": multi || null, "aria-pressed": String(this.#value.includes(o.value)),
      onclick: () => {
        this.#value = multi
          ? (this.#value.includes(o.value) ? this.#value.filter((v) => v !== o.value) : [...this.#value, o.value])
          : [o.value];
        this.render();
        fire(this);
      },
    }, h("span", { class: "mark" }), h("span", {}, o.label))));
  }
}

class YesNo extends HTMLElement {
  #value = null;
  connectedCallback() { this.render(); }
  get value() { return this.#value; }
  set value(v) { this.#value = typeof v === "boolean" ? v : null; this.render(); }
  render() {
    this.setAttribute("role", "radiogroup");
    const pick = (v) => () => { this.#value = v; this.render(); fire(this); };
    this.replaceChildren(
      h("button", { type: "button", class: "option", "aria-pressed": String(this.#value === true), onclick: pick(true) }, h("span", { class: "mark" }), "Yes"),
      h("button", { type: "button", class: "option", "aria-pressed": String(this.#value === false), onclick: pick(false) }, h("span", { class: "mark" }), "No"),
    );
  }
}

class NumberInput extends HTMLElement {
  connectedCallback() {
    if (this.input) return;
    const step = Number(this.getAttribute("step") || 1);
    this.input = h("input", { type: "text", inputmode: step % 1 ? "decimal" : "numeric", "aria-label": this.getAttribute("label") || "Number", oninput: () => fire(this) });
    const nudge = (dir) => () => {
      const min = this.getAttribute("min"), max = this.getAttribute("max");
      let n = (Number(this.input.value) || 0) + dir * step;
      if (min !== null) n = Math.max(Number(min), n);
      if (max !== null) n = Math.min(Number(max), n);
      this.input.value = String(Math.round(n * 10) / 10);
      fire(this);
    };
    const wrap = h("div", { class: "grow" }, this.input, this.getAttribute("unit") ? h("span", { class: "unit" }, this.getAttribute("unit")) : null);
    this.replaceChildren(h("button", { type: "button", class: "step", "aria-label": "Less", onclick: nudge(-1) }, "−"), wrap,
      h("button", { type: "button", class: "step", "aria-label": "More", onclick: nudge(1) }, "+"));
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
  }
  render() {
    const v = Number(this.range.value), max = Number(this.range.max);
    this.out.textContent = String(v);
    this.caption.textContent = this.labels[Math.min(this.labels.length - 1, Math.round((v / max) * (this.labels.length - 1)))];
  }
  get value() { return this.#touched ? Number(this.range.value) : null; }
}

/** Site, day and time picker. `data` = { sites, slots, timeZone, preferredSite }. Value: { siteId, start, label }. */
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
      parts.push(h("div", { class: "segmented", role: "tablist" }, sites.map((s) => h("button", {
        type: "button", "aria-pressed": String(s.id === this.#site), role: "tab",
        onclick: () => { this.#site = s.id; this.#value = null; this.render(); fire(this); },
      }, s.city || s.name))));
    }
    if (!days.length) {
      parts.push(h("p", { class: "muted" }, "No open times at this site in the next two weeks. Try another site, or text us and we'll find a time."));
    } else {
      parts.push(h("div", { class: "days" }, days.map((d) => {
        const sample = mine.find((s) => s.localDate === d);
        return h("button", { type: "button", class: "day", "aria-pressed": String(d === this.#day), onclick: () => { this.#day = d; this.#value = null; this.render(); fire(this); } },
          h("small", {}, fmt(sample, { weekday: "short" })), h("b", {}, fmt(sample, { day: "numeric" })), h("small", {}, fmt(sample, { month: "short" })));
      })));
      parts.push(h("div", { class: "times" }, mine.filter((s) => s.localDate === this.#day).map((s) => h("button", {
        type: "button", class: "time", "aria-pressed": String(this.#value?.start === s.start && this.#value?.siteId === s.siteId),
        onclick: () => {
          this.#value = { siteId: s.siteId, start: s.start, label: `${fmt(s, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${siteName(s.siteId)}` };
          this.render();
          fire(this);
        },
      }, fmt(s, { hour: "numeric", minute: "2-digit" })))));
    }
    this.replaceChildren(...parts);
  }
}

/**
 * Proves it's the person before a sensitive action. Uses a passkey (Face ID on iPhone) when the
 * browser supports one; otherwise, or if they prefer, they type their full name. Fires `verified`
 * with { verificationId, method }.
 */
class Verify extends HTMLElement {
  async connectedCallback() {
    if (this.ready) return;
    this.ready = true;
    const action = this.getAttribute("action");
    const label = this.getAttribute("label") || "Verify with Face ID";
    const error = h("div", { class: "error", role: "alert" });
    const sw = window.SimpleWebAuthnBrowser;
    let platform = false;
    try { platform = Boolean(sw?.browserSupportsWebAuthn() && (await sw.platformAuthenticatorIsAvailable())); } catch { platform = false; }

    const done = (result) => this.dispatchEvent(new CustomEvent("verified", { detail: result, bubbles: true }));
    const nameInput = h("input", { class: "text-input", type: "text", autocomplete: "name", placeholder: "First and last name", value: this.getAttribute("name") || "" });
    const typed = h("div", { class: "stack" },
      h("p", { class: "small muted" }, "Type your full name to confirm it's you. We'll record that you verified this way."),
      nameInput,
      h("button", { type: "button", class: "btn", onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        error.textContent = "";
        try { done({ ...(await api("verify", { action, method: "typed_name", name: nameInput.value })), method: "typed_name", name: nameInput.value.trim() }); }
        catch (e) { error.textContent = e.message; ev.currentTarget.disabled = false; }
      } }, "Confirm it's me"));

    const faceButton = h("button", { type: "button", class: "btn", onclick: async (ev) => {
      const button = ev.currentTarget;
      button.disabled = true;
      error.textContent = "";
      try {
        const { mode, options } = await api("verify-options", { action });
        const response = mode === "register" ? await sw.startRegistration({ optionsJSON: options }) : await sw.startAuthentication({ optionsJSON: options });
        done({ ...(await api("verify", { action, method: "passkey", response })), method: "passkey" });
      } catch (e) {
        error.textContent = e.name === "NotAllowedError" ? "Face ID was cancelled or isn't allowed here. Try again, or type your name instead." : e.message;
        button.disabled = false;
        typedWrap.classList.remove("hidden");
      }
    } }, h("span", { class: "icon", html: icons.faceid }), label);

    const typedWrap = h("div", { class: platform ? "hidden" : "" }, typed);
    this.replaceChildren(
      platform ? h("div", { class: "stack center" }, h("span", { class: "faceid", html: icons.faceid }),
        h("p", { class: "small muted" }, "Face ID confirms it's really you. Your face never leaves your phone."), faceButton,
        h("button", { type: "button", class: "btn ghost", onclick: () => typedWrap.classList.toggle("hidden") }, "Can't use Face ID?")) : null,
      !platform ? h("div", { class: "notice" }, h("span", {}, "Face ID isn't available in this view, so you'll confirm by typing your name.")) : null,
      typedWrap,
      error,
    );
  }
}

customElements.define("pa-progress", Progress);
customElements.define("pa-options", Options);
customElements.define("pa-yes-no", YesNo);
customElements.define("pa-number", NumberInput);
customElements.define("pa-scale", Scale);
customElements.define("pa-slots", Slots);
customElements.define("pa-verify", Verify);
