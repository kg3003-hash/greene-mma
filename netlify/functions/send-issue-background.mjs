// GREENE MMA — newsletter sender
//
// The "-background" suffix is load-bearing: Netlify runs these asynchronously
// with a 15-minute budget instead of the 10 seconds a normal function gets.
// Resend's rate limit means a real list cannot be sent inside 10 seconds, so a
// plain function would time out halfway through and leave half a list emailed
// with no record of where it stopped.
//
// Progress is written to the issue doc as it goes, so the Studio can show a
// live count and a stalled send is visible rather than silent.
//
// Env: RESEND_API_KEY, STUDIO_KEY, FIREBASE_SERVICE_ACCOUNT

import admin from "firebase-admin";
import { mailSecret, issueMessage, sendBatch, BATCH_SIZE, BATCH_PAUSE_MS, isEmail } from "./lib/mail.mjs";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json" } });

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!process.env.STUDIO_KEY || req.headers.get("x-studio-key") !== process.env.STUDIO_KEY) {
    return json({ error: "Not authorised" }, 401);
  }

  let body = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const issueId = String(body.id || "").trim();
  if (!issueId) return json({ error: "Which issue?" }, 400);

  const ref = db.collection("issues").doc(issueId);
  const snap = await ref.get();
  if (!snap.exists) return json({ error: "That issue is gone." }, 404);
  const issue = snap.data();
  if (!issue.subject || !issue.body) return json({ error: "That issue has no subject or body." }, 400);

  // Guard against a double-click sending the list twice. A send that died
  // mid-flight is resumable: `sentCount` says where to pick up.
  if (issue.sending === true) return json({ error: "That issue is already sending." }, 409);
  if (issue.sent === true && !body.resume) return json({ error: "That issue has already gone out." }, 409);

  const secret = await mailSecret(db);
  const subs = await db.collection("subscribers").orderBy("createdAt", "desc").limit(5000).get();
  // Sorted by address, because a resume counts from an offset and that only
  // means anything if the list comes back in the same order every time. Signup
  // order would reshuffle the moment someone new subscribed mid-send.
  const all = subs.docs
    .map((d) => (d.data() || {}).email || d.id)
    .filter(isEmail)
    .sort();
  const startAt = body.resume ? Math.max(0, Number(issue.sentCount) || 0) : 0;
  const queue = all.slice(startAt);

  if (!queue.length) {
    await ref.set({ sending: false, sent: true, sentCount: all.length, total: all.length,
      sentAt: admin.firestore.Timestamp.now(), sendError: null }, { merge: true });
    return json({ ok: true, sent: 0, total: all.length, note: "Nobody left to send to." });
  }

  await ref.set({ sending: true, total: all.length, sentCount: startAt, sendError: null,
    sendStartedAt: admin.firestore.Timestamp.now() }, { merge: true });

  let sent = startAt;
  try {
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const slice = queue.slice(i, i + BATCH_SIZE);
      const res = await sendBatch(slice.map((email) => issueMessage({ issue, email, secret })));
      if (!res.ok) {
        // Record exactly how far we got so a resume doesn't re-send to anyone.
        await ref.set({ sending: false, sentCount: sent, total: all.length,
          sendError: `Stopped after ${sent} of ${all.length}: ${res.error}` }, { merge: true });
        console.error(`send-issue ${issueId}: ${res.error}`);
        return json({ ok: false, error: res.error, sent, total: all.length }, 502);
      }
      sent += slice.length;
      await ref.set({ sentCount: sent }, { merge: true });
      if (i + BATCH_SIZE < queue.length) await sleep(BATCH_PAUSE_MS);
    }
  } catch (e) {
    await ref.set({ sending: false, sentCount: sent, total: all.length,
      sendError: `Stopped after ${sent} of ${all.length}: ${e.message}` }, { merge: true });
    console.error(`send-issue ${issueId} threw:`, e);
    return json({ ok: false, error: e.message, sent, total: all.length }, 500);
  }

  await ref.set({ sending: false, sent: true, sentCount: sent, total: all.length,
    sentAt: admin.firestore.Timestamp.now(), sendError: null }, { merge: true });
  console.log(`send-issue ${issueId}: ${sent}/${all.length} sent`);
  return json({ ok: true, sent, total: all.length });
}
