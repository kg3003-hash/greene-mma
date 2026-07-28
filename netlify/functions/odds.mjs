// GREENE MMA — Odds puller
// Pulls upcoming MMA bouts + moneylines from The Odds API and writes them to
// Firestore, where the homepage reads them. Runs on a schedule; can also be
// triggered manually.
//
// Env: ODDS_API_KEY, FIREBASE_SERVICE_ACCOUNT

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const SPORT = "mma_mixed_martial_arts";
const API = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/`;

// American odds -> implied probability, used to decide who's the dog
const implied = (odds) => (odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100));

export default async function handler() {
  if (!process.env.ODDS_API_KEY) {
    return new Response(JSON.stringify({ error: "ODDS_API_KEY not set" }), { status: 500 });
  }

  const url = `${API}?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Odds API error", res.status, detail.slice(0, 300));
    return new Response(JSON.stringify({ error: `Odds API ${res.status}` }), { status: 502 });
  }

  const events = await res.json();
  const remaining = res.headers.get("x-requests-remaining");
  console.log(`Odds API ok — ${events.length} events, ${remaining} requests left this month`);

  const now = Date.now();
  const bouts = [];

  for (const ev of events) {
    const start = new Date(ev.commence_time);
    if (start.getTime() < now) continue; // skip anything already started

    // Take the first bookmaker offering a head-to-head market
    const book = (ev.bookmakers || []).find((b) =>
      (b.markets || []).some((m) => m.key === "h2h")
    );
    if (!book) continue;
    const market = book.markets.find((m) => m.key === "h2h");
    if (!market || (market.outcomes || []).length < 2) continue;

    const [a, b] = market.outcomes;
    const favourite = implied(a.price) >= implied(b.price) ? a : b;
    const underdog = favourite === a ? b : a;

    bouts.push({
      eventName: ev.sport_title || "MMA",
      startTime: start.toISOString(),
      favourite: { name: favourite.name, odds: favourite.price },
      underdog: { name: underdog.name, odds: underdog.price },
      book: book.title || "",
    });
  }

  // Soonest first
  bouts.sort((x, y) => new Date(x.startTime) - new Date(y.startTime));

  // The next card = every bout sharing the soonest date
  const headline = bouts[0] || null;
  const sameDay = headline
    ? bouts.filter(
        (b) =>
          new Date(b.startTime).toDateString() ===
          new Date(headline.startTime).toDateString()
      )
    : [];

  // Biggest underdogs on that card become the Live Dogs
  const dogs = [...sameDay]
    .filter((b) => b.underdog.odds > 100)
    .sort((x, y) => y.underdog.odds - x.underdog.odds)
    .slice(0, 3);

  await db.collection("site").doc("fightweek").set({
    headline,
    card: sameDay.slice(0, 8),
    dogs,
    boutCount: sameDay.length,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`Wrote fight week: ${sameDay.length} bouts, ${dogs.length} dogs.`);
  return new Response(
    JSON.stringify({ bouts: sameDay.length, dogs: dogs.length, remaining }),
    { status: 200 }
  );
}

// Every 6 hours — odds don't move fast enough to justify more, and the free
// tier has a monthly request budget.
export const config = { schedule: "0 */6 * * *" };
