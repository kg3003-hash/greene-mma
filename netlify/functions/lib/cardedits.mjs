// GREENE MMA — manual corrections to the fight-week cards
//
// The odds feed is the source of the cards, and it is wrong in ways that only
// a person can see: a cancelled bout it still lists, a fight it filed on the
// wrong card, an opponent who changed on short notice. Corrections made in the
// Studio are stored in site/cardedits and re-applied by every odds sync — the
// same pattern as the fight-order overrides — so a fix made once survives
// every future refresh instead of being silently rebuilt away twice a day.
//
// Shared by odds.mjs (applies edits when it rebuilds the doc from the feed)
// and site.mjs (applies them immediately when a correction is saved).

// A bout's identity is the two names, normalised and sorted. Sorted, because
// the favourite can become the dog between syncs and that must not change
// which bout an edit belongs to. (Kept in step with odds.mjs / site.mjs.)
export const boutKey = (n1, n2) =>
  [n1, n2].map((s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")).sort().join("|");
export const oddsBoutKey = (b) =>
  boutKey(b && b.favourite && b.favourite.name, b && b.underdog && b.underdog.name);

// The site is Utah. Group bouts into cards by the clock the audience lives on,
// not by UTC: a Saturday card's early prelims start before midnight UTC and
// the main card after, and slicing the ISO string split every such event in
// two — one phantom "card" holding the first fight of the night.
export const dayKey = (iso) => {
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  } catch {
    return String(iso || "").slice(0, 10); // en-CA gives YYYY-MM-DD
  }
};

/* The edits document:
   {
     edits: {
       [boutKey]: {
         drop?:  true,          // cancelled / never happening — hide it
         move?:  "YYYY-MM-DD",  // it belongs on this card
         patch?: { favName, favOdds, dogName, dogOdds }   // fix names / odds
       }
     },
     adds: [ { date, startTime?, favourite:{name,odds}, underdog:{name,odds}, book? } ]
   }
   Everything is keyed or deduped so applying the same edits twice is a no-op —
   site.mjs applies them to a doc the sync may already have applied them to. */

const clampOdds = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(-9999, Math.min(9999, n)) : 0;
};
const cleanName = (s) => String(s || "").slice(0, 60).trim();

export function sanitizeEdits(raw) {
  const out = { edits: {}, adds: [] };
  const src = raw && typeof raw === "object" ? raw : {};
  for (const [k, e] of Object.entries(src.edits || {}).slice(0, 80)) {
    if (!e || typeof e !== "object") continue;
    const key = String(k).slice(0, 140);
    const entry = {};
    if (e.drop === true) entry.drop = true;
    if (typeof e.move === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.move)) entry.move = e.move;
    if (e.patch && typeof e.patch === "object") {
      const p = e.patch;
      const patch = {};
      if (p.favName != null) patch.favName = cleanName(p.favName);
      if (p.dogName != null) patch.dogName = cleanName(p.dogName);
      if (p.favOdds != null) patch.favOdds = clampOdds(p.favOdds);
      if (p.dogOdds != null) patch.dogOdds = clampOdds(p.dogOdds);
      if (Object.keys(patch).length) entry.patch = patch;
    }
    if (Object.keys(entry).length) out.edits[key] = entry;
  }
  for (const a of (Array.isArray(src.adds) ? src.adds : []).slice(0, 24)) {
    if (!a || typeof a !== "object") continue;
    const favName = cleanName(a.favourite && a.favourite.name);
    const dogName = cleanName(a.underdog && a.underdog.name);
    if (!favName || !dogName) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.date || ""))) continue;
    out.adds.push({
      date: a.date,
      startTime: typeof a.startTime === "string" ? a.startTime : null,
      favourite: { name: favName, odds: clampOdds(a.favourite && a.favourite.odds) },
      underdog: { name: dogName, odds: clampOdds(a.underdog && a.underdog.odds) },
      book: cleanName(a.book) || "Studio",
      manual: true,
    });
  }
  return out;
}

/* Apply corrections to a set of cards. Pure; returns new arrays. */
export function applyEdits(cards, editsDoc) {
  const { edits, adds } = sanitizeEdits(editsDoc);
  // Cards keyed by date so moves and adds can find their target.
  const byDate = new Map();
  for (const c of cards || []) {
    byDate.set(c.date, { ...c, bouts: [...(c.bouts || [])] });
  }
  const ensureCard = (date, startTime) => {
    if (!byDate.has(date)) byDate.set(date, { date, startTime: startTime || date + "T00:00:00.000Z", bouts: [] });
    return byDate.get(date);
  };

  // 1. drops and moves
  for (const card of byDate.values()) {
    card.bouts = card.bouts.filter((b) => !(edits[oddsBoutKey(b)] || {}).drop);
  }
  for (const card of [...byDate.values()]) {
    for (let i = card.bouts.length - 1; i >= 0; i--) {
      const b = card.bouts[i];
      const mv = (edits[oddsBoutKey(b)] || {}).move;
      if (mv && mv !== card.date) {
        card.bouts.splice(i, 1);
        ensureCard(mv, b.startTime).bouts.push(b);
      }
    }
  }

  // 2. manual bouts — skipped when a bout with the same key already exists
  //    anywhere, which is what makes re-applying these a no-op.
  const present = new Set();
  for (const c of byDate.values()) for (const b of c.bouts) present.add(oddsBoutKey(b));
  for (const a of adds) {
    const k = boutKey(a.favourite.name, a.underdog.name);
    if (present.has(k) || (edits[k] || {}).drop) continue;
    present.add(k);
    ensureCard(a.date, a.startTime).bouts.push({
      eventName: "MMA",
      startTime: a.startTime || a.date + "T00:00:00.000Z",
      favourite: a.favourite, underdog: a.underdog,
      book: a.book, manual: true,
    });
  }

  // 3. patches, wherever the bout ended up
  for (const card of byDate.values()) {
    card.bouts = card.bouts.map((b) => {
      const p = (edits[oddsBoutKey(b)] || {}).patch;
      if (!p) return b;
      return {
        ...b,
        favourite: { ...b.favourite, name: p.favName ?? b.favourite.name, odds: p.favOdds ?? b.favourite.odds },
        underdog:  { ...b.underdog,  name: p.dogName ?? b.underdog.name,  odds: p.dogOdds ?? b.underdog.odds },
      };
    });
  }

  // 4. tidy: no empty cards, dates in order, counts honest
  return [...byDate.values()]
    .filter((c) => c.bouts.length)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((c) => ({ ...c, bouts: c.bouts.slice(0, 16), boutCount: c.bouts.length }));
}

/* The doc's derived fields, recomputed from the corrected cards so the
   homepage headline and the underdog rail never disagree with the cards. */
export function rebuildDerived(cards) {
  const head = (cards[0] && cards[0].bouts) || [];
  const all = cards.flatMap((c) => c.bouts || []);
  return {
    headline: head[0] || null,
    card: head,
    boutCount: cards[0] ? cards[0].boutCount : 0,
    dogs: all
      .filter((b) => b.underdog && b.underdog.odds > 100)
      .sort((x, y) => y.underdog.odds - x.underdog.odds)
      .slice(0, 4),
  };
}
