// GREENE MMA — Story sitemap at /sitemap-stories.xml
//
// The static sitemap.xml covers the site's fixed pages. This one covers the
// story pages that matter for search: every original article plus the Utah
// wire coverage, served from the two index docs (one read each, no scans).
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

export default async function handler() {
  const seen = new Set();
  const rows = [];
  for (const docId of ["originals", "utahwire"]) {
    try {
      const snap = await db.collection("site").doc(docId).get();
      for (const s of (snap.data() || {}).stories || []) {
        if (!s.id || seen.has(s.id)) continue;
        seen.add(s.id);
        const pub = s.publishedAt && s.publishedAt.toDate ? s.publishedAt.toDate() : null;
        rows.push(`  <url><loc>${SITE}/s/${encodeURIComponent(s.id)}</loc>${
          pub ? `<lastmod>${pub.toISOString().slice(0, 10)}</lastmod>` : ""
        }</url>`);
      }
    } catch (e) {
      console.error(`Sitemap read failed (${docId}):`, e.message);
    }
  }

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

export const config = { path: "/sitemap-stories.xml" };
