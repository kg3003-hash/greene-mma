// node netlify/functions/lib/topic.test.mjs
//
// Hard assertions cover the cases the matcher must never get wrong. The pairs
// that sit in the overlap band are printed rather than asserted — they are a
// known limit of comparing headlines by word overlap, and pinning them to the
// current threshold would just make the test brittle. Run this after any change
// to the stopwords, the stemmer, or the threshold and read the table.

import { overlap, topicTokens, dedupeByTopic, SAME_TOPIC } from "./topic.mjs";

let pass = 0, fail = 0;
const score = (a, b) => overlap(topicTokens(a), topicTokens(b));
function assert(cond, msg) { if (cond) pass++; else { fail++; console.log("  FAIL " + msg); } }
function mustCollapse(a, b, why) {
  assert(score(a, b) >= SAME_TOPIC, `${why} — scored ${score(a,b).toFixed(2)}, need >= ${SAME_TOPIC}\n    A: ${a}\n    B: ${b}`);
}
function mustSeparate(a, b, why) {
  assert(score(a, b) < SAME_TOPIC, `${why} — scored ${score(a,b).toFixed(2)}, need < ${SAME_TOPIC}\n    A: ${a}\n    B: ${b}`);
}

console.log(`threshold = ${SAME_TOPIC}\n`);

console.log("— must collapse: one event, several outlets —");
mustCollapse("UFC flyweight Allan Nascimento dead at 34",
             "Flyweight Allan Nascimento dead at 34", "the real pair that prompted this");
mustCollapse("Anthony Smith arrested",
             "Anthony Smith arrested on domestic violence charge", "short wire vs fuller writeup");
mustCollapse("Jon Jones retires from MMA",
             "Jon Jones announces retirement", "same news, different verb form");
mustCollapse("Report: Conor McGregor targeting summer return",
             "Conor McGregor targeting a summer return, per report", "wire boilerplate reordered");
mustCollapse("Johnny Walker moves up to heavyweight to face Mick Parkin",
             "Walker vs Parkin booked at heavyweight for UFC 332", "one booking, two framings");

console.log("— must separate: different stories —");
mustSeparate("Anthony Smith arrested on domestic violence charge",
             "UFC removes Anthony Smith from broadcast team", "the arrest vs the fallout");
mustSeparate("Anthony Smith arrested on domestic violence charge",
             "Anthony Smith released from custody", "the arrest vs the release");
mustSeparate("Flyweight Allan Nascimento dead at 34",
             "The Utah crowd is about to get loud again", "nothing in common");
mustSeparate("UFC 332 lands at the Delta Center in October",
             "UFC 319 results and reaction from Chicago", "same promotion, different event");
mustSeparate("Walker vs Parkin booked at heavyweight for UFC 332",
             "Medic's 30-second finish headlines record night in Belgrade", "two different cards");

console.log("\n— known limits, reported not asserted —");
[
  ["duplicate we MISS",  "UFC flyweight Allan Nascimento dead at 34", "Nascimento dies at 34, UFC confirms",
   "'dead' and 'dies' are synonyms; word overlap cannot see that"],
  ["update we SUPPRESS", "Jon Jones retires from MMA", "Jon Jones hints at a comeback fight",
   "3-token headlines: two shared surnames are already most of the sentence"],
  ["judgement call",     "Anthony Smith arrested on domestic violence charge", "Anthony Smith issues statement on arrest",
   "arguably the same story; suppressing it is defensible"],
].forEach(([kind, a, b, note]) => {
  const s = score(a, b);
  const acts = s >= SAME_TOPIC ? "collapses" : "stays separate";
  console.log(`  ${s.toFixed(2)}  ${acts.padEnd(14)} ${kind}\n        ${note}`);
});

console.log("\n— end to end —");
const H = 36e5, now = Date.now();
const { kept, dropped } = dedupeByTopic([
  { title: "Flyweight Allan Nascimento dead at 34",     sourceName: "Yahoo MMA", publishedAt: new Date(now - 1 * H) },
  { title: "UFC flyweight Allan Nascimento dead at 34", sourceName: "ESPN MMA",  publishedAt: new Date(now - 3 * H) },
  { title: "Anthony Smith released from custody",       sourceName: "Fightful",  publishedAt: new Date(now - 1 * H) },
], [
  { title: "Anthony Smith arrested on domestic violence charge", publishedAt: new Date(now - 2 * H) },
  { title: "Jon Jones retires from MMA",                          publishedAt: new Date(now - 30 * H) },
], 8);

console.log("  kept:");    kept.forEach(k => console.log(`    ${k.sourceName.padEnd(10)} ${k.title}`));
console.log("  dropped:"); dropped.forEach(d => console.log(`    ${d.sourceName.padEnd(10)} ${d.title}\n               ↳ ${d.reason}: ${d.matched}`));

assert(kept.some(k => k.sourceName === "ESPN MMA"),
  "ESPN filed 3h ago vs Yahoo's 1h — first to file should be the one kept");
assert(!kept.some(k => k.sourceName === "Yahoo MMA"),
  "Yahoo's later copy of the same death should have collapsed");
assert(kept.some(k => /released from custody/.test(k.title)),
  "the release is a development, not a duplicate of the arrest");

const reopened = dedupeByTopic(
  [{ title: "Jon Jones retires from MMA", sourceName: "ESPN MMA", publishedAt: new Date(now) }],
  [{ title: "Jon Jones retires from MMA", publishedAt: new Date(now - 30 * H) }], 8);
assert(reopened.kept.length === 1, "a 30h-old topic is outside the 8h window and must publish again");

const stillClosed = dedupeByTopic(
  [{ title: "Jon Jones retires from MMA", sourceName: "ESPN MMA", publishedAt: new Date(now) }],
  [{ title: "Jon Jones retires from MMA", publishedAt: new Date(now - 2 * H) }], 8);
assert(stillClosed.kept.length === 0, "a 2h-old identical topic is inside the window and must be held");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
