// GREENE MMA — Post-fight recap bot
// Runs after fight nights. Gathers results coverage from the wire, then writes
// ONE original roundup article in the brand voice and publishes it as a full
// story page. This is the "who won last night" search traffic play.
//
// Env: ANTHROPIC_API_KEY, FIREBASE_SERVICE_ACCOUNT

import Parser from "rss-parser";
import admin from "firebase-admin";
import { rebuildStoryIndexes } from "./lib/story-indexes.mjs";

const FEEDS = [
  { name: "ESPN MMA", url: "https://www.espn.com/espn/rss/mma/news" },
  { name: "Sherdog", url: "https://www.sherdog.com/rss/news.xml" },
  { name: "Fightful", url: "https://www.fightful.com/rss.xml" },
  { name: "Yahoo MMA", url: "https://sports.yahoo.com/mma/rss/" },
];

// Only items that read like results coverage
const RESULT_HINTS = [
  "result", "results", "recap", "highlights", "defeat", "defeats", "beats",
  "knocks out", "knockout", "submits", "submission", "decision", "finishes",
  "wins", "won", "upset", "scorecard", "bonus", "performance of the night",
  "fight of the night", "post-fight", "octagon", "main event",
];

const BLOCKLIST = [
  "wwe", "aew", "tna", "njpw", "smackdown", "summerslam", "wrestlemania",
  "royal rumble", "survivor series", "nxt", "impact wrestling", "roman reigns",
  "seth rollins", "cody rhodes", "danhausen", "pro wrestling", "wrestler",
];

const LOOKBACK_HOURS = 20;
const MIN_ITEMS = 4; // don't write a recap off two headlines

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const hay = (i) => ((i.title || "") + " " + (i.contentSnippet || "")).toLowerCase();
const hoursAgo = (d) => (Date.now() - d.getTime()) / 36e5;

const RECAP_PROMPT = `You write for Greene MMA, an underdog-focused fight news site.

You are given headlines and snippets from overnight coverage of a fight card.
Write ONE original recap article summarising what happened.

Voice rules:
- Dry, confident, cageside. Short sentences. Specific beats generic.
- ONE smirk maximum across the whole piece. Never hype words like "shocking" or "massive".
- Underdogs and short-notice fighters get the most attention. If a dog won, that leads.
- Write ORIGINAL wording only. Do not copy phrasing from the source headlines. Never quote.
- Only state things clearly supported by the material given. If a detail is unclear,
  leave it out rather than guessing. Never invent a result, round, or method.
- No betting advice, no picks.

Structure the body as 3-6 short paragraphs, blank line between each:
1. What headlined the night and how it ended.
2-4. The results that mattered, grouped sensibly.
5. One paragraph on anyone who helped themselves most.

Respond with ONLY valid JSON, no markdown fences:
{
  "headline": "original headline, max 11 words, names the event if known",
  "summary": "original 2 sentence standfirst, 30-50 words",
  "body": "the article, paragraphs separated by blank lines"
}`;

async function writeRecap(items) {
  const material = items
    .map((i) => `- [${i.sourceName}] ${i.title}\n  ${(i.contentSnippet || "").slice(0, 260)}`)
    .join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1400,
      system: RECAP_PROMPT,
      messages: [{ role: "user", content: `Overnight coverage:\n\n${material}` }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("")
    .replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(text);
  if (!parsed.headline || !parsed.body) throw new Error("Bad recap JSON");
  return parsed;
}

export default async function handler() {
  const parser = new Parser({ timeout: 10000 });
  const items = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items || []) {
        if (!item.title) continue;
        const pub = item.isoDate ? new Date(item.isoDate) : new Date();
        if (hoursAgo(pub) > LOOKBACK_HOURS) continue;
        const h = hay(item);
        if (BLOCKLIST.some((b) => h.includes(b))) continue;
        if (!RESULT_HINTS.some((r) => h.includes(r))) continue;
        items.push({
          title: item.title,
          contentSnippet: item.contentSnippet || item.content || "",
          sourceName: feed.name,
          publishedAt: pub,
        });
      }
    } catch (err) {
      console.error(`Feed failed: ${feed.name}`, err.message);
    }
  }

  if (items.length < MIN_ITEMS) {
    console.log(`Only ${items.length} results items found — no card worth recapping. Skipping.`);
    return new Response(JSON.stringify({ skipped: true, found: items.length }), { status: 200 });
  }

  // Don't publish two recaps for the same night
  const dayId = "recap-" + new Date().toISOString().slice(0, 10);
  const existing = await db.collection("stories").doc(dayId).get();
  if (existing.exists) {
    console.log("Recap already published for today. Skipping.");
    return new Response(JSON.stringify({ skipped: true, reason: "already published" }), { status: 200 });
  }

  items.sort((a, b) => b.publishedAt - a.publishedAt);
  const recap = await writeRecap(items.slice(0, 22));

  const sources = [...new Set(items.map((i) => i.sourceName))];

  await db.collection("stories").doc(dayId).set({
    headline: recap.headline,
    summary: recap.summary,
    body: recap.body + `\n\nReporting from ${sources.join(", ")}.`,
    category: "Results",
    sourceName: "Greene MMA",
    sourceUrl: "",
    original: true,
    utah: false,
    publishedAt: admin.firestore.Timestamp.now(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Recaps are originals — keep the index doc current so they stay visible.
  try { await rebuildStoryIndexes(db); }
  catch (err) { console.error("Index rebuild failed:", err.message); }

  console.log(`Recap published from ${items.length} items: ${recap.headline}`);
  return new Response(JSON.stringify({ ok: true, headline: recap.headline, items: items.length }), { status: 200 });
}

// Sunday 13:00 UTC (~6am Mountain) — the "who won last night" search window,
// plus a second pass Sunday evening for late cards.
export const config = { schedule: "0 13,23 * * 0" };
