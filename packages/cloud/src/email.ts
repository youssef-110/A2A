/**
 * Email through Resend (https://resend.com/docs/api-reference/emails/send-email): one branded layout
 * with the a2a logo for every message. Without RESEND_API_KEY nothing is sent; the message is logged,
 * so local development works without a key.
 */

export interface EmailEnv {
  RESEND_API_KEY?: string;
  /** "a2a <hello@your-domain>" once a domain is verified in Resend. The default only reaches the Resend account owner. */
  EMAIL_FROM?: string;
}

export const NEWSLETTER_NAME = "The Relay";
const DEFAULT_FROM = "a2a <onboarding@resend.dev>";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface EmailContent {
  /** Shown in the inbox list before the email is opened. */
  preview: string;
  heading: string;
  /** Plain paragraphs; they are escaped. */
  paragraphs: string[];
  button?: { label: string; url: string };
  /** Small print under the button, e.g. why they got this or how to unsubscribe. */
  footer: string;
  unsubscribeUrl?: string;
}

/** Table layout and inline styles: what email clients (Gmail, Outlook, Apple Mail) render reliably. */
export function renderEmail(origin: string, c: EmailContent): { html: string; text: string } {
  const p = (t: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#c9c8bf">${esc(t)}</p>`;
  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:999px;background:#cdff3c">
         <a href="${esc(c.button.url)}" style="display:inline-block;padding:13px 24px;font-size:15px;font-weight:600;color:#0b0b0a;text-decoration:none;border-radius:999px">${esc(c.button.label)}</a>
       </td></tr></table>
       <p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:#8f8e86">Or paste this link into your browser:<br><a href="${esc(c.button.url)}" style="color:#cdff3c;word-break:break-all">${esc(c.button.url)}</a></p>`
    : "";
  const unsub = c.unsubscribeUrl ? ` <a href="${esc(c.unsubscribeUrl)}" style="color:#8f8e86">Unsubscribe</a>.` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${esc(c.heading)}</title></head>
<body style="margin:0;padding:0;background:#0b0b0a">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0a"><tr><td align="center" style="padding:40px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
    <tr><td style="padding:0 0 28px">
      <a href="${esc(origin)}" style="text-decoration:none"><img src="${esc(origin)}/email-logo.png" width="40" height="40" alt="a2a" style="display:inline-block;vertical-align:middle;border:0;border-radius:9px">
      <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:20px;font-weight:500;letter-spacing:-0.4px;color:#f2f1ea">A2A</span></a>
    </td></tr>
    <tr><td style="padding:32px;border-radius:16px;background:#121211;border:1px solid #262624">
      <h1 style="margin:0 0 18px;font-size:24px;line-height:1.25;font-weight:500;letter-spacing:-0.4px;color:#f2f1ea">${esc(c.heading)}</h1>
      ${c.paragraphs.map(p).join("\n      ")}
      ${button}
    </td></tr>
    <tr><td style="padding:22px 8px 0;font-size:12px;line-height:1.6;color:#8f8e86">${esc(c.footer)}${unsub}<br>A2A, the relay where AI agents work together.</td></tr>
  </table>
</td></tr></table>
</body></html>`;
  const text = [c.heading, "", ...c.paragraphs, ...(c.button ? ["", `${c.button.label}: ${c.button.url}`] : []), "", c.footer, ...(c.unsubscribeUrl ? [`Unsubscribe: ${c.unsubscribeUrl}`] : [])].join("\n");
  return { html, text };
}

/** Sends one email. Returns false (never throws) when it couldn't, so a mail outage can't break sign-up. */
export async function sendEmail(env: EmailEnv, origin: string, to: string, subject: string, content: EmailContent): Promise<boolean> {
  const { html, text } = renderEmail(origin, content);
  if (!env.RESEND_API_KEY) {
    console.log(`[email not sent: no RESEND_API_KEY] to=${to} subject=${subject}\n${text}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM || DEFAULT_FROM,
        to: [to],
        subject,
        html,
        text,
        ...(content.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${content.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.log(`[email failed] ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.ok;
  } catch (err) {
    console.log(`[email failed] ${(err as Error).message}`);
    return false;
  }
}
