// Email through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
import { config } from "../config.ts";

export const emailEnabled = () => Boolean(config.email.resendKey);

export interface Email {
  to: string[];
  subject: string;
  text: string;
  html: string;
  /** The same key never sends twice (Resend keeps it for 24 hours). */
  idempotencyKey?: string;
}

/** Sends one email. Returns Resend's id, or throws with Resend's reason. */
export async function sendEmail(email: Email): Promise<string> {
  if (!config.email.resendKey) throw new Error("Email is off: set RESEND_API_KEY.");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.email.resendKey}`,
      "content-type": "application/json",
      ...(email.idempotencyKey ? { "idempotency-key": email.idempotencyKey } : {}),
    },
    body: JSON.stringify({ from: config.email.from, to: email.to, subject: email.subject, text: email.text, html: email.html }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok || !body.id) throw new Error(`Resend ${res.status}: ${body.message ?? "no id returned"}`);
  return body.id;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain, quiet HTML email: a headline, a few label/value rows, a closing line. */
export function simpleHtml(headline: string, intro: string, rows: [string, string][], outro: string): string {
  const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif";
  return `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#F5F5F7;font-family:${font};color:#1D1D1F">
<div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:18px;padding:32px">
<h1 style="margin:0 0 12px;font-size:28px;line-height:1.15;font-weight:600;letter-spacing:-0.02em">${esc(headline)}</h1>
<p style="margin:0 0 24px;font-size:17px;line-height:1.47;color:rgba(0,0,0,0.72)">${esc(intro)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.4">
${rows.map(([k, v]) => `<tr><td style="padding:10px 0;border-top:1px solid rgba(0,0,0,0.08);color:rgba(0,0,0,0.56);width:38%;vertical-align:top">${esc(k)}</td><td style="padding:10px 0;border-top:1px solid rgba(0,0,0,0.08);vertical-align:top">${esc(v)}</td></tr>`).join("\n")}
</table>
<p style="margin:24px 0 0;font-size:15px;line-height:1.47;color:rgba(0,0,0,0.56)">${esc(outro)}</p>
</div></body></html>`;
}
