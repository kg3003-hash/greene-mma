// GREENE MMA — topic matching for the news wire
//
// The aggregator de-duplicates on a hash of the article URL, which only ever
// catches the identical link twice. When a big story breaks, ESPN, Yahoo,
// Sherdog and Fightful each file their own version under their own URL, so the
// feed shows the same news three or four times in a row.
//
// This compares what a headline is ABOUT. Two headlines covering one event
// share nearly all of their meaningful words; a genuine development in an
// ongoing story introduces new ones. That difference is enough to tell
// "Yahoo also covered the arrest" apart from "he has now been released".

/* Grammar words carry no signal, and a handful of MMA words appear in so many
   headlines that leaving them in makes unrelated stories look similar. "UFC"
   is in half the wire on any given day. */
const STOP = new Set([
  "the","a","an","and","or","but","for","nor","of","to","in","on","at","by",
  "with","from","into","over","after","before","as","is","are","was","were",
  "be","been","being","has","have","had","will","would","can","could","should",
  "his","her","its","their","this","that","these","those","it","he","she","they",
  "not","no","out","up","down","off","than","then","who","what","when","where",
  "why","how","all","any","more","most","new","now","amid","ahead","set","get",
  // domain filler
  "ufc","mma","fight","fights","fighter","fighters","bout","says","said","say",
  "report","reports","reported","reportedly","per","via","news","story","update",
]);

/* Just enough stemming to make two outlets' verb choices line up. Without it
   "Jon Jones retires" and "Jon Jones announces retirement" look like separate
   stories. Deliberately crude — no vowel rules, no dictionary — because an
   over-eager stemmer collapses words that should stay apart. */
function stem(w) {
  if (w.length <= 4) return w;
  if (w.endsWith("ment")) return w.slice(0, -4);   // retirement -> retire
  if (w.endsWith("ing"))  return w.slice(0, -3);
  if (w.endsWith("ed"))   return w.slice(0, -2);   // arrested -> arrest
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1); // retires -> retire
  return w;
}

/* The meaningful words in a headline, as a set. Numbers are kept — "UFC 332"
   and "at 34" are exactly the kind of detail that separates two stories. */
export function topicTokens(title) {
  const words = String(title || "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")          // possessives: Smith's -> smith
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => {
      if (!w) return false;
      if (STOP.has(w)) return false;
      if (/^\d+$/.test(w)) return w.length >= 2;   // keep 34, 332; drop stray digits
      return w.length >= 3;
    })
    .map(stem)
    .filter((w) => w.length >= 2);
  return new Set(words);
}

/* Overlap coefficient, not Jaccard. Jaccard punishes a short headline paired
   with a long one — "Anthony Smith arrested" against "Anthony Smith arrested on
   a domestic violence charge" scores only 0.5 and reads as two stories, when
   the short one is plainly the same report with fewer details. Dividing by the
   SMALLER set asks the question we actually care about: is one headline
   essentially contained in the other? */
export function overlap(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.min(a.size, b.size);
}

/* Tuned against real wire pairs — see topic.test.mjs, which prints the full
   score table.
 *
 * There is no threshold that gets every pair right. Real duplicates run as low
 * as 0.50 ("dead at 34" vs "dies at 34" — synonyms this cannot see), while two
 * genuinely different stories about the same person can reach 0.67 when the
 * headlines are short enough that two shared surnames are most of the sentence.
 * The bands overlap, so the choice is which error to prefer.
 *
 * 0.60 leans toward suppressing, because the two mistakes are not equally
 * costly: a duplicate that slips through is visible on the homepage and looks
 * sloppy, while a story held back is only delayed until the window reopens.
 * Override with WIRE_TOPIC_THRESHOLD to move that balance without a deploy. */
export const SAME_TOPIC = Number(process.env.WIRE_TOPIC_THRESHOLD) || 0.60;

export function isSameTopic(titleA, titleB, threshold) {
  return overlap(topicTokens(titleA), topicTokens(titleB)) >= (threshold ?? SAME_TOPIC);
}

/* A stable string for the doc, so a later run can compare without re-tokenising
   and so it is possible to see at a glance why two stories collided. */
export function topicKey(title) {
  return [...topicTokens(title)].sort().join(" ");
}

/* Pick which stories survive.
 *
 * `candidates` are this run's items; `recent` are stories already published
 * inside the window, each {title, publishedAt}. Returns the keepers plus a
 * record of what was dropped and why, so the run log can show its working.
 *
 * Whoever filed first wins: candidates are walked oldest-first, so the outlet
 * that broke the story is the one that stays, regardless of feed order.
 */
export function dedupeByTopic(candidates, recent, windowHours, threshold) {
  const thr = threshold ?? SAME_TOPIC;
  const cutoff = Date.now() - windowHours * 36e5;

  const priors = (recent || [])
    .filter((r) => +new Date(r.publishedAt) >= cutoff)
    .map((r) => ({ title: r.title, tokens: topicTokens(r.title) }));

  const byOldest = [...(candidates || [])].sort((a, b) => a.publishedAt - b.publishedAt);
  const kept = [], dropped = [];

  for (const c of byOldest) {
    const tokens = topicTokens(c.title);

    // Only compare against priors still inside the window relative to THIS
    // item — a candidate from six hours ago should not be judged against a
    // story published after it.
    const prior = priors.find((p) => overlap(tokens, p.tokens) >= thr);
    if (prior) { dropped.push({ ...c, reason: "already covered", matched: prior.title }); continue; }

    const twin = kept.find((k) => overlap(tokens, k._tokens) >= thr);
    if (twin) { dropped.push({ ...c, reason: "duplicate in this run", matched: twin.title }); continue; }

    kept.push({ ...c, _tokens: tokens });
  }

  // Hand back newest-first, the order the rest of the pipeline expects.
  kept.sort((a, b) => b.publishedAt - a.publishedAt);
  return { kept: kept.map(({ _tokens, ...c }) => c), dropped };
}
