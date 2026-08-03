// GREENE MMA — Fighter sitemap at /sitemap-fighters.xml
//
// One entry per profile served by fighter-page.mjs. Without this the roster is
// only reachable by crawling fighters.html, which builds its list in the
// browser — so in practice these pages were never getting found at all.
//
// Deliberately not every row: a profile with no record and no ranking is a
// name and nothing else, and asking Google to index seventy of those invites
// a thin-content judgement on the whole section. Earn the listing first.
//
// Env: FIREBASE_SERVICE_ACCOUNT

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const SITE = "https://greenemma.com";
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fullName = (f) => [f.first, f.last].filter(Boolean).join(" ").trim();

export default async function handler() {
  let roster = [], divisions = [];
  try {
    const [fSnap, rSnap] = await Promise.all([
      db.collection("site").doc("fighters").get(),
      db.collection("site").doc("rankings").get(),
    ]);
    roster = (fSnap.data() || {}).fighters || [];
    divisions = (rSnap.data() || {}).divisions || [];
  } catch (e) {
    console.error("Fighter sitemap read failed:", e.message);
  }

  // Anyone who appears in the rankings is worth a page regardless of how much
  // of their row is filled in.
  const ranked = new Set();
  divisions.forEach((d) => (d.fighters || []).forEach((entry) => {
    ranked.add(String(entry).replace(/"[^"]*"/g, " ").replace(/\s+/g, " ").trim().toLowerCase());
  }));

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set();
  const rows = [];
  let skipped = 0;

  for (const f of roster) {
    const name = fullName(f);
    const slug = f.slug || slugify(name);
    if (!slug || seen.has(slug)) continue;

    const isRanked = [...ranked].some((r) => r && (r === name.toLowerCase() || r.includes(name.toLowerCase())));
    const worthIndexing = isRanked || (f.record && String(f.record).trim()) ||
      (f.next && String(f.next).trim()) || (f.note && String(f.note).trim());
    if (!worthIndexing) { skipped++; continue; }

    seen.add(slug);
    // Ranked fighters and anyone with a fight booked are the pages most likely
    // to be searched, so they get the higher priority.
    const priority = isRanked ? "0.8" : f.next ? "0.7" : "0.5";
    rows.push(`  <url><loc>${SITE}/f/${encodeURIComponent(slug)}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${priority}</priority></url>`);
  }

  console.log(`Fighter sitemap: ${rows.length} listed, ${skipped} too sparse to list.`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.join("\n")}
</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

export const config = { path: "/sitemap-fighters.xml" };
