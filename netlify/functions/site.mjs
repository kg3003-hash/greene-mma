// GREENE MMA — Site data
// Two jobs:
//   POST /site  (with x-studio-key)  → save your written picks
//   POST /site  {subscribe:"a@b.com"} → newsletter capture, no key needed
//
// Env: STUDIO_KEY, FIREBASE_SERVICE_ACCOUNT

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const isEmail = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400 });
  }

  // ---- Public: newsletter signup ----
  if (body.subscribe !== undefined) {
    const email = String(body.subscribe || "").trim().toLowerCase();
    if (!isEmail(email)) {
      return new Response(JSON.stringify({ error: "That email doesn't look right." }), { status: 400 });
    }
    await db.collection("subscribers").doc(email).set(
      {
        email,
        source: body.source || "site",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  // ---- Everything below needs the studio key ----
  if (req.headers.get("x-studio-key") !== process.env.STUDIO_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  if (body.ping) return new Response(JSON.stringify({ ok: true }), { status: 200 });

  // Save written picks (overrides / annotates the auto-pulled odds)
  if (body.picks) {
    await db.collection("site").doc("picks").set({
      picks: (body.picks || []).slice(0, 6).map((p) => ({
        fighter: String(p.fighter || "").slice(0, 80),
        odds: String(p.odds || "").slice(0, 12),
        note: String(p.note || "").slice(0, 300),
        confidence: String(p.confidence || "Lean").slice(0, 20),
      })),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, saved: body.picks.length }), { status: 200 });
  }

  // Publish an original article written in the studio
  if (body.article) {
    const a = body.article;
    if (!a.headline || !a.body) {
      return new Response(JSON.stringify({ error: "Headline and body are required." }), { status: 400 });
    }
    const slug = String(a.headline)
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
      || "story-" + Date.now();
    const id = a.id || `gm-${slug}`;
    await db.collection("stories").doc(id).set({
      headline: String(a.headline).slice(0, 160),
      summary: String(a.summary || "").slice(0, 400),
      body: String(a.body).slice(0, 20000),
      category: String(a.category || "The Corner").slice(0, 40),
      sourceName: "Greene MMA",
      sourceUrl: "",
      original: true,
      utah: a.utah === true,
      publishedAt: admin.firestore.Timestamp.now(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return new Response(JSON.stringify({ ok: true, id }), { status: 200 });
  }

  // Delete a story (cleaning up stray wrestling items, bad rewrites, etc.)
  if (body.deleteStory) {
    await db.collection("stories").doc(String(body.deleteStory)).delete();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  // Recent stories, for the studio's manage list
  if (body.listStories) {
    const snap = await db.collection("stories").orderBy("publishedAt", "desc").limit(40).get();
    return new Response(JSON.stringify({
      ok: true,
      stories: snap.docs.map((d) => ({
        id: d.id,
        headline: d.data().headline,
        category: d.data().category,
        sourceName: d.data().sourceName,
        original: d.data().original === true,
      })),
    }), { status: 200 });
  }

  // Utah events calendar
  if (body.events) {
    await db.collection("site").doc("events").set({
      events: (body.events || []).slice(0, 30).map((e) => ({
        name: String(e.name || "").slice(0, 120),
        promotion: String(e.promotion || "").slice(0, 60),
        venue: String(e.venue || "").slice(0, 120),
        city: String(e.city || "").slice(0, 60),
        date: String(e.date || "").slice(0, 40),
        note: String(e.note || "").slice(0, 200),
        link: String(e.link || "").slice(0, 300),
      })),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, saved: body.events.length }), { status: 200 });
  }

  if (body.getEvents) {
    const snap = await db.collection("site").doc("events").get();
    return new Response(JSON.stringify({ ok: true, events: (snap.data() || {}).events || [] }), { status: 200 });
  }

  if (body.getPicks) {
    const snap = await db.collection("site").doc("picks").get();
    return new Response(JSON.stringify({ ok: true, picks: (snap.data() || {}).picks || [] }), { status: 200 });
  }

  // Read back subscriber count + list for export
  if (body.listSubscribers) {
    const snap = await db.collection("subscribers").orderBy("createdAt", "desc").limit(500).get();
    const emails = snap.docs.map((d) => d.data().email);
    return new Response(JSON.stringify({ ok: true, count: emails.length, emails }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: "Nothing to do" }), { status: 400 });
}
