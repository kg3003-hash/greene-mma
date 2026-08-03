// GREENE MMA — RSS feed of ORIGINAL articles at /feed.xml
//
// The site consumes a dozen feeds but never emitted one. This is how local
// aggregators, Google News, and other Utah media pick up Greene MMA's own
// reporting. Wire rewrites are deliberately excluded — the feed is only the
// work worth syndicating.
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

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default async function handler() {
  let stories = [];
  try {
    // The originals index doc is maintained by every publish and bot run.
    const snap = await db.collection("site").doc("originals").get();
    stories = ((snap.data() || {}).stories || []).slice(0, 30);
  } catch (e) {
    console.error("Feed read failed:", e.message);
  }

  const items = stories.map((s) => {
    const url = `${SITE}/s/${encodeURIComponent(s.id)}`;
    const pub = s.publishedAt && s.publishedAt.toDate ? s.publishedAt.toDate() : null;
    return `  <item>
    <title>${esc(s.headline)}</title>
    <link>${esc(url)}</link>
    <guid isPermaLink="true">${esc(url)}</guid>
    ${pub ? `<pubDate>${pub.toUTCString()}</pubDate>` : ""}
    ${s.author ? `<dc:creator>${esc(s.author)}</dc:creator>` : ""}
    ${s.category ? `<category>${esc(s.category)}</category>` : ""}
    <description>${esc(s.summary || "")}</description>
  </item>`;
  }).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Greene MMA — Original stories</title>
  <link>${SITE}/</link>
  <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>Original MMA reporting from the Greene corner — Utah fight scene coverage, recaps, and features.</description>
  <language>en-us</language>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=900",
    },
  });
}

export const config = { path: "/feed.xml" };
