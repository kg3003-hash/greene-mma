// GREENE MMA — Site data
// Two jobs:
//   POST /site  (with x-studio-key)  → save your written picks
//   POST /site  {subscribe:"a@b.com"} → newsletter capture, no key needed
//
// Env: STUDIO_KEY, FIREBASE_SERVICE_ACCOUNT

import admin from "firebase-admin";
import { rebuildStoryIndexes } from "./lib/story-indexes.mjs";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const isEmail = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

// A story is a Utah story if the flag is set, OR the category is Utah, OR it
// carries the Utah tag. Writers kept picking Category: Utah and leaving the
// "Utah story?" dropdown on No — all three now mean the same thing.
const isUtahStory = (d) =>
  d.utah === true ||
  String(d.category || "").trim().toLowerCase() === "utah" ||
  (Array.isArray(d.tags) && d.tags.includes("Utah"));

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

  // ---- Identity ----
  // ADMIN  = STUDIO_KEY   (full control)
  // WRITER = WRITER_KEY   (drafts only, and only their own)
  const key = req.headers.get("x-studio-key") || "";
  let role = null;
  if (process.env.STUDIO_KEY && key === process.env.STUDIO_KEY) role = "admin";
  else if (process.env.WRITER_KEY && key === process.env.WRITER_KEY) role = "writer";

  if (!role) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  if (body.ping) {
    return new Response(JSON.stringify({ ok: true, role }), { status: 200 });
  }

  const isAdmin = role === "admin";
  const deny = () =>
    new Response(JSON.stringify({ error: "Your account cannot do that." }), { status: 403 });

  // ================= DRAFTS (writer + admin) =================
  // A writer may create, edit, list and delete ONLY their own drafts.
  // Only an admin can publish one.
  if (body.saveDraft) {
    const d = body.saveDraft;
    if (!d.headline || !d.body) {
      return new Response(JSON.stringify({ error: "Headline and body are required." }), { status: 400 });
    }
    const id = d.id || "draft-" + Date.now();
    const existing = await db.collection("drafts").doc(id).get();
    if (existing.exists && !isAdmin && existing.data().authorRole !== "writer") return deny();
    await db.collection("drafts").doc(id).set({
      headline: String(d.headline).slice(0, 160),
      summary: String(d.summary || "").slice(0, 400),
      body: String(d.body).slice(0, 20000),
      category: String(d.category || "The Corner").slice(0, 40),
      tags: Array.isArray(d.tags) ? d.tags.slice(0, 6).map((t) => String(t).slice(0, 24)) : [],
      utah: isUtahStory(d),
      author: String(d.author || (isAdmin ? "Greene MMA" : "Staff writer")).slice(0, 60),
      authorRole: isAdmin ? "admin" : "writer",
      status: d.submit ? "submitted" : "draft",
      note: String(d.note || "").slice(0, 400),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: existing.exists
        ? existing.data().createdAt
        : admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return new Response(JSON.stringify({ ok: true, id, status: d.submit ? "submitted" : "draft" }), { status: 200 });
  }

  if (body.listDrafts) {
    let q = db.collection("drafts").orderBy("updatedAt", "desc").limit(60);
    const snap = await q.get();
    let rows = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
    if (!isAdmin) rows = rows.filter((r) => r.authorRole === "writer");
    return new Response(JSON.stringify({
      ok: true,
      drafts: rows.map((r) => ({
        id: r.id, headline: r.headline, summary: r.summary, body: r.body,
        category: r.category, tags: r.tags || [], utah: r.utah === true,
        author: r.author, status: r.status, note: r.note || "",
      })),
    }), { status: 200 });
  }

  if (body.deleteDraft) {
    const ref = db.collection("drafts").doc(String(body.deleteDraft));
    const snap = await ref.get();
    if (!snap.exists) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (!isAdmin && snap.data().authorRole !== "writer") return deny();
    await ref.delete();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  // Admin only: turn a draft into a live story
  if (body.publishDraft) {
    if (!isAdmin) return deny();
    const ref = db.collection("drafts").doc(String(body.publishDraft));
    const snap = await ref.get();
    if (!snap.exists) return new Response(JSON.stringify({ error: "Draft not found." }), { status: 404 });
    const d = snap.data();
    const slug = String(d.headline).toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "").slice(0, 60) || "story-" + Date.now();
    await db.collection("stories").doc("gm-" + slug).set({
      headline: d.headline, summary: d.summary || "", body: d.body,
      category: d.category || "The Corner", tags: d.tags || [],
      sourceName: "Greene MMA", sourceUrl: "", original: true,
      author: d.author || "Greene MMA",
      utah: isUtahStory(d),
      publishedAt: admin.firestore.Timestamp.now(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await ref.delete();
    try { await rebuildStoryIndexes(db); } catch (e) { console.error("Index rebuild failed:", e.message); }
    return new Response(JSON.stringify({ ok: true, id: "gm-" + slug }), { status: 200 });
  }

  // Admin only: send a draft back with a note
  if (body.rejectDraft) {
    if (!isAdmin) return deny();
    await db.collection("drafts").doc(String(body.rejectDraft.id)).set({
      status: "changes requested",
      note: String(body.rejectDraft.note || "").slice(0, 400),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }

  // Everything past this point is admin only
  if (!isAdmin) return deny();

  // ================= SITE COPY =================
  if (body.copy) {
    await db.collection("site").doc("copy").set({
      blocks: body.copy,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (body.getCopy) {
    const snap = await db.collection("site").doc("copy").get();
    return new Response(JSON.stringify({ ok: true, blocks: (snap.data() || {}).blocks || {} }), { status: 200 });
  }

  // ================= PROMOTIONS =================
  if (body.promotions) {
    await db.collection("site").doc("promotions").set({
      promotions: (body.promotions || []).slice(0, 20).map((p) => ({
        name: String(p.name || "").slice(0, 80),
        where: String(p.where || "").slice(0, 100),
        note: String(p.note || "").slice(0, 400),
        link: String(p.link || "").slice(0, 300),
      })),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, saved: body.promotions.length }), { status: 200 });
  }
  if (body.getPromotions) {
    const snap = await db.collection("site").doc("promotions").get();
    return new Response(JSON.stringify({ ok: true, promotions: (snap.data() || {}).promotions || [] }), { status: 200 });
  }

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

  // ================= HOMEPAGE PINS =================
  // Two ordered lists of story ids: "global" leads the Top News column
  // (first pin is the lead story), "utah" leads the Utah Corner rail.
  const readPins = async () => {
    const snap = await db.collection("site").doc("pins").get();
    const d = snap.data() || {};
    return { global: d.global || [], utah: d.utah || [] };
  };
  if (body.pinStory) {
    const id = String(body.pinStory.id || "");
    const slot = body.pinStory.slot === "utah" ? "utah" : "global";
    if (!id) return new Response(JSON.stringify({ error: "No story id." }), { status: 400 });
    const pins = await readPins();
    const other = slot === "utah" ? "global" : "utah";
    pins[other] = pins[other].filter((x) => x !== id);
    pins[slot] = [id, ...pins[slot].filter((x) => x !== id)].slice(0, 6);
    await db.collection("site").doc("pins").set({
      ...pins,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, pins }), { status: 200 });
  }
  if (body.unpinStory) {
    const id = String(body.unpinStory);
    const pins = await readPins();
    pins.global = pins.global.filter((x) => x !== id);
    pins.utah = pins.utah.filter((x) => x !== id);
    await db.collection("site").doc("pins").set({
      ...pins,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true, pins }), { status: 200 });
  }
  if (body.getPins) {
    return new Response(JSON.stringify({ ok: true, pins: await readPins() }), { status: 200 });
  }

  // Load one story for editing
  // Per-story share card. The Studio renders a 1200x630 PNG at publish time
  // and posts it here; /og/:id.png hands it back. Without this every shared
  // link previewed with the same generic house image.
  if (body.setOgCard) {
    if (!isAdmin) return deny();
    const { id, png } = body.setOgCard || {};
    if (!id || !png) {
      return new Response(JSON.stringify({ error: "id and png are required" }), { status: 400 });
    }
    const b64 = String(png).replace(/^data:image\/(jpeg|png);base64,/, "");
    // Firestore caps a document at 1MB and the article body shares the doc,
    // so keep the card well clear of it (a 1200x630 JPEG lands near 100KB).
    if (b64.length > 400000) {
      return new Response(JSON.stringify({ error: "Card image too large" }), { status: 413 });
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      return new Response(JSON.stringify({ error: "Card must be a base64 PNG" }), { status: 400 });
    }
    const ref = db.collection("stories").doc(String(id));
    if (!(await ref.get()).exists) {
      return new Response(JSON.stringify({ error: "Story not found" }), { status: 404 });
    }
    await ref.set({
      ogCard: b64,
      ogCardAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return new Response(JSON.stringify({ ok: true, id, bytes: b64.length }), { status: 200 });
  }

  // Stories missing a share card — powers the Studio's backfill button.
  if (body.storiesWithoutCard) {
    if (!isAdmin) return deny();
    const snap = await db.collection("stories")
      .orderBy("publishedAt", "desc").limit(60).get();
    const list = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((s) => !s.ogCard)
      .map((s) => ({
        id: s.id, headline: s.headline || "", category: s.category || "",
        original: !!s.original, author: s.author || "", sourceName: s.sourceName || "",
      }));
    return new Response(JSON.stringify({ ok: true, stories: list }), { status: 200 });
  }

  if (body.getStory) {    const snap = await db.collection("stories").doc(String(body.getStory)).get();
    if (!snap.exists) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    return new Response(JSON.stringify({ ok: true, story: { id: snap.id, ...snap.data() } }), { status: 200 });
  }

  // Publish an original article, or update one that already exists
  if (body.article) {
    const a = body.article;
    if (!a.headline || !a.body) {
      return new Response(JSON.stringify({ error: "Headline and body are required." }), { status: 400 });
    }
    const slug = String(a.headline)
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
      || "story-" + Date.now();
    // Keep the original id when editing so the URL never changes
    const id = a.id || `gm-${slug}`;
    // keepDate only makes sense when the story already has a date. A story
    // written without publishedAt vanishes from every orderBy feed and
    // crashes the story page, so never allow that state to exist.
    let keepDate = false;
    if (a.keepDate) {
      const prev = await db.collection("stories").doc(id).get();
      keepDate = prev.exists && !!prev.data().publishedAt;
    }
    await db.collection("stories").doc(id).set({
      headline: String(a.headline).slice(0, 160),
      summary: String(a.summary || "").slice(0, 400),
      body: String(a.body).slice(0, 20000),
      category: String(a.category || "The Corner").slice(0, 40),
      tags: Array.isArray(a.tags) ? a.tags.slice(0, 6).map((t) => String(t).slice(0, 24)) : [],
      sourceName: "Greene MMA",
      sourceUrl: "",
      original: true,
      author: String(a.author || "Greene MMA").slice(0, 60),
      utah: isUtahStory(a),
      ...(keepDate ? {} : { publishedAt: admin.firestore.Timestamp.now() }),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    try { await rebuildStoryIndexes(db); } catch (e) { console.error("Index rebuild failed:", e.message); }
    return new Response(JSON.stringify({ ok: true, id }), { status: 200 });
  }

  // Rebuild the originals/Utah index docs on demand (also runs automatically
  // after every publish, delete, and bot run — this is the manual override).
  if (body.rebuildIndexes) {
    const counts = await rebuildStoryIndexes(db);
    return new Response(JSON.stringify({ ok: true, ...counts }), { status: 200 });
  }

  // Delete a story (cleaning up stray wrestling items, bad rewrites, etc.)
  if (body.deleteStory) {
    const id = String(body.deleteStory);
    await db.collection("stories").doc(id).delete();
    // keep the pin lists clean — a deleted story can't stay pinned
    try {
      const pins = await readPins();
      if (pins.global.includes(id) || pins.utah.includes(id)) {
        await db.collection("site").doc("pins").set({
          global: pins.global.filter((x) => x !== id),
          utah: pins.utah.filter((x) => x !== id),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (e) { /* pins doc may not exist yet */ }
    try { await rebuildStoryIndexes(db); } catch (e) { console.error("Index rebuild failed:", e.message); }
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
      sortDate: String(body.card.sortDate || "").slice(0, 20),
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

  // Sponsor slots — small "presented by" placements
  if (body.sponsors) {
    const clean = (x) => ({
      name: String((x && x.name) || "").slice(0, 80),
      link: String((x && x.link) || "").slice(0, 300),
    });
    await db.collection("site").doc("sponsors").set({
      localcard: clean(body.sponsors.localcard),
      fightweek: clean(body.sponsors.fightweek),
      newsletter: clean(body.sponsors.newsletter),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (body.getSponsors) {
    const snap = await db.collection("site").doc("sponsors").get();
    return new Response(JSON.stringify({ ok: true, sponsors: snap.data() || {} }), { status: 200 });
  }

  // Rankings — your own Utah top-tens
  if (body.rankings) {
    // Keep the last published order per division so the public pages can show
    // movement (▲▼ / NEW). The baseline only advances when the order actually
    // changes — editing a note must not silently wipe the arrows.
    const prevSnap = await db.collection("site").doc("rankings").get();
    const prevByName = new Map(
      ((prevSnap.data() || {}).divisions || []).map((d) => [d.name, d]),
    );
    await db.collection("site").doc("rankings").set({
      divisions: (body.rankings || []).slice(0, 15).map((d) => {
        const name = String(d.name || "").slice(0, 60);
        const fighters = (d.fighters || []).slice(0, 15).map((f) => String(f).trim().slice(0, 80));
        const old = prevByName.get(name) || {};
        const oldFighters = old.fighters || [];
        const moved = oldFighters.length !== fighters.length
          || oldFighters.some((n, i) => n !== fighters[i]);
        return {
          name,
          note: String(d.note || "").slice(0, 200),
          fighters,
          prev: moved ? oldFighters : (old.prev || oldFighters),
        };
      }),
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
        first: String(f.first || "").trim().slice(0, 40),
        last: String(f.last || "").trim().slice(0, 40),
        nickname: String(f.nickname || "").trim().slice(0, 60),
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
