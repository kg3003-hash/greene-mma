// Shared helper — NOT a function endpoint (lives in lib/ so Netlify skips it).
//
// The public pages used to find original + Utah stories by pulling the newest
// 30-60 stories and filtering in the browser. The news bot publishes enough
// volume that anything older than a few hours fell out of that window, so
// original articles vanished from every feed.
//
// Fix: keep two small "index docs" in the site collection that always hold
// the newest originals and Utah stories, regardless of how much wire content
// has been published on top of them. Pages read them in one cheap doc read.
// Equality-only queries here need no composite Firestore index.

const pick = (id, v) => ({
  id,
  headline: v.headline || "",
  summary: v.summary || "",
  category: v.category || "News",
  sourceName: v.sourceName || "",
  sourceUrl: v.sourceUrl || "",
  author: v.author || "",
  original: v.original === true,
  utah: v.utah === true,
  tags: Array.isArray(v.tags) ? v.tags : [],
  publishedAt: v.publishedAt || null,
});

const newestFirst = (a, b) =>
  (b.publishedAt && b.publishedAt.toMillis ? b.publishedAt.toMillis() : 0) -
  (a.publishedAt && a.publishedAt.toMillis ? a.publishedAt.toMillis() : 0);

export async function rebuildStoryIndexes(db) {
  const oSnap = await db.collection("stories").where("original", "==", true).get();
  const originals = oSnap.docs.map((d) => pick(d.id, d.data()))
    .filter((s) => s.publishedAt).sort(newestFirst).slice(0, 30);

  const uSnap = await db.collection("stories").where("utah", "==", true).get();
  const utah = uSnap.docs.map((d) => pick(d.id, d.data()))
    .filter((s) => s.publishedAt).sort(newestFirst).slice(0, 24);

  await db.collection("site").doc("originals").set({ stories: originals, updatedAt: new Date() });
  await db.collection("site").doc("utahwire").set({ stories: utah, updatedAt: new Date() });
  return { originals: originals.length, utah: utah.length };
}
