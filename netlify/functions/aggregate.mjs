// GREENE MMA — News Aggregator Bot
// Runs on a schedule. Pulls MMA news feeds, rewrites each story in the
// brand voice (original wording, always credited to the source), and
// publishes to Firestore where the homepage reads from.

import Parser from "rss-parser";
import admin from "firebase-admin";
import crypto from "node:crypto";
import { rebuildStoryIndexes } from "./lib/story-indexes.mjs";

// ---------- CONFIG ----------
const FEEDS = [
  { name: "ESPN MMA", url: "https://www.espn.com/espn/rss/mma/news" },
  { name: "Sherdog", url: "https://www.sherdog.com/rss/news.xml" },
  { name: "Fightful", url: "https://www.fightful.com/rss.xml" },
  { name: "Yahoo MMA", url: "https://sports.yahoo.com/mma/rss/" },
  // Google News search feed: catches Utah + regional MMA coverage from any outlet.
  // gnews feeds get the publisher pulled from the title and a longer age window,
  // since regional news is sparse.
  // Regional coverage is sparse, so this feed gets a week-long age window —
  // fight-week coverage of a Saturday card often lands days apart.
  // City names are quoted with the state ("Ogden, Utah") because bare
  // (MMA Ogden) matched every story about the UFC fighter Trey Ogden.
  {
    name: "Utah wire",
    gnews: true,
    utah: true,
    maxAgeHours: 168,
    url: "https://news.google.com/rss/search?q=" + encodeURIComponent(
      '"Utah MMA" OR "Fierce Fighting Championship" OR "Fierce FC" OR SteelFist OR "Showdown Fights" OR (MMA "Salt Lake City") OR (UFC "Delta Center") OR (MMA "Ogden, Utah") OR (MMA "Provo, Utah") OR ("cage fight" Utah)'
    ) + "&hl=en-US&gl=US&ceid=US:en",
  },
];

// Some feeds (Fightful especially) mix pro wrestling in with MMA. Anything
// whose headline or snippet matches these gets dropped before it costs an
// API call.
const BLOCKLIST = [
  "wwe","aew","tna","njpw","smackdown","raw ","summerslam","wrestlemania",
  "royal rumble","survivor series","backlash","payback","nxt","impact wrestling",
  "roman reigns","seth rollins","cody rhodes","danhausen","pro wrestling",
  "wrestler","wrestling ring","title belt on raw",
  "high school","prep sports","ncaa wrestling"
];

// Regional tagging — anything matching gets flagged for the Utah page.
// "ogden" must stay qualified — bare "ogden" tags every story about the
// UFC fighter Trey Ogden as Utah news.
const UTAH_TERMS = [
  "utah","salt lake","slc","delta center","union event center","provo","ogden, utah",
  "west jordan","sandy, utah","orem","st. george","logan, utah","park city",
  "steelfist","steel fist","fierce fighting","fierce fc","showdown fights","mountain america center",
  "idaho falls","boise","wyoming","nevada regional","brigham young"
];

function isUtah(item){
  const hay = ((item.title || "") + " " + (item.contentSnippet || "")).toLowerCase();
  return UTAH_TERMS.some(term => hay.includes(term));
}

const UFC_TERMS = ["ufc","dana white","apex","ufc fight night","dwcs","contender series","octagon"];
function isUFC(item){
  const hay = ((item.title || "") + " " + (item.contentSnippet || "")).toLowerCase();
  return UFC_TERMS.some(t => hay.includes(t));
}

function isBlocked(item){
  const hay = ((item.title || "") + " " + (item.contentSnippet || "")).toLowerCase();
  return BLOCKLIST.some(term => hay.includes(term));
}

const MAX_NEW_PER_RUN = 4;        // keeps API costs + write volume sane, and
                                  // stops the wire from drowning original work
const MAX_AGE_HOURS = 36;         // ignore stale items
const CATEGORIES = [
  "Fight booked",
  "Results",
  "Injury report",
  "Line movement",
  "The Corner",
  "News",
];

// ---------- FIREBASE ----------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}
const db = admin.firestore();

// ---------- BRAND VOICE ----------
const VOICE_PROMPT = `You write short news blurbs for Greene MMA, an underdog-focused MMA news site.

Voice rules:
- Dry, confident, cageside — like the sharpest person in the group chat who actually watches the prelims.
- Short sentences. Real stakes. Specific beats generic.
- ONE smirk maximum, and most blurbs should have zero. Never jokey, never hype words like "shocking" or "massive".
- If there's an underdog angle, it gets the last line.
- Write ORIGINAL wording only. Do not copy phrases from the source headline or text. This is a short original take that points readers to the source for the full story.

Given a source headline and snippet, respond with ONLY valid JSON, no markdown fences:
{
  "headline": "original headline, max 10 words, punchy",
  "summary": "original 1-2 sentence take, 25-45 words",
  "category": "one of: ${CATEGORIES.join(", ")}"
}`;

async function rewrite(item) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 300,
      system: VOICE_PROMPT,
      messages: [
        {
          role: "user",
          content: `Source: ${item.sourceName}\nHeadline: ${item.title}\nSnippet: ${(item.contentSnippet || "").slice(0, 500)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .map((b) => b.text || "")
    .join("")
    .replace(/```json|```/g, "")
    .trim();
  const parsed = JSON.parse(text);
  if (!parsed.headline || !parsed.summary) throw new Error("Bad rewrite JSON");
  if (!CATEGORIES.includes(parsed.category)) parsed.category = "News";
  return parsed;
}

// ---------- HELPERS ----------
const idFor = (link) =>
  crypto.createHash("sha1").update(link).digest("hex").slice(0, 20);

const hoursAgo = (date) => (Date.now() - date.getTime()) / 36e5;

// ---------- MAIN ----------
export default async function handler() {
  const parser = new Parser({ timeout: 10000 });
  const candidates = [];

  // 1. Pull all feeds (failures on one feed never kill the run)
  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items || []) {
        if (!item.link || !item.title) continue;
        const pub = item.isoDate ? new Date(item.isoDate) : new Date();
        if (hoursAgo(pub) > (feed.maxAgeHours || MAX_AGE_HOURS)) continue;
        if (isBlocked(item)) continue;
        // Google News titles end with " - Publisher" — pull it out and credit
        // the actual outlet instead of the feed
        let title = item.title;
        let sourceName = feed.name;
        if (feed.gnews) {
          const m = title.match(/^(.*)\s+-\s+([^-]{2,60})$/);
          if (m) { title = m[1].trim(); sourceName = m[2].trim(); }
        }
        candidates.push({
          id: idFor(item.link),
          title,
          contentSnippet: item.contentSnippet || item.content || "",
          link: item.link,
          sourceName,
          publishedAt: pub,
          utah: feed.utah === true || isUtah(item),
          ufc: isUFC(item),
        });
      }
    } catch (err) {
      console.error(`Feed failed: ${feed.name}`, err.message);
    }
  }

  // Newest first
  candidates.sort((a, b) => b.publishedAt - a.publishedAt);

  // 2. Skip anything we've already published
  const fresh = [];
  for (const c of candidates) {
    if (fresh.length >= MAX_NEW_PER_RUN) break;
    const doc = await db.collection("stories").doc(c.id).get();
    if (!doc.exists) fresh.push(c);
  }

  // 3. Rewrite + publish
  let published = 0;
  for (const item of fresh) {
    try {
      const take = await rewrite(item);
      await db.collection("stories").doc(item.id).set({
        headline: take.headline,
        summary: take.summary,
        category: take.category,
        sourceName: item.sourceName,
        sourceUrl: item.link,
        utah: item.utah === true,
        ufc: item.ufc === true,
        publishedAt: admin.firestore.Timestamp.fromDate(item.publishedAt),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      published++;
    } catch (err) {
      console.error(`Rewrite failed: ${item.title}`, err.message);
    }
  }

  // Keep the originals/Utah index docs current so those stories stay visible
  // no matter how much wire content lands on top of them.
  try {
    const counts = await rebuildStoryIndexes(db);
    console.log(`Index docs rebuilt: ${counts.originals} originals, ${counts.utah} Utah.`);
  } catch (err) {
    console.error("Index rebuild failed:", err.message);
  }

  console.log(
    `Run complete: ${candidates.length} candidates, ${fresh.length} new, ${published} published.`
  );
  return new Response(JSON.stringify({ published }), { status: 200 });
}

// Every 3 hours. Netlify reads this cron config automatically.
export const config = { schedule: "0 */3 * * *" };
