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
      tags: Array.isArray(a.tags) ? a.tags.slice(0, 6).map((t) => String(t).slice(0, 24)) : [],
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

  // Gym directory (sponsors + local gyms)
  if (body.gyms) {
    await db.collection("site").doc("gyms").set({
      gyms: (body.gyms || []).slice(0, 60).map((g) => ({
        name: String(g.name || "").slice(0, 120),
        city: String(g.city || "").slice(0, 60),
        disciplines: String(g.disciplines || "").slice(0, 120),
        note: String(g.note || "").slice(0, 260),
        link: String(g.link || "").slice(0, 300),
        featured: g.featured === true,
      })),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, saved: body.gyms.length }), { status: 200 });
  }
  if (body.getGyms) {
    const snap = await db.collection("site").doc("gyms").get();
    return new Response(JSON.stringify({ ok: true, gyms: (snap.data() || {}).gyms || [] }), { status: 200 });
  }

  // Paste a fight card in any format -> structured bouts
  if (body.parseCard) {
    const PROMPT = `You extract structured fight card data from pasted text.

The text may be copied from a promotion's social post, a listing site, a press
release, or typed by hand. It will list bouts on a single MMA event.

Return ONLY valid JSON, no markdown fences:
{
  "event": "event name if present, else empty string",
  "date": "date as written if present, else empty string",
  "venue": "venue and city if present, else empty string",
  "bouts": [
    {
      "weight": "weight class if present",
      "a": {"first":"","last":"","nickname":"","record":"","gym":"","odds":""},
      "b": {"first":"","last":"","nickname":"","record":"","gym":"","odds":""}
    }
  ]
}

Rules:
- List bouts in the order given. Main event first if the text indicates one.
- Only fill a field if it is actually present in the text. Never guess a record,
  gym, or odds. Empty string is correct when unknown.
- Split names into first and last as best you can. Single-word names go in "last".
- Do not invent bouts. If the text has three fights, return three.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        system: PROMPT,
        messages: [{ role: "user", content: String(body.parseCard).slice(0, 8000) }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return new Response(JSON.stringify({ error: `Anthropic API ${res.status}: ${detail.slice(0, 200)}` }), { status: 502 });
    }
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || "").join("")
      .replace(/```json|```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return new Response(JSON.stringify({ error: "Could not read that card." }), { status: 422 }); }
    return new Response(JSON.stringify({ ok: true, card: parsed }), { status: 200 });
  }

  // Save a parsed card so the Card Studio can load bouts from it
  if (body.card) {
    await db.collection("site").doc("localcard").set({
      event: String(body.card.event || "").slice(0, 120),
      date: String(body.card.date || "").slice(0, 60),
      venue: String(body.card.venue || "").slice(0, 120),
      bouts: (body.card.bouts || []).slice(0, 20),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, bouts: (body.card.bouts || []).length }), { status: 200 });
  }
  if (body.getCard) {
    const snap = await db.collection("site").doc("localcard").get();
    return new Response(JSON.stringify({ ok: true, card: snap.data() || null }), { status: 200 });
  }

  // Human names for the auto-detected cards (odds feed has no event names)
  if (body.cardNames) {
    await db.collection("site").doc("cardnames").set({
      names: body.cardNames,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (body.getCardNames) {
    const snap = await db.collection("site").doc("cardnames").get();
    return new Response(JSON.stringify({ ok: true, names: (snap.data() || {}).names || {} }), { status: 200 });
  }

  // Rankings — your own Utah top-tens
  if (body.rankings) {
    await db.collection("site").doc("rankings").set({
      divisions: (body.rankings || []).slice(0, 15).map((d) => ({
        name: String(d.name || "").slice(0, 60),
        note: String(d.note || "").slice(0, 200),
        fighters: (d.fighters || []).slice(0, 15).map((f) => String(f).slice(0, 80)),
      })),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, saved: body.rankings.length }), { status: 200 });
  }
  if (body.getRankings) {
    const snap = await db.collection("site").doc("rankings").get();
    return new Response(JSON.stringify({ ok: true, divisions: (snap.data() || {}).divisions || [] }), { status: 200 });
  }

  // Legends — the pioneers section
  if (body.legends) {
    await db.collection("site").doc("legends").set({
      legends: (body.legends || []).slice(0, 12).map((l) => ({
        name: String(l.name || "").slice(0, 80),
        tag: String(l.tag || "").slice(0, 60),
        years: String(l.years || "").slice(0, 40),
        record: String(l.record || "").slice(0, 40),
        gym: String(l.gym || "").slice(0, 80),
        body: String(l.body || "").slice(0, 2000),
        notes: (l.notes || []).slice(0, 6).map((n) => String(n).slice(0, 120)),
      })),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, saved: body.legends.length }), { status: 200 });
  }
  if (body.getLegends) {
    const snap = await db.collection("site").doc("legends").get();
    return new Response(JSON.stringify({ ok: true, legends: (snap.data() || {}).legends || [] }), { status: 200 });
  }

  // Utah fighter roster
  if (body.fighters || body.addFighters) {
    const incoming = body.fighters || body.addFighters || [];
    const slug = (f) => (String(f.first || "") + "-" + String(f.last || ""))
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    let merged = incoming;
    if (body.addFighters) {
      // merge into whatever is already saved, newest details win
      const snap = await db.collection("site").doc("fighters").get();
      const current = (snap.data() || {}).fighters || [];
      const bySlug = new Map(current.map((f) => [slug(f), f]));
      for (const f of incoming) {
        const k = slug(f);
        if (!k || k === "-") continue;
        const prev = bySlug.get(k) || {};
        // only overwrite fields that actually have a value
        const next = { ...prev };
        for (const [key, val] of Object.entries(f)) {
          if (val !== "" && val !== undefined && val !== null) next[key] = val;
        }
        bySlug.set(k, next);
      }
      merged = [...bySlug.values()];
    } else {
      // straight save — still dedupe so the editor can't create twins
      const bySlug = new Map();
      for (const f of incoming) {
        const k = slug(f);
        if (!k || k === "-") continue;
        bySlug.set(k, { ...(bySlug.get(k) || {}), ...f });
      }
      merged = [...bySlug.values()];
    }

    await db.collection("site").doc("fighters").set({
      fighters: merged.slice(0, 300).map((f) => ({
        slug: slug(f),
        first: String(f.first || "").slice(0, 40),
        last: String(f.last || "").slice(0, 40),
        nickname: String(f.nickname || "").slice(0, 60),
        record: String(f.record || "").slice(0, 20),
        weight: String(f.weight || "").slice(0, 40),
        gym: String(f.gym || "").slice(0, 80),
        city: String(f.city || "").slice(0, 60),
        status: String(f.status || "Active").slice(0, 30),
        next: String(f.next || "").slice(0, 140),
        note: String(f.note || "").slice(0, 300),
        social: String(f.social || "").slice(0, 80),
        stance: String(f.stance || "").slice(0, 20),
        height: String(f.height || "").slice(0, 20),
        reach: String(f.reach || "").slice(0, 20),
        age: String(f.age || "").slice(0, 10),
        slpm: String(f.slpm || "").slice(0, 10),
        strAcc: String(f.strAcc || "").slice(0, 10),
        sapm: String(f.sapm || "").slice(0, 10),
        strDef: String(f.strDef || "").slice(0, 10),
        tdAvg: String(f.tdAvg || "").slice(0, 10),
        tdAcc: String(f.tdAcc || "").slice(0, 10),
        tdDef: String(f.tdDef || "").slice(0, 10),
        subAvg: String(f.subAvg || "").slice(0, 10),
        pro: f.pro !== false,
      })),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, saved: merged.length }), { status: 200 });
  }

  if (body.getFighters) {
    const snap = await db.collection("site").doc("fighters").get();
    return new Response(JSON.stringify({ ok: true, fighters: (snap.data() || {}).fighters || [] }), { status: 200 });
  }

  // Newsletter issues — written in the studio, archived on the site
  if (body.issue) {
    const i = body.issue;
    if (!i.subject || !i.body) {
      return new Response(JSON.stringify({ error: "Subject and body are required." }), { status: 400 });
    }
    const id = i.id || "issue-" + Date.now();
    await db.collection("issues").doc(id).set({
      subject: String(i.subject).slice(0, 160),
      preview: String(i.preview || "").slice(0, 300),
      body: String(i.body).slice(0, 40000),
      sent: i.sent === true,
      publishedAt: admin.firestore.Timestamp.now(),
    }, { merge: true });
    return new Response(JSON.stringify({ ok: true, id }), { status: 200 });
  }

  // Delete a newsletter issue
  if (body.deleteIssue) {
    await db.collection("issues").doc(String(body.deleteIssue)).delete();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (body.listIssues) {
    const snap = await db.collection("issues").orderBy("publishedAt", "desc").limit(60).get();
    return new Response(JSON.stringify({ ok: true, issues: snap.docs.map((d) => ({
      id: d.id, subject: d.data().subject,
      date: d.data().publishedAt ? d.data().publishedAt.toDate().toISOString().slice(0,10) : ""
    })) }), { status: 200 });
  }
  // Remove a subscriber
  if (body.deleteSubscriber) {
    await db.collection("subscribers").doc(String(body.deleteSubscriber).toLowerCase()).delete();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
    const snap = await db.collection("subscribers").orderBy("createdAt", "desc").limit(2000).get();
    const rows = snap.docs.map((d) => {
      const v = d.data();
      const when = v.createdAt && v.createdAt.toDate ? v.createdAt.toDate().toISOString() : "";
      return { email: v.email, source: v.source || "", createdAt: when };
    });
    return new Response(JSON.stringify({ ok: true, count: rows.length, rows }), { status: 200 });
  }

  return new Response(JSON.stringify({ error: "Nothing to do" }), { status: 400 });
}
