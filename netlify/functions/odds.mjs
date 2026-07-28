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
    const outOfCredits = detail.includes("OUT_OF_USAGE_CREDITS");
    console.error(
      outOfCredits
        ? "Odds API is out of monthly credits — leaving existing fight week data in place. " +
          "Use a separate API key for this site, or wait for the monthly reset."
        : `Odds API error ${res.status}: ${detail.slice(0, 300)}`
    );
    // Important: return WITHOUT writing. Whatever is already in Firestore stays,
    // so the site keeps showing the last known card instead of going blank.
    return new Response(
      JSON.stringify({ error: outOfCredits ? "out_of_credits" : `Odds API ${res.status}` }),
      { status: 502 }
    );
  }

  const events = await res.json();
  const remaining = res.headers.get("x-requests-remaining");
  console.log(`Odds API ok — ${events.length} events, ${remaining} credits left this month`);
  if (remaining !== null && Number(remaining) < 40) {
    console.warn(`Only ${remaining} credits left. Consider a separate key for this site.`);
  }

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

  // Group into separate cards by date — a UFC event and a regional show on the
  // same weekend are different cards and should not be merged.
  const byDay = new Map();
  for (const b of bouts) {
    const key = new Date(b.startTime).toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(b);
  }

  const cards = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([date, list]) => {
      // Main event first. Where start times differ the main event is latest;
      // where they are identical we keep the order the book returned.
      const ordered = [...list].sort(
        (x, y) => new Date(y.startTime) - new Date(x.startTime)
      );
      return {
        date,
        startTime: ordered[ordered.length - 1].startTime,
        bouts: ordered.slice(0, 16),
        boutCount: ordered.length,
      };
    });

  const headlineCard = cards[0] || null;
  const headline = headlineCard ? headlineCard.bouts[0] : null;

  // Biggest underdogs across every upcoming card
  const dogs = bouts
    .filter((b) => b.underdog.odds > 100)
    .sort((x, y) => y.underdog.odds - x.underdog.odds)
    .slice(0, 4);

  await db.collection("site").doc("fightweek").set({
    headline,
    cards,
    card: headlineCard ? headlineCard.bouts : [],
    dogs,
    boutCount: headlineCard ? headlineCard.boutCount : 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`Wrote ${cards.length} card(s), ${bouts.length} bouts, ${dogs.length} dogs.`);
  return new Response(
    JSON.stringify({ cards: cards.length, bouts: bouts.length, dogs: dogs.length, remaining }),
    { status: 200 }
  );
}

// Twice a day. The free tier has a monthly credit budget and odds don't move
// fast enough to justify more. ~60 credits a month at this rate.
export const config = { schedule: "0 14,23 * * *" };
