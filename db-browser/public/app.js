// DB Browser: sidebar of tables, a paged/sorted/searchable grid, and a row drawer that follows
// foreign keys both ways. State lives in the URL hash: #/<schema>/<table>?page=&size=&sort=&dir=&q=&f.<col>=
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : String(c));
  return node;
};
const api = async (path) => {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

let tables = [];
let current;

const href = (schema, table, params = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  return `#/${encodeURIComponent(schema)}/${encodeURIComponent(table)}${qs.size ? `?${qs}` : ""}`;
};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const plain = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));

function cell(value, { full = false } = {}) {
  if (value === null || value === undefined) return el("span", { class: "null" }, "null");
  if (typeof value === "boolean") return el("span", { class: value ? "bool-true" : "bool-false" }, value ? "✓ true" : "false");
  if (typeof value === "object") return full ? el("pre", {}, JSON.stringify(value, null, 2)) : el("span", { class: "mono" }, JSON.stringify(value));
  if (typeof value === "string" && ISO.test(value)) {
    const d = new Date(value);
    return el("span", { title: value }, Number.isNaN(d.getTime()) ? value : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }));
  }
  const text = String(value);
  return el("span", { class: /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(text) || text.startsWith("\\x") ? "mono" : undefined, title: full ? undefined : text }, text);
}

// Sidebar ------------------------------------------------------------------------------------------

function renderTables() {
  const q = $("filter").value.trim().toLowerCase();
  const nav = $("tables");
  nav.replaceChildren();
  let schema;
  for (const t of tables) {
    if (q && !`${t.schema}.${t.name}`.toLowerCase().includes(q)) continue;
    if (t.schema !== schema) {
      schema = t.schema;
      nav.append(el("div", { class: "schema" }, schema));
    }
    const active = current && current.schema === t.schema && current.table === t.name;
    nav.append(el("a", { class: `table-link${active ? " active" : ""}`, href: href(t.schema, t.name), title: t.comment || undefined },
      el("span", {}, t.name, t.kind !== "table" ? el("span", { class: "view" }, t.kind === "view" ? "view" : "mat") : null),
      el("span", { class: "count" }, t.count === null ? "–" : t.count.toLocaleString())));
  }
}

// Grid ---------------------------------------------------------------------------------------------

async function route() {
  const match = location.hash.match(/^#\/([^/?]+)\/([^/?]+)(?:\?(.*))?$/);
  closeDrawer();
  if (!match) {
    current = undefined;
    renderTables();
    $("main").replaceChildren(el("div", { class: "empty" }, "Pick a table on the left."));
    return;
  }
  const [schema, table] = [decodeURIComponent(match[1]), decodeURIComponent(match[2])];
  const params = new URLSearchParams(match[3] ?? "");
  current = { schema, table, params };
  renderTables();
  try {
    const data = await api(`/api/rows/${encodeURIComponent(schema)}/${encodeURIComponent(table)}?${params}`);
    if (current?.schema !== schema || current?.table !== table) return;
    renderGrid(data, params);
  } catch (error) {
    $("main").replaceChildren(el("div", { class: "error-box" }, error.message));
  }
}

function renderGrid(data, params) {
  const go = (changes) => {
    const next = Object.fromEntries(params);
    Object.assign(next, changes);
    location.hash = href(data.schema, data.table, next);
  };
  const filters = [...params].filter(([k]) => k.startsWith("f."));
  const sort = params.get("sort");
  const dir = params.get("dir") === "desc" ? "desc" : "asc";
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  const first = data.total ? data.page * data.size + 1 : 0;
  const last = Math.min(data.total, (data.page + 1) * data.size);

  // Single-column foreign keys link straight from the cell; composite ones from their last column.
  const fkByColumn = new Map(data.foreignKeys.map((fk) => [fk.columns.at(-1), fk]));
  const fkLink = (fk, row) => href(fk.refSchema, fk.refTable, Object.fromEntries(fk.refColumns.map((c, i) => [`f.${c}`, plain(row[fk.columns[i]])])));

  const search = el("input", { type: "search", placeholder: "Search every column…", value: params.get("q") ?? "" });
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") go({ q: search.value.trim(), page: 0 }); });

  const head = el("tr", {}, data.columns.map((c) => el("th", {
    title: c.comment || undefined,
    onclick: () => go({ sort: c.name, dir: sort === c.name && dir === "asc" ? "desc" : "asc", page: 0 }),
  }, c.name, c.pk ? el("span", { class: "key" }, "PK") : null, fkByColumn.has(c.name) ? el("span", { class: "key" }, "FK") : null,
    sort === c.name ? (dir === "asc" ? " ▲" : " ▼") : "", el("span", { class: "type" }, c.type))));

  const body = el("tbody", {}, data.rows.map((row) => {
    const tr = el("tr", {}, data.columns.map((c) => {
      const value = row[c.name];
      const fk = fkByColumn.get(c.name);
      const content = fk && value !== null ? el("a", { href: fkLink(fk, row), onclick: (e) => e.stopPropagation() }, cell(value)) : cell(value);
      return el("td", { class: typeof value === "number" ? "num" : undefined }, content);
    }));
    tr.addEventListener("click", () => {
      for (const other of body.querySelectorAll("tr.selected")) other.classList.remove("selected");
      tr.classList.add("selected");
      openDrawer(data, row, fkLink);
    });
    return tr;
  }));

  $("main").replaceChildren(
    el("div", { class: "head" },
      el("h1", {}, el("span", { class: "schema-name" }, `${data.schema}.`), data.table),
      data.comment ? el("div", { class: "comment" }, data.comment) : null),
    el("div", { class: "toolbar" },
      search,
      el("select", { onchange: (e) => go({ size: e.target.value, page: 0 }) },
        [25, 50, 100, 250].map((n) => el("option", { value: n, selected: n === data.size }, `${n} rows`))),
      el("button", { disabled: data.page === 0, onclick: () => go({ page: data.page - 1 }) }, "‹ Prev"),
      el("button", { disabled: data.page + 1 >= pages, onclick: () => go({ page: data.page + 1 }) }, "Next ›"),
      el("span", { class: "info" }, `${first.toLocaleString()}–${last.toLocaleString()} of ${data.total.toLocaleString()} · page ${data.page + 1} of ${pages}`)),
    filters.length || params.get("q") ? el("div", { class: "filters" },
      filters.map(([k, v]) => el("span", { class: "pill" }, `${k.slice(2)} = ${v}`,
        el("button", { "aria-label": "Remove filter", onclick: () => { const next = Object.fromEntries(params); delete next[k]; next.page = 0; location.hash = href(data.schema, data.table, next); } }, "×"))),
      params.get("q") ? el("span", { class: "pill" }, `matches “${params.get("q")}”`, el("button", { "aria-label": "Clear search", onclick: () => go({ q: "", page: 0 }) }, "×")) : null) : null,
    el("div", { class: "grid-wrap" }, el("table", {}, el("thead", {}, head), body),
      data.rows.length ? null : el("div", { class: "empty", style: "padding: 40px; text-align: center" }, "No rows.")));
}

// Row drawer --------------------------------------------------------------------------------------

function openDrawer(data, row, fkLink) {
  const drawer = $("drawer");
  const pk = data.columns.filter((c) => c.pk).map((c) => `${c.name} ${plain(row[c.name])}`).join(", ");
  drawer.replaceChildren(
    el("header", {}, el("h2", {}, `${data.table}${pk ? ` · ${pk.length > 40 ? `${pk.slice(0, 40)}…` : pk}` : ""}`),
      el("button", { "aria-label": "Close", onclick: closeDrawer }, "×")),
    data.foreignKeys.length ? el("div", { class: "section links" }, el("h3", {}, "Points to"),
      data.foreignKeys.filter((fk) => fk.columns.every((c) => row[c] !== null)).map((fk) =>
        el("a", { href: fkLink(fk, row) }, `${fk.refSchema}.${fk.refTable}`, el("span", { class: "null" }, ` (${fk.columns.join(", ")})`)))) : null,
    data.referencedBy.length ? el("div", { class: "section links" }, el("h3", {}, "Referenced by"),
      data.referencedBy.map((fk) => el("a", { href: href(fk.srcSchema, fk.srcTable, Object.fromEntries(fk.columns.map((c, i) => [`f.${c}`, plain(row[fk.refColumns[i]])]))) },
        `${fk.srcSchema}.${fk.srcTable}`, el("span", { class: "null" }, ` (${fk.columns.join(", ")})`)))) : null,
    el("div", { class: "section" }, el("h3", {}, "Fields"),
      data.columns.map((c) => el("div", { class: "field" },
        el("div", { class: "name" }, c.name, el("small", {}, c.type)),
        el("div", { class: "value" }, cell(row[c.name], { full: true }))))),
  );
  drawer.hidden = false;
}

function closeDrawer() {
  $("drawer").hidden = true;
}

// Boot ---------------------------------------------------------------------------------------------

$("filter").addEventListener("input", renderTables);
window.addEventListener("hashchange", route);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

try {
  const meta = await api("/api/meta");
  $("meta").textContent = `${meta.database} · read-only${meta.masked ? " · contact details hidden" : ""}`;
  tables = await api("/api/tables");
  renderTables();
  if (!location.hash) {
    const first = tables.find((t) => t.schema === "public" && t.name === "studies") ?? tables[0];
    if (first) location.hash = href(first.schema, first.name);
  }
  route();
} catch (error) {
  $("meta").textContent = "Not connected";
  $("main").replaceChildren(el("div", { class: "error-box" }, `Couldn't reach the database: ${error.message}. Is the SSH tunnel open (ssh -N -L 15432:localhost:5432 root@<server>)?`));
}
