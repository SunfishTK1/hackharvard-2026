// Replaces participant names with participant codes in every API response.
// Names reach the page through free text (alert reasons, message bodies), so the
// server scrubs the finished JSON rather than trusting each field to be clean.
import type { Queryable } from "./home.ts";

const NAMES_SQL = `
  SELECT p.participant_code AS code, btrim(c.preferred_name) AS name
  FROM private.participant_contacts c JOIN public.participants p ON p.id = c.participant_id
  WHERE nullif(btrim(c.preferred_name), '') IS NOT NULL`;

const STAFF_SQL = `SELECT display_name FROM private.staff_users WHERE nullif(btrim(display_name), '') IS NOT NULL`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function loadRedactor(db: Queryable): Promise<(json: string) => string> {
  const names = (await db.query(NAMES_SQL)).rows as { code: string; name: string }[];
  const staff = (await db.query(STAFF_SQL)).rows.map((r) => r.display_name as string);

  // A name shared by several participants can't be mapped to one code.
  // Matching is case-sensitive: a participant called "Will" must not rewrite "will" in a sentence.
  const codesByName = new Map<string, Set<string>>();
  for (const { code, name } of names) codesByName.set(name, (codesByName.get(name) ?? new Set()).add(code));
  // Longest names first, so "Mary Ann" is replaced before "Mary".
  const entries = [...codesByName.entries()].sort(([a], [b]) => b.length - a.length);

  return (json) => {
    if (!entries.length) return json;
    // Shield staff names so a participant who shares a staff member's first name doesn't change them.
    const shields: string[] = [];
    let out = json;
    for (const s of [...staff].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(`\\b${escape(s)}\\b`, "g"), () => `\u0000${shields.push(s) - 1}\u0000`);
    }
    for (const [name, codes] of entries) {
      const code = codes.size === 1 ? [...codes][0] : null;
      const word = `\\b${escape(name)}\\b`;
      if (code) {
        // "Thomas (STUDY-005-P009)" → "STUDY-005-P009"
        out = out.replace(new RegExp(`${word}\\s*\\(${escape(code)}\\)`, "g"), code);
      }
      // A name shared by several participants becomes a visible placeholder rather than a guess.
      out = out.replace(new RegExp(word, "g"), code ?? "[participant]");
    }
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => shields[Number(i)]);
  };
}
