// GREENE MMA — server-rendered fighter profiles at /f/:slug
//
// The roster already existed at fighter.html?f=slug, but that page is built by
// JavaScript after load, lives on a query string, and sits in no sitemap — so
// searches like "Court McGee record" or "Kent Mafileo next fight" found nothing
// of ours. Seventy-one pages' worth of the one subject we can actually win on.
//
// This mirrors story-page.mjs: real HTML, in the response, with its own title,
// description, canonical and structured data. Same reason that function exists.
//
// A profile built from one sparse roster row would be thin content, and Google
// declines to index thin pages. So each page also carries the fighter's Utah
// ranking, their next fight, and the others in their division and gym — real
// substance, and internal links that help the whole roster get crawled.
//
// NOTE: nav and footer are duplicated from story-page.mjs. Worth lifting into
// a shared module, but that function serves indexed pages and cannot be run
// locally (it needs the service account at import), so it is left alone here.

import admin from "firebase-admin";

// Initialised on first use rather than at import. Initialising at import means
// the module cannot be loaded at all without the service account in the
// environment, which would make the rendering below untestable — and rendering
// is the part worth testing. Same behaviour at runtime either way.
let _db = null;
function getDb() {
  if (!_db) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      });
    }
    _db = admin.firestore();
  }
  return _db;
}

const SITE = "https://greenemma.com";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fullName = (f) => [f.first, f.last].filter(Boolean).join(" ").trim();
// The roster stores nicknames bare; quote them the way a fight card would.
const displayName = (f) => f.nickname
  ? `${f.first || ""} "${f.nickname}" ${f.last || ""}`.replace(/\s+/g, " ").trim()
  : fullName(f);

const NAV = `
<nav>
  <div class="wrap wide">
    <a href="/" style="display:flex;align-items:center;gap:14px;">
      <svg class="mark" viewBox="0 0 120 120"><path d="M104.35,41.63 78.37,15.65 41.63,15.65 15.65,41.63 15.65,78.37 41.63,104.35 78.37,104.35 104.35,78.37 104.35,64 71,64" fill="none" stroke="#C9F73A" stroke-width="11" stroke-linejoin="miter"/></svg>
      <span class="name">Greene <span>MMA</span></span>
    </a>
    <div class="links">
      <a href="/news.html">News</a>
      <a href="/picks.html">Picks</a>
      <a href="/fightweek.html">Fight Week</a>
      <a href="/utah.html">Utah</a>
      <a href="/fighters.html">Fighters</a>
      <a href="/newsletter.html">The Corner</a>
    </div>
  </div>
</nav>`;

const FOOTER = `
<footer>
  <div class="wrap wide">
    Greene MMA · <a href="https://greene.bet">Part of the greene.bet family</a><br>
    <a href="/news.html">News</a> · <a href="/fightweek.html">Fight Week</a> · <a href="/picks.html">Picks</a> · <a href="/utah.html">Utah</a> · <a href="/fighters.html">Fighters</a> · <a href="/newsletter.html">Newsletter</a> · <a href="/partner.html">Advertise</a> · <a href="/contact.html">Contact</a><br>
    <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a><br>
    © 2026 Greene MMA. Picks are for entertainment. Bet with your head, not over it.
  </div>
</footer>`;

const CSS = `
:root{--black:#0C0E0A;--black-2:#13160F;--volt:#C9F73A;--bone:#F2F0E9;--steel:#9AA194;--red:#FF4B3E;--hair:rgba(242,240,233,.14);}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--black);color:var(--bone);font-family:'Barlow',sans-serif;font-size:17.5px;line-height:1.65;-webkit-font-smoothing:antialiased;}
a{color:inherit;text-decoration:none;}
.wrap{max-width:900px;margin:0 auto;padding:0 22px;}
.wide{max-width:1060px;}
nav{position:sticky;top:0;z-index:50;background:rgba(12,14,10,.94);backdrop-filter:blur(12px);border-bottom:1px solid var(--hair);}
nav .wrap{display:flex;align-items:center;gap:14px;height:66px;}
nav .mark{width:34px;height:34px;}
nav .name{font-family:'Anton',sans-serif;font-size:21px;text-transform:uppercase;}
nav .name span{color:var(--volt);}
nav .links{display:flex;flex:1;justify-content:center;gap:clamp(14px,2.4vw,34px);font-weight:600;font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:var(--steel);}
nav .links a:hover{color:var(--volt);}
@media(max-width:700px){
  nav .wrap{gap:12px;padding:0 16px;}
  nav .links{flex:1 1 auto;min-width:0;justify-content:flex-start;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;gap:24px;font-size:12px;padding:6px 0;-webkit-mask-image:linear-gradient(90deg,#000 84%,transparent);mask-image:linear-gradient(90deg,#000 84%,transparent);}
  nav .links::-webkit-scrollbar{display:none;}
  nav .links a{flex-shrink:0;white-space:nowrap;}
}
.hero{padding:52px 0 34px;position:relative;overflow:hidden;border-bottom:1px solid var(--hair);
  background:radial-gradient(ellipse 70% 60% at 22% 0%, rgba(201,247,58,.08), transparent 62%);}
.crumb{font-family:'JetBrains Mono',monospace;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--steel);}
.crumb a:hover{color:var(--volt);}
.rankchip{display:inline-block;margin-bottom:14px;padding:5px 12px;background:var(--volt);color:var(--black);
  font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;}
h1{font-family:'Anton',sans-serif;font-weight:400;text-transform:uppercase;font-size:clamp(38px,7vw,72px);line-height:1;margin-top:16px;}
h1 .nick{color:var(--volt);}
.rec{margin-top:18px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;}
.rec .big{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:34px;color:var(--volt);letter-spacing:-.01em;}
.rec .lbl{font-family:'JetBrains Mono',monospace;font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--steel);}
.tags{margin-top:20px;display:flex;gap:8px;flex-wrap:wrap;}
.tag{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--steel);border:1px solid var(--hair);padding:5px 11px;}
.tag.on{color:var(--volt);border-color:rgba(201,247,58,.5);}
section{padding:38px 0;border-bottom:1px solid var(--hair);}
h2{font-family:'Anton',sans-serif;font-weight:400;text-transform:uppercase;font-size:26px;margin-bottom:18px;}
.next{border:1px solid var(--hair);border-left:3px solid var(--volt);background:var(--black-2);padding:20px 24px;}
.next .lbl{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--volt);}
.next .val{font-size:20px;margin-top:7px;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1px;background:var(--hair);border:1px solid var(--hair);}
.cell{background:var(--black-2);padding:16px 18px;}
.cell .k{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--steel);}
.cell .v{font-size:19px;margin-top:5px;}
.note{font-size:18px;color:var(--bone);}
.rel{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;}
a.fcard{border:1px solid var(--hair);background:var(--black-2);padding:18px 20px;transition:border-color .15s;}
a.fcard:hover{border-color:rgba(201,247,58,.55);}
a.fcard .n{font-family:'Anton',sans-serif;text-transform:uppercase;font-size:19px;line-height:1.1;}
a.fcard .m{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.08em;color:var(--steel);margin-top:6px;}
.back{display:inline-block;margin:34px 0 60px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--steel);}
.back:hover{color:var(--volt);}
footer{border-top:1px solid var(--hair);padding:44px 0 64px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--steel);line-height:2.1;}
footer a{color:var(--bone);} footer a:hover{color:var(--volt);}
.notfound{padding:100px 0;text-align:center;font-family:'JetBrains Mono',monospace;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--steel);line-height:2.4;}
`;

const head = (title, extra) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="icon" type="image/png" sizes="64x64" href="/assets/favicon-64.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">
<meta name="theme-color" content="#0C0E0A">
${extra}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>`;

const page404 = () => head("Fighter not found — Greene MMA", '<meta name="robots" content="noindex">') +
  NAV +
  `<div class="wrap"><div class="notfound">Fighter not found.<br><a class="back" href="/fighters.html">← The full Utah roster</a></div></div>` +
  FOOTER + "</body></html>";

const html = (body, status) => new Response(body, {
  status: status || 200,
  headers: {
    "content-type": "text/html; charset=utf-8",
    // Cache at the edge but let it refresh in the background — roster edits in
    // the Studio should appear without waiting out a long TTL.
    "cache-control": "public, max-age=0, s-maxage=600, stale-while-revalidate=86400",
  },
});

// Exported so the whole page can be rendered from fixture or live data without
// touching Firestore. Returns null when the slug matches nobody.
export function renderFighter(slug, roster, divisions) {
  const f = (roster || []).find((x) => (x.slug || slugify(fullName(x))) === slug);
  if (!f) return null;
  divisions = divisions || [];

  const name = fullName(f);
  const shown = displayName(f);

  // Where they sit in the Utah rankings — the strongest thing we can say about
  // most of this roster, and it comes from a document we already have open.
  const ranks = [];
  divisions.forEach((d) => {
    (d.fighters || []).forEach((entry, i) => {
      const en = String(entry).replace(/"[^"]*"/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (en === name.toLowerCase() || String(entry).toLowerCase().includes(name.toLowerCase())) {
        ranks.push({ division: d.name, place: i + 1 });
      }
    });
  });
  const topRank = ranks.find((r) => r.division !== "Pound for Pound") || ranks[0] || null;

  // Others worth a click: same division first, then the same gym.
  const others = roster
    .filter((x) => x !== f && (x.slug || slugify(fullName(x))))
    .map((x) => ({
      f: x,
      score: (f.weight && x.weight === f.weight ? 2 : 0) + (f.gym && x.gym === f.gym ? 3 : 0),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.f);

  const facts = [
    ["Record", f.record],
    ["Weight class", f.weight],
    ["Gym", f.gym],
    ["Hometown", f.city],
    ["Status", f.status],
    ["Age", f.age],
    ["Height", f.height],
    ["Reach", f.reach],
    ["Stance", f.stance],
  ].filter(([, v]) => v && String(v).trim());

  const stats = [
    ["Strikes / min", f.slpm], ["Striking acc.", f.strAcc], ["Strikes absorbed", f.sapm],
    ["Striking def.", f.strDef], ["Takedowns / 15m", f.tdAvg], ["Takedown acc.", f.tdAcc],
    ["Takedown def.", f.tdDef], ["Submissions / 15m", f.subAvg],
  ].filter(([, v]) => v && String(v).trim());

  // The description is what shows in the search result, so lead with the facts
  // somebody searching this name actually wants.
  const descBits = [
    f.record ? `${f.record}` : null,
    f.weight || null,
    f.gym ? `out of ${f.gym}` : null,
    topRank ? `ranked #${topRank.place} at ${topRank.division} in Utah` : null,
  ].filter(Boolean);
  const description = `${name} — ${descBits.join(", ")}. Utah MMA record, gym and next fight from Greene MMA.`
    .replace(/ — \./, " — ").slice(0, 300);

  const title = `${name} — ${f.record ? f.record + " " : ""}Utah MMA Fighter | Greene MMA`.slice(0, 70);
  const url = `${SITE}/f/${encodeURIComponent(slug)}`;

  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Person",
        "@id": url + "#person",
        name,
        ...(f.nickname ? { alternateName: f.nickname } : {}),
        jobTitle: "Mixed martial artist",
        url,
        ...(f.gym ? { affiliation: { "@type": "SportsOrganization", name: f.gym } } : {}),
        ...(f.city ? { homeLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: f.city, addressRegion: "UT", addressCountry: "US" } } } : {}),
        ...(f.social ? { sameAs: [f.social] } : {}),
        description,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Greene MMA", item: SITE + "/" },
          { "@type": "ListItem", position: 2, name: "Utah Fighters", item: SITE + "/fighters.html" },
          { "@type": "ListItem", position: 3, name, item: url },
        ],
      },
    ],
  };

  const meta = `
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="Greene MMA">
<meta property="og:title" content="${esc(name)} — Utah MMA">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/assets/share-card.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`;

  const body = `
<header class="hero">
  <div class="wrap">
    <div class="crumb"><a href="/">Greene MMA</a> · <a href="/fighters.html">Utah Fighters</a></div>
    <h1>${f.nickname
      ? `${esc(f.first || "")} <span class="nick">&ldquo;${esc(f.nickname)}&rdquo;</span> ${esc(f.last || "")}`
      : esc(name)}</h1>
    ${f.record ? `<div class="rec"><span class="big">${esc(f.record)}</span><span class="lbl">Professional record</span></div>` : ""}
    <div class="tags">
      ${topRank ? `<span class="tag on">#${topRank.place} ${esc(topRank.division)} · Utah</span>` : ""}
      ${f.weight ? `<span class="tag">${esc(f.weight)}</span>` : ""}
      ${f.gym ? `<span class="tag">${esc(f.gym)}</span>` : ""}
      <span class="tag">${f.pro === false ? "Amateur" : "Professional"}</span>
      ${f.status ? `<span class="tag">${esc(f.status)}</span>` : ""}
    </div>
  </div>
</header>

${f.next ? `<section><div class="wrap">
  <h2>Next fight</h2>
  <div class="next"><div class="lbl">Booked</div><div class="val">${esc(f.next)}</div></div>
</div></section>` : ""}

${facts.length ? `<section><div class="wrap">
  <h2>The tale of the tape</h2>
  <div class="grid">${facts.map(([k, v]) =>
    `<div class="cell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>
</div></section>` : ""}

${stats.length ? `<section><div class="wrap">
  <h2>Career numbers</h2>
  <div class="grid">${stats.map(([k, v]) =>
    `<div class="cell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>
</div></section>` : ""}

${f.note ? `<section><div class="wrap"><h2>Scouting report</h2><p class="note">${esc(f.note)}</p></div></section>` : ""}

${ranks.length ? `<section><div class="wrap">
  <h2>Where ${esc(f.last || name)} ranks in Utah</h2>
  <div class="rel">${ranks.map((r) =>
    `<a class="fcard" href="/utah.html"><div class="n">#${r.place} ${esc(r.division)}</div><div class="m">Greene MMA Utah rankings</div></a>`).join("")}</div>
</div></section>` : ""}

${others.length ? `<section><div class="wrap">
  <h2>More Utah fighters</h2>
  <div class="rel">${others.map((o) => {
    const os = o.slug || slugify(fullName(o));
    const bits = [o.record, o.weight].filter(Boolean).join(" · ");
    return `<a class="fcard" href="/f/${encodeURIComponent(os)}"><div class="n">${esc(fullName(o))}</div><div class="m">${esc(bits || "Utah roster")}</div></a>`;
  }).join("")}</div>
</div></section>` : ""}

<div class="wrap"><a class="back" href="/fighters.html">← The full Utah roster</a></div>`;

  return head(esc(title), meta) + NAV + body + FOOTER + "</body></html>";
}

export default async function handler(req) {
  const slug = decodeURIComponent(new URL(req.url).pathname.replace(/^\/f\//, "").replace(/\/+$/, ""));
  if (!slug) return html(page404(), 404);

  let roster = [], divisions = [];
  try {
    const db = getDb();
    const [fSnap, rSnap] = await Promise.all([
      db.collection("site").doc("fighters").get(),
      db.collection("site").doc("rankings").get(),
    ]);
    roster = (fSnap.data() || {}).fighters || [];
    divisions = (rSnap.data() || {}).divisions || [];
  } catch (e) {
    console.error("fighter-page read failed:", e.message);
    return html(page404(), 500);
  }

  const page = renderFighter(slug, roster, divisions);
  return page ? html(page) : html(page404(), 404);
}

export const config = { path: "/f/:slug" };
