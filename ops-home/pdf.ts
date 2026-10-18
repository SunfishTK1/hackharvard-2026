// Reads the text of a PDF with its positions, so tables can be put back together (setup.ts).
// No dependencies: it handles Flate/ASCII85 streams, object streams, and ToUnicode font maps,
// which covers ReportLab, Word and most exported documents. Scanned PDFs have no text to read.
import { inflateSync, inflateRawSync } from "node:zlib";

export type Cell = { x: number; end: number; text: string; bold: boolean; size: number };
/** cells are runs of nearby text; parts are the pieces as drawn, for placing text in table columns. */
export type Line = { page: number; y: number; cells: Cell[]; parts: Cell[]; text: string };

type Obj = { dict: string; stream?: Buffer };
type Matrix = [number, number, number, number, number, number];
type Font = { bold: boolean; toUnicode: Map<string, string> | null; twoByte: boolean };
type Item = { page: number; x: number; y: number; end: number; text: string; bold: boolean; size: number };
type Ordered = Item & { order: number };

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

function ascii85(data: Buffer): Buffer {
  const text = data.toString("latin1").replace(/\s+/g, "").replace(/^<~/, "").replace(/~>.*$/, "");
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of text) {
    if (ch === "z" && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let n = 0;
      for (const d of group) n = n * 85 + d;
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      group = [];
    }
  }
  if (group.length) {
    const len = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const d of group) n = n * 85 + d;
    out.push(...[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, len - 1));
  }
  return Buffer.from(out);
}

function inflate(data: Buffer): Buffer {
  try {
    return inflateSync(data);
  } catch {
    return inflateRawSync(data.subarray(2));
  }
}

function decode(dict: string, data: Buffer): Buffer | null {
  const filters = (dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1] ?? "").match(/\/\w+/g) ?? [];
  let out = data;
  for (const f of filters) {
    if (f === "/FlateDecode" || f === "/Fl") out = inflate(out);
    else if (f === "/ASCII85Decode" || f === "/A85") out = ascii85(out);
    else return null; // images and other encodings carry no text
  }
  return out;
}

/** Every object in the file, including those packed into object streams. */
function readObjects(pdf: Buffer): Map<number, Obj> {
  const src = pdf.toString("latin1");
  const objects = new Map<number, Obj>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const endObj = src.indexOf("endobj", start);
    if (endObj < 0) break;
    const body = src.slice(start, endObj);
    const s = body.search(/\bstream\r?\n/);
    if (s < 0) {
      objects.set(Number(m[1]), { dict: body });
    } else {
      const dict = body.slice(0, s);
      const dataStart = start + s + body.slice(s).match(/^stream\r?\n/)![0].length;
      const length = Number(dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/)?.[1] ?? NaN);
      const dataEnd = Number.isFinite(length) && src.slice(dataStart + length, dataStart + length + 20).includes("endstream")
        ? dataStart + length
        : src.lastIndexOf("endstream", endObj);
      objects.set(Number(m[1]), { dict, stream: pdf.subarray(dataStart, dataEnd) });
    }
    re.lastIndex = endObj;
  }
  for (const obj of [...objects.values()]) {
    if (!obj.stream || !/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const data = decode(obj.dict, obj.stream)?.toString("latin1");
    if (!data) continue;
    const n = Number(obj.dict.match(/\/N\s+(\d+)/)?.[1] ?? 0);
    const first = Number(obj.dict.match(/\/First\s+(\d+)/)?.[1] ?? 0);
    const nums = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const from = first + nums[i * 2 + 1];
      const to = i + 1 < n ? first + nums[i * 2 + 3] : data.length;
      if (!objects.has(nums[i * 2])) objects.set(nums[i * 2], { dict: data.slice(from, to) });
    }
  }
  return objects;
}

/** The value after /Key in a dictionary: a reference, an inline dictionary, an array or a token. */
function entry(dict: string, key: string): string | null {
  const i = dict.search(new RegExp(`/${key}(?![A-Za-z0-9])`));
  if (i < 0) return null;
  const rest = dict.slice(i + key.length + 1).trimStart();
  if (rest.startsWith("<<")) {
    let depth = 0;
    for (let j = 0; j < rest.length - 1; j++) {
      if (rest.startsWith("<<", j)) { depth++; j++; }
      else if (rest.startsWith(">>", j)) { depth--; j++; if (depth === 0) return rest.slice(0, j + 1); }
    }
    return rest;
  }
  if (rest.startsWith("[")) return rest.slice(0, rest.indexOf("]") + 1);
  return rest.match(/^(\d+\s+\d+\s+R|\/[^\s/<>[\]()]+|[^\s/<>[\]()]+)/)?.[1] ?? null;
}

function hexToString(hex: string): string {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 2) out += String.fromCharCode(parseInt((clean.slice(i, i + 2) + "0").slice(0, 2), 16));
  return out;
}

function parseCMap(text: string): { map: Map<string, string>; twoByte: boolean } {
  const map = new Map<string, string>();
  const unicode = (hex: string) => {
    let s = "";
    for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, "0"), 16));
    return s;
  };
  const twoByte = /begincodespacerange\s*<[0-9a-f]{4}>/i.test(text);
  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) map.set(hexToString(m[1]), unicode(m[2]));
  }
  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<[0-9a-f]+>|\[[^\]]*\])/gi)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), width = m[1].length;
      const targets = m[3].startsWith("[") ? [...m[3].matchAll(/<([0-9a-f]+)>/gi)].map((t) => t[1]) : null;
      for (let c = lo; c <= hi && c - lo < 65536; c++) {
        const key = hexToString(c.toString(16).padStart(width, "0"));
        if (targets) { if (targets[c - lo]) map.set(key, unicode(targets[c - lo])); }
        else {
          const base = m[3].slice(1, -1);
          const last = parseInt(base.slice(-4), 16) + (c - lo);
          map.set(key, unicode(base.slice(0, -4) + last.toString(16).padStart(4, "0")));
        }
      }
    }
  }
  return { map, twoByte };
}

// Rough Helvetica advance widths (per 1000 em), enough to tell neighbouring words from table columns.
function advance(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    if (" ,.;:!|'ijlI".includes(ch)) w += 278;
    else if ("frt()-[]".includes(ch)) w += 333;
    else if ("MWmw@".includes(ch)) w += 833;
    else if (ch >= "A" && ch <= "Z") w += 667;
    else w += 556;
  }
  return (w / 1000) * size;
}

type Token = { op?: string; num?: number; str?: string; name?: string; arr?: Token[] };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const stack: Token[][] = [];
  let i = 0;
  const push = (t: Token) => (stack.length ? stack[stack.length - 1] : out).push(t);
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "%") { while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (c === "(") {
      let depth = 1, s = "";
      i++;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === "\\") {
          const n = src[i + 1];
          const esc: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
          if (n in esc) { s += esc[n]; i += 2; }
          else if (/[0-7]/.test(n)) { const oct = src.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)![0]; s += String.fromCharCode(parseInt(oct, 8)); i += 1 + oct.length; }
          else if (n === "\n" || n === "\r") { i += n === "\r" && src[i + 2] === "\n" ? 3 : 2; }
          else { s += n ?? ""; i += 2; }
          continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") { depth--; if (depth === 0) { i++; break; } }
        s += ch;
        i++;
      }
      push({ str: s });
      continue;
    }
    if (c === "<" && src[i + 1] === "<") { i += 2; push({ op: "<<" }); continue; }
    if (c === ">" && src[i + 1] === ">") { i += 2; push({ op: ">>" }); continue; }
    if (c === "<") { const end = src.indexOf(">", i); push({ str: hexToString(src.slice(i + 1, end)) }); i = end + 1; continue; }
    if (c === "[") { stack.push([]); i++; continue; }
    if (c === "]") { const arr = stack.pop() ?? []; push({ arr }); i++; continue; }
    if (c === "/") { const m = src.slice(i).match(/^\/[^\s/<>[\]()%{}]*/)![0]; push({ name: m.slice(1) }); i += m.length; continue; }
    const m = src.slice(i).match(/^[+-]?(\d+\.?\d*|\.\d+)/);
    if (m) { push({ num: Number(m[0]) }); i += m[0].length; continue; }
    const word = src.slice(i).match(/^[^\s/<>[\]()%{}]+/)?.[0];
    if (!word) { i++; continue; }
    if (word === "BI") { const end = src.indexOf("EI", i); i = end < 0 ? src.length : end + 2; continue; } // inline image
    push({ op: word });
    i += word.length;
  }
  return out;
}

function pageItems(content: string, fonts: Map<string, Font>, page: number): Item[] {
  const items: Item[] = [];
  let ctm: Matrix = IDENTITY;
  const saved: Matrix[] = [];
  let tm: Matrix = IDENTITY, tlm: Matrix = IDENTITY;
  let leading = 0, size = 10, font: Font | undefined;
  let args: Token[] = [];
  const show = (raw: string) => {
    let text = "";
    if (font?.toUnicode) {
      const step = font.twoByte ? 2 : 1;
      for (let i = 0; i < raw.length; i += step) text += font.toUnicode.get(raw.slice(i, i + step)) ?? (step === 1 ? raw[i] : "");
    } else {
      text = raw;
    }
    if (!text) return;
    const m = mul(tm, ctm);
    const scale = Math.hypot(m[0], m[1]) || 1;
    const w = advance(text, size) * scale;
    items.push({ page, x: m[4], y: m[5], end: m[4] + w, text, bold: Boolean(font?.bold), size: size * scale });
    tm = mul([1, 0, 0, 1, advance(text, size), 0], tm);
  };
  const nextLine = (tx: number, ty: number) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };
  for (const t of tokenize(content)) {
    if (!t.op || t.op === "<<" || t.op === ">>") { args.push(t); continue; }
    const n = (k: number) => args[args.length - k]?.num ?? 0;
    switch (t.op) {
      case "q": saved.push(ctm); break;
      case "Q": ctm = saved.pop() ?? IDENTITY; break;
      case "cm": ctm = mul([n(6), n(5), n(4), n(3), n(2), n(1)], ctm); break;
      case "BT": tm = tlm = IDENTITY; break;
      case "Tf": size = n(1); font = fonts.get(args[args.length - 2]?.name ?? ""); break;
      case "TL": leading = n(1); break;
      case "Td": nextLine(n(2), n(1)); break;
      case "TD": leading = -n(1); nextLine(n(2), n(1)); break;
      case "Tm": tm = tlm = [n(6), n(5), n(4), n(3), n(2), n(1)]; break;
      case "T*": nextLine(0, -leading); break;
      case "Tj": show(args[args.length - 1]?.str ?? ""); break;
      case "'": nextLine(0, -leading); show(args[args.length - 1]?.str ?? ""); break;
      case "\"": nextLine(0, -leading); show(args[args.length - 1]?.str ?? ""); break;
      case "TJ": {
        for (const part of args[args.length - 1]?.arr ?? []) {
          if (part.str !== undefined) show(part.str);
          else if (part.num !== undefined) {
            const shift = (-part.num / 1000) * size;
            // A large negative kern is a word gap in many exporters.
            if (shift > size * 0.2) show(" ");
            else tm = mul([1, 0, 0, 1, shift, 0], tm);
          }
        }
        break;
      }
    }
    args = [];
  }
  return items;
}

/** Text lines, top to bottom, each split into cells wherever a gap is wider than a few spaces. */
export function pdfLines(pdf: Buffer): Line[] {
  if (pdf.subarray(0, 1024).toString("latin1").indexOf("%PDF") < 0) throw new Error("That file isn't a PDF.");
  const objects = readObjects(pdf);
  const ref = (v: string | null) => (v?.match(/^(\d+)\s+\d+\s+R$/) ? objects.get(Number(v.split(/\s+/)[0])) : undefined);
  const resolve = (v: string | null) => ref(v)?.dict ?? v ?? "";
  const stream = (o: Obj | undefined) => (o?.stream ? decode(o.dict, o.stream) : null);

  // Pages in reading order, following the page tree from the catalog.
  const pages: Obj[] = [];
  const src = pdf.toString("latin1");
  const rootRef = [...src.matchAll(/\/Root\s+(\d+\s+\d+\s+R)/g)].pop()?.[1] ?? null;
  const walk = (node: Obj | undefined, inherited: string, depth: number) => {
    if (!node || depth > 32) return;
    const resources = entry(node.dict, "Resources") ?? inherited;
    if (/\/Type\s*\/Pages\b/.test(node.dict)) {
      const kids = entry(node.dict, "Kids") ?? "";
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(objects.get(Number(k[1])), resources, depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(node.dict)) {
      pages.push({ dict: node.dict.includes("/Resources") ? node.dict : `${node.dict} /Resources ${resources}` });
    }
  };
  const catalog = ref(rootRef);
  if (catalog) walk(ref(entry(catalog.dict, "Pages")), "", 0);
  if (!pages.length) for (const [, o] of [...objects].sort((a, b) => a[0] - b[0])) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(o);

  const items: Item[] = [];
  pages.forEach((page, index) => {
    const fonts = new Map<string, Font>();
    const fontDict = resolve(entry(resolve(entry(page.dict, "Resources")), "Font"));
    for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+\s+\d+\s+R)/g)) {
      const f = ref(m[2]);
      if (!f) continue;
      const cmap = stream(ref(entry(f.dict, "ToUnicode")));
      const parsed = cmap ? parseCMap(cmap.toString("latin1")) : null;
      const base = entry(f.dict, "BaseFont") ?? "";
      fonts.set(m[1], {
        bold: /bold|black|heavy|semibold/i.test(base),
        toUnicode: parsed?.map.size ? parsed.map : null,
        twoByte: parsed?.twoByte ?? /Identity-H/.test(f.dict),
      });
    }
    const contents = entry(page.dict, "Contents") ?? "";
    const parts = contents.startsWith("[") ? [...contents.matchAll(/\d+\s+\d+\s+R/g)].map((r) => r[0]) : [contents];
    const text = parts.map((p) => stream(ref(p))?.toString("latin1") ?? "").join("\n");
    items.push(...pageItems(text, fonts, index));
  });

  // Group into lines by baseline (top to bottom), then into cells by horizontal gaps.
  const lines: Line[] = [];
  const sorted = items
    .map((it, order) => ({ ...it, order }))
    .filter((it) => it.text.trim() || it.text === " ")
    .sort((a, b) => a.page - b.page || b.y - a.y || a.order - b.order);
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.page === it.page && Math.abs(last.y - it.y) <= Math.max(1.5, it.size * 0.25)) {
      (last as Line & { raw: Ordered[] }).raw.push(it);
    } else {
      lines.push(Object.assign({ page: it.page, y: it.y, cells: [], parts: [], text: "" }, { raw: [it] }));
    }
  }
  for (const line of lines as Array<Line & { raw: Ordered[] }>) {
    const raw = line.raw.sort((a, b) => a.x - b.x || a.order - b.order);
    const cells: Cell[] = [];
    for (const it of raw) {
      const cell = cells[cells.length - 1];
      const gap = cell ? it.x - cell.end : Infinity;
      if (cell && gap < Math.max(6, it.size * 1.2)) {
        cell.text += (gap > it.size * 0.15 && !cell.text.endsWith(" ") && !it.text.startsWith(" ") ? " " : "") + it.text;
        cell.end = Math.max(cell.end, it.end);
        cell.bold = cell.bold && it.bold;
      } else {
        cells.push({ x: it.x, end: it.end, text: it.text, bold: it.bold, size: it.size });
      }
    }
    line.cells = cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() })).filter((c) => c.text);
    line.parts = raw.map((it) => ({ x: it.x, end: it.end, text: clean(it.text), bold: it.bold, size: it.size })).filter((c) => c.text);
    line.text = line.cells.map((c) => c.text).join("  ");
    delete (line as Partial<typeof line>).raw;
  }
  return lines.filter((l) => l.cells.length);
}
