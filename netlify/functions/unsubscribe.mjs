// GREENE MMA — unsubscribe
//
// Served at /u so one URL covers both ways people leave a list:
//   POST  — the one-click button Gmail and Apple Mail render from the
//           List-Unsubscribe header. No page is ever shown, so this must
//           just work and return 200.
//   GET   — someone clicked the link in the footer. Same effect, then a
//           short page saying it's done.
//
// The token is an HMAC of the address, so a link can't be forged to unsubscribe
// someone else, and nobody needs to be signed in to leave.

import admin from "firebase-admin";
import { mailSecret, unsubValid, esc, SITE_URL } from "./lib/mail.mjs";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const INK = "#0C0E0A", CARD = "#13160F", VOLT = "#C9F73A", BONE = "#F2F0E9", STEEL = "#9AA194", HAIR = "#262B1C";

function page(title, message, extra) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — Greene MMA</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow:wght@400;600&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:${INK};color:${BONE};font-family:'Barlow',sans-serif;padding:24px;}
  .box{max-width:460px;width:100%;background:${CARD};border:1px solid ${HAIR};padding:34px 30px;text-align:center;}
  h1{font-family:'Anton',sans-serif;text-transform:uppercase;letter-spacing:.02em;font-size:30px;margin:0 0 12px;}
  p{font-size:16px;line-height:1.6;margin:0 0 16px;color:${BONE};}
  .sub{color:${STEEL};font-size:14px;}
  .mono{font-family:'JetBrains Mono',monospace;font-size:12px;color:${STEEL};word-break:break-all;}
  a.btn{display:inline-block;margin-top:8px;padding:11px 22px;background:${VOLT};color:${INK};
    font-weight:600;text-decoration:none;letter-spacing:.03em;}
  a.plain{color:${STEEL};}
</style></head>
<body><div class="box"><h1>${esc(title)}</h1>${message}${extra || ""}
<p><a class="btn" href="${SITE_URL}">Back to Greene MMA</a></p></div></body></html>`;
}

const html = (body, status) =>
  new Response(body, { status: status || 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export default async function handler(req) {
  const url = new URL(req.url);
  const email = String(url.searchParams.get("e") || "").trim().toLowerCase();
  const token = String(url.searchParams.get("t") || "").trim();
  const oneClick = req.method === "POST";

  if (!email || !token) {
    return oneClick
      ? new Response("Missing address or token", { status: 400 })
      : html(page("Link incomplete",
          `<p>That unsubscribe link is missing part of itself — it may have been cut short by your email app.</p>
           <p class="sub">Forward the email to <a class="plain" href="mailto:cedric@greene.bet">cedric@greene.bet</a> and it'll be handled by hand.</p>`), 400);
  }

  let ok = false;
  try {
    ok = unsubValid(email, token, await mailSecret(db));
  } catch (e) {
    console.error("unsubscribe verify failed:", e.message);
    return oneClick
      ? new Response("Temporary failure", { status: 500 })
      : html(page("Something broke",
          `<p>That didn't go through, and it's on our end — not you.</p>
           <p class="sub">Email <a class="plain" href="mailto:cedric@greene.bet">cedric@greene.bet</a> and you'll be taken off by hand.</p>`), 500);
  }

  if (!ok) {
    return oneClick
      ? new Response("Bad token", { status: 400 })
      : html(page("That link didn't check out",
          `<p>The link doesn't match the address it's for, so nothing was changed.</p>
           <p class="sub">If you meant to unsubscribe <span class="mono">${esc(email)}</span>, email
           <a class="plain" href="mailto:cedric@greene.bet">cedric@greene.bet</a> and it'll be done by hand.</p>`), 400);
  }

  // Deleting rather than flagging: the list stays honest, and re-subscribing
  // through the site is one field and one click if they change their mind.
  await db.collection("subscribers").doc(email).delete();

  if (oneClick) return new Response("Unsubscribed", { status: 200 });
  return html(page("You're off the list",
    `<p><span class="mono">${esc(email)}</span> won't get the newsletter again.</p>
     <p class="sub">No hard feelings — the site is still there whenever you want it.</p>`));
}

export const config = { path: "/u" };
