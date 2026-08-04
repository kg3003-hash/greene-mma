// GREENE MMA — Odds puller
// Pulls upcoming MMA bouts + moneylines from The Odds API and writes them to
// Firestore, where the homepage reads them. Runs on a schedule; can also be
// triggered manually.
//
// Env: ODDS_API_KEY, FIREBASE_SERVICE_ACCOUNT

import admin from "firebase-admin";
import { dayKey, applyEdits, rebuildDerived } from "./lib/cardedits.mjs";

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

/* ---- hand-set fight order (site/cardorder), re-applied on every sync ----
   The feed has no idea which bout is the main event; we guess from start
   times, and that guess is often wrong. When the Studio corrects a card it
   stores the order as a list of bout keys, which this run re-applies — so a
   correction sticks instead of being flattened by the next pull.
   The key is the two names sorted, because a favourite can become the dog
   between syncs and that must not change a bout's identity.
   (Kept in step with the copy in site.mjs.) */
const boutKey = (n1, n2) =>
  [n1, n2]
    .map((s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .sort()
    .join("|");
const oddsBoutKey = (b) => boutKey(b && b.favourite && b.favourite.name, b && b.underdog && b.underdog.name);
// Bouts named in `order` lead, in that order; anything new keeps its own
// relative position behind them rather than silently jumping to the top.
function applyOrder(bouts, order) {
  if (!Array.isArray(order) || !order.length || !Array.isArray(bouts)) return bouts;
  const rank = new Map(order.map((k, i) => [k, i]));
  return bouts
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      const rx = rank.has(oddsBoutKey(x.b)) ? rank.get(oddsBoutKey(x.b)) : Infinity;
      const ry = rank.has(oddsBoutKey(y.b)) ? rank.get(oddsBoutKey(y.b)) : Infinity;
      return rx === ry ? x.i - y.i : rx - ry;
    })
    .map((x) => x.b);
}

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

  // Group into separate cards by the day in UTAH, not UTC — a Saturday card's
  // early prelims start before midnight UTC and the rest after, and grouping
  // on the ISO string split every such event in two: one phantom "card"
  // holding just the first fight of the night. A UFC event and a regional
  // show on the same weekend still land on different days and stay separate.
  const byDay = new Map();
  for (const b of bouts) {
    const key = dayKey(b.startTime);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(b);
  }

  // Any order set by hand in the Studio wins over the start-time guess below.
  let savedOrders = {};
  try {
    savedOrders = ((await db.collection("site").doc("cardorder").get()).data() || {}).orders || {};
  } catch (e) {
    console.warn("cardorder read failed, falling back to start times:", e.message);
  }
  // Corrections made in the Studio's card editor — cancelled bouts, moved
  // fights, fixed names. Applied on every sync so they survive the rebuild.
  let cardEdits = {};
  try {
    cardEdits = (await db.collection("site").doc("cardedits").get()).data() || {};
  } catch (e) {
    console.warn("cardedits read failed, publishing uncorrected:", e.message);
  }

  let cards = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([date, list]) => {
      // Main event first. Where start times differ the main event is latest;
      // where they are identical we keep the order the book returned.
      const guessed = [...list].sort(
        (x, y) => new Date(y.startTime) - new Date(x.startTime)
      );
      return { date, startTime: guessed[guessed.length - 1].startTime, bouts: guessed };
    });

  // Corrections first (membership), then per-card order (arrangement).
  // Orders saved before the Utah-day change were keyed by the UTC date, which
  // for a US main card is one day later — accept either key so old fixes hold.
  cards = applyEdits(cards, cardEdits).map((c) => {
    const utc = new Date(c.startTime).toISOString().slice(0, 10);
    const ordered = applyOrder(c.bouts, savedOrders[c.date] || savedOrders[utc]);
    return { ...c, bouts: ordered.slice(0, 16), boutCount: ordered.length };
  });

  await db.collection("site").doc("fightweek").set({
    ...rebuildDerived(cards),
    cards,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`Wrote ${cards.length} card(s), ${bouts.length} bouts.`);
  return new Response(
    JSON.stringify({ cards: cards.length, bouts: bouts.length, remaining }),
    { status: 200 }
  );
}

// Twice a day. The free tier has a monthly credit budget and odds don't move
// fast enough to justify more. ~60 credits a month at this rate.
export const config = { schedule: "0 14,23 * * *" };
