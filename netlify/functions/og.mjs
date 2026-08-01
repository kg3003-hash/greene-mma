// GREENE MMA — per-story share cards at /og/:id.jpg
//
// The card itself is rendered in the Studio at publish time (canvas, same
// design language as the site) and stored on the story document, so this
// function only decodes it and hands it back. No image libraries, no object
// storage (JPEG — the card has a gradient, so PNG would be ~6x heavier).
// Stories published before cards existed fall back to the house
// share card, so a link never unfurls broken.
//
// Env: FIREBASE_SERVICE_ACCOUNT

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const FALLBACK = "https://mma.greene.bet/assets/share-card.png";

export default async function handler(req, context) {
  // Same belt-and-braces param read as /s/:id — fall back to the path and
  // drop the .jpg the route pattern would otherwise leave attached.
  const id = String(
    (context && context.params && context.params.id) ||
    (new URL(req.url).pathname.split("/").filter(Boolean).pop() || "").replace(/\.jpg$/i, ""),
  ).slice(0, 200);
  if (!id) return Response.redirect(FALLBACK, 302);

  try {
    const snap = await db.collection("stories").doc(id).get();
    const card = snap.exists ? snap.data().ogCard : null;
    if (!card) return Response.redirect(FALLBACK, 302);

    const bytes = Buffer.from(card, "base64");
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(bytes.length),
        // Cards are immutable once published; let the scrapers keep them.
        "cache-control": "public, max-age=86400, s-maxage=604800",
      },
    });
  } catch (e) {
    return Response.redirect(FALLBACK, 302);
  }
}

export const config = { path: "/og/:id.jpg" };
