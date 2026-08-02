// Shared helper — NOT a function endpoint (lives in lib/ so Netlify skips it).
//
// Everything the site needs to send mail through Resend: the API calls, the
// markdown the Studio writes turned into an email-safe body, the branded
// wrapper, and the unsubscribe tokens.
//
// Env: RESEND_API_KEY, and optionally MAIL_FROM / MAIL_TO / SITE_URL.

import crypto from "node:crypto";

export const SITE_URL = (process.env.SITE_URL || "https://mma.greene.bet").replace(/\/+$/, "");
// The verified sending identity. greene.bet is what's verified in Resend —
// this address has nothing to do with which site's code is running.
export const MAIL_FROM = process.env.MAIL_FROM || "Greene MMA <cedric@greene.bet>";
export const MAIL_TO = process.env.MAIL_TO || "cedric@greene.bet";

const RESEND = "https://api.resend.com";
// Resend's default rate limit is 2 requests/second. Batching 100 recipients
// per request keeps a real list well inside it.
export const BATCH_SIZE = 100;
export const BATCH_PAUSE_MS = 600;

export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(s || "").trim());
export const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* ---------------- Resend ---------------- */

export const hasKey = () => !!process.env.RESEND_API_KEY;

// Resend puts the useful part in `message`, but not always — keep the status
// and anything else it said, because "Resend returned 403" alone has never
// helped anybody work out what to change.
function resendError(status, data) {
  const parts = [];
  if (data && data.message) parts.push(data.message);
  else if (data && data.name) parts.push(data.name);
  if (data && data.error && typeof data.error === "string" && data.error !== parts[0]) parts.push(data.error);
  if (!parts.length) parts.push(typeof data === "string" && data ? data.slice(0, 200) : "no detail given");
  return `Resend ${status}: ${parts.join(" — ")}`;
}

async function post(path, payload) {
  if (!hasKey()) {
    return { ok: false, error: "RESEND_API_KEY is not set on this site. Add it in Netlify under Site configuration → Environment variables, then redeploy." };
  }
  let res, data;
  try {
    res = await fetch(`${RESEND}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, error: `Could not reach Resend: ${e.message}` };
  }
  if (!res.ok) return { ok: false, error: resendError(res.status, data), status: res.status };
  return { ok: true, data };
}

// One email. Returns { ok, id?, error? } rather than throwing, so a bad key or
// a single bad address can't take down a whole send.
export async function sendMail(msg) {
  const r = await post("/emails", msg);
  return r.ok ? { ok: true, id: r.data && r.data.id } : r;
}

// Up to BATCH_SIZE emails in one request. Each entry is a full message, so
// every recipient still gets their own unsubscribe link and headers.
export async function sendBatch(messages) {
  if (!messages.length) return { ok: true, sent: 0 };
  const r = await post("/emails/batch", messages);
  return r.ok ? { ok: true, sent: messages.length } : { ...r, sent: 0 };
}

/* ---------------- unsubscribe tokens ----------------
   Signed rather than stored, so every subscriber already has a working link
   without a migration, and the token can't be guessed from the address.
   The secret is minted once and kept in Firestore — deriving it from the
   Studio key would break every link in every already-delivered email the
   day that key was rotated. */

export async function mailSecret(db) {
  const ref = db.collection("site").doc("mailsecret");
  const snap = await ref.get();
  const existing = snap.exists && snap.data() && snap.data().secret;
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString("hex");
  await ref.set({ secret, createdAt: new Date().toISOString() });
  return secret;
}

export const unsubToken = (email, secret) =>
  crypto.createHmac("sha256", secret).update(String(email).trim().toLowerCase()).digest("hex").slice(0, 32);

// Constant-time compare so the token can't be recovered a byte at a time.
export function unsubValid(email, token, secret) {
  const want = Buffer.from(unsubToken(email, secret));
  const got = Buffer.from(String(token || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Points at the /u function, not a static page: the List-Unsubscribe header
// below promises one-click, which means a mail client will POST to this URL
// and expect it to work without a page ever being rendered.
export const unsubUrl = (email, secret) =>
  `${SITE_URL}/u?e=${encodeURIComponent(email)}&t=${unsubToken(email, secret)}`;

/* ---------------- markdown -> email HTML ----------------
   Matches the subset the Studio's formatting bar writes, so what's typed in
   the Studio is what lands in the inbox. Escaping happens first and inline
   styles are baked in, because a good half of email clients throw away
   anything in a <style> block. */

const INK = "#0C0E0A", CARD = "#13160F", VOLT = "#C9F73A", BONE = "#F2F0E9", STEEL = "#9AA194", HAIR = "#262B1C";
const P = `margin:0 0 16px;font-size:16px;line-height:1.65;color:${BONE};`;

function inline(t) {
  // Links first: later rules must not chew up the URL.
  t = t.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,400})\)/g,
    `<a href="$2" style="color:${VOLT};text-decoration:underline;">$1</a>`);
  t = t.replace(/\*\*([^*]{1,300})\*\*/g, `<strong style="color:${BONE};">$1</strong>`);
  t = t.replace(/__([^_]{1,300})__/g, "<u>$1</u>");
  t = t.replace(/(^|[^*])\*([^*\n]{1,300})\*/g, "$1<em>$2</em>");
  return t;
}

export function mdToEmailHtml(src) {
  const lines = esc(String(src || "")).split(/\r?\n/);
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p style="${P}">${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    let m;
    if (/^---+$/.test(line)) { flushPara(); flushList(); out.push(`<hr style="border:0;border-top:1px solid ${HAIR};margin:26px 0;">`); continue; }
    if ((m = line.match(/^###\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h3 style="margin:26px 0 10px;font-size:16px;letter-spacing:.04em;text-transform:uppercase;color:${VOLT};">${inline(m[1])}</h3>`); continue; }
    if ((m = line.match(/^##\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h2 style="margin:30px 0 12px;font-size:21px;line-height:1.25;color:${BONE};">${inline(m[1])}</h2>`); continue; }
    // esc() has already turned "> quote" into "&gt; quote".
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote style="margin:20px 0;padding:2px 0 2px 16px;border-left:3px solid ${VOLT};color:${BONE};font-style:italic;">${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (list !== "ul") { flushList(); out.push(`<ul style="margin:0 0 16px;padding-left:22px;color:${BONE};">`); list = "ul"; }
      out.push(`<li style="margin:0 0 7px;font-size:16px;line-height:1.6;">${inline(m[1])}</li>`); continue;
    }
    if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== "ol") { flushList(); out.push(`<ol style="margin:0 0 16px;padding-left:22px;color:${BONE};">`); list = "ol"; }
      out.push(`<li style="margin:0 0 7px;font-size:16px;line-height:1.6;">${inline(m[1])}</li>`); continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join("\n");
}

// Plain-text alternative. Spam filters treat HTML-only mail with suspicion,
// and some people genuinely read in plain text.
export function mdToText(src) {
  return String(src || "")
    .replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,400})\)/g, "$1 ($2)")
    .replace(/^\s*###\s+/gm, "").replace(/^\s*##\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/^\s*---+\s*$/gm, "—".repeat(20))
    .trim();
}

/* ---------------- the wrapper ---------------- */

// A dark, volt-accented shell that matches the site. Table-based because
// Outlook still renders with Word's engine and ignores modern layout.
export function emailShell({ title, preview, bodyHtml, footerHtml }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title || "Greene MMA")}</title></head>
<body style="margin:0;padding:0;background:${INK};">
${preview ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preview)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${INK};">
<tr><td align="center" style="padding:28px 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${CARD};border:1px solid ${HAIR};">
    <tr><td style="padding:22px 26px 18px;border-bottom:1px solid ${HAIR};">
      <a href="${SITE_URL}" style="text-decoration:none;">
        <span style="font-family:Impact,'Arial Black',Haettenschweiler,sans-serif;font-size:22px;letter-spacing:.06em;text-transform:uppercase;color:${BONE};">GREENE <span style="color:${VOLT};">MMA</span></span>
      </a>
      <div style="margin-top:5px;font-family:Consolas,Menlo,monospace;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:${STEEL};">Fight news from the Greene corner</div>
    </td></tr>
    <tr><td style="padding:26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:18px 26px 24px;border-top:1px solid ${HAIR};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:${STEEL};">
      ${footerHtml || ""}
    </td></tr>
  </table>
  <div style="max-width:600px;margin:14px auto 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;color:${STEEL};text-align:center;">
    Greene MMA · Utah
  </div>
</td></tr></table>
</body></html>`;
}

// One issue, addressed to one subscriber.
export function issueMessage({ issue, email, secret }) {
  const link = unsubUrl(email, secret);
  const bodyHtml = mdToEmailHtml(issue.body);
  const footerHtml =
    `You're getting this because you signed up at <a href="${SITE_URL}" style="color:${STEEL};">mma.greene.bet</a>.<br>` +
    `<a href="${esc(link)}" style="color:${STEEL};text-decoration:underline;">Unsubscribe</a> — one click, no hard feelings.`;
  const text = `${mdToText(issue.body)}\n\n—\nUnsubscribe: ${link}`;
  return {
    from: MAIL_FROM,
    to: [email],
    subject: issue.subject,
    html: emailShell({ title: issue.subject, preview: issue.preview, bodyHtml, footerHtml }),
    text,
    headers: {
      // Lets Gmail and Apple Mail show their own one-click unsubscribe, which
      // people use instead of the spam button. That matters for a new domain.
      "List-Unsubscribe": `<${link}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
