// GREENE MMA — Server-rendered story pages at /s/:id
//
// story.html renders client-side, which means every shared link shows the
// same generic title/share card and search engines see an empty shell.
// This function serves the same article with real per-story OG tags,
// NewsArticle structured data, and the full body in the HTML — so links
// unfurl properly on X/iMessage and stories can rank in search.
//
// Env: FIREBASE_SERVICE_ACCOUNT

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

const SITE = "https://greenemma.com";

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Same safe markup rules as the Writers' Room preview (write.html/story.html):
// everything is escaped first, only these patterns become formatting.
function gmFormat(src) {
  const inline = (t) => {
    t = t.replace(/\[([^\]]{1,120})\]\((https?:\/\/[^\s)]{1,300})\)/g,
      (m, txt, url) => '<a href="' + url.replace(/"/g, "%22") + '" target="_blank" rel="noopener">' + txt.replace(/"/g, "&quot;") + "</a>");
    t = t.replace(/\*\*([^*]{1,300})\*\*/g, "<strong>$1</strong>");
    t = t.replace(/__([^_]{1,300})__/g, "<u>$1</u>");
    t = t.replace(/(^|[^*])\*([^*\n]{1,300})\*/g, "$1<em>$2</em>");
    return t;
  };
  const lines = esc(String(src || "")).split(/\r?\n/);
  let out = [], list = null, para = [];
  const flushPara = () => { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
  const flushList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    let m;
    if (/^---+$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if ((m = line.match(/^###\s+(.*)$/))) { flushPara(); flushList(); out.push("<h3>" + inline(m[1]) + "</h3>"); continue; }
    if ((m = line.match(/^##\s+(.*)$/))) { flushPara(); flushList(); out.push("<h2>" + inline(m[1]) + "</h2>"); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out.push("<blockquote>" + inline(m[1]) + "</blockquote>"); continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (list !== "ul") { flushList(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + inline(m[1]) + "</li>"); continue;
    }
    if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== "ol") { flushList(); out.push("<ol>"); list = "ol"; }
      out.push("<li>" + inline(m[1]) + "</li>"); continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join("\n");
}

function timeAgo(d) {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 90) return "Now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

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
.wrap{max-width:760px;margin:0 auto;padding:0 22px;}
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
  nav .links{flex:1 1 auto;min-width:0;justify-content:flex-start;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;gap:24px;font-size:12px;letter-spacing:.08em;padding:6px 0;-webkit-mask-image:linear-gradient(90deg,#000 84%,transparent);mask-image:linear-gradient(90deg,#000 84%,transparent);}
  nav .links::-webkit-scrollbar{display:none;}
  nav .links a{flex-shrink:0;white-space:nowrap;}
}
.hero{padding:56px 0 40px;position:relative;overflow:hidden;background:radial-gradient(ellipse 70% 60% at 25% 0%, rgba(201,247,58,.07), transparent 62%);}
.cat{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--volt);font-weight:700;}
.origbadge{display:inline-block;margin-left:12px;padding:3px 9px;background:var(--volt);color:var(--black);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;}
h1{font-family:'Anton',sans-serif;font-weight:400;text-transform:uppercase;font-size:clamp(34px,6vw,58px);line-height:1.02;margin-top:18px;}
.meta{margin-top:22px;font-family:'JetBrains Mono',monospace;font-size:12.5px;letter-spacing:.06em;color:var(--steel);display:flex;gap:20px;flex-wrap:wrap;}
.rule{height:1px;background:var(--hair);margin:8px 0 32px;}
.body{padding:8px 0 44px;font-size:20px;line-height:1.68;}
.body p{margin-bottom:22px;}
.body h2{font-family:'Anton',sans-serif;font-weight:400;text-transform:uppercase;font-size:30px;line-height:1.12;margin:34px 0 16px;}
.body h3{font-family:'Anton',sans-serif;font-weight:400;text-transform:uppercase;font-size:23px;line-height:1.14;margin:28px 0 12px;color:var(--volt);}
.body strong{font-weight:700;color:#fff;}
.body u{text-decoration:underline;text-decoration-color:var(--volt);text-underline-offset:3px;}
.body a{color:var(--volt);text-decoration:underline;text-underline-offset:3px;}
.body a:hover{color:var(--bone);}
.body ul,.body ol{margin:0 0 22px 22px;}
.body li{margin-bottom:9px;}
.body blockquote{border-left:3px solid var(--volt);padding:6px 0 6px 20px;margin:26px 0;color:var(--bone);font-size:22px;line-height:1.5;}
.body hr{border:none;border-top:1px solid var(--hair);margin:34px 0;}
/* reading progress — a thin volt line that fills as the article scrolls,
   matching the client-side viewer in story.html */
.progress{position:fixed;top:0;left:0;height:3px;width:0;background:var(--volt);z-index:60;transition:width .08s linear;box-shadow:0 0 12px rgba(201,247,58,.5);}
.share{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:20px 0 26px;margin-bottom:24px;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);}
.share .lbl{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--steel);}
.share .btns{display:flex;gap:9px;flex-wrap:wrap;}
.share .sbtn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:11px 20px;
  border:1px solid var(--hair);background:transparent;color:var(--steel);cursor:pointer;
  font-family:'JetBrains Mono',monospace;font-size:11.5px;font-weight:700;letter-spacing:.12em;
  text-transform:uppercase;transition:border-color .15s,color .15s,background .15s;}
.share .sbtn:hover{border-color:var(--volt);color:var(--volt);}
.share .sbtn.primary{border-color:var(--volt);color:var(--volt);}
.share .sbtn.primary:hover{background:var(--volt);color:var(--black);}
.share .sbtn.done{background:var(--volt);color:var(--black);border-color:var(--volt);}
@media(max-width:520px){.share .sbtn{flex:1 1 auto;}}
.src{border:1px solid var(--hair);border-left:3px solid var(--volt);background:var(--black-2);padding:24px;margin-bottom:44px;}
.src .lbl{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--steel);}
.src .name{font-family:'Anton',sans-serif;text-transform:uppercase;font-size:22px;margin-top:8px;}
.src a.go{display:inline-block;margin-top:16px;padding:13px 26px;border:2px solid var(--volt);color:var(--volt);font-weight:700;font-size:13.5px;letter-spacing:.1em;text-transform:uppercase;}
.src a.go:hover{background:var(--volt);color:var(--black);}
.src p{margin-top:12px;font-size:15px;color:var(--steel);}
.more{border-top:1px solid var(--hair);padding:52px 0 70px;}
.more h2{font-family:'Anton',sans-serif;font-weight:400;text-transform:uppercase;font-size:26px;margin-bottom:24px;}
.feed{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;}
a.card{border:1px solid var(--hair);padding:24px;display:flex;flex-direction:column;gap:12px;background:var(--black-2);transition:border-color .15s;}
a.card:hover{border-color:rgba(201,247,58,.55);}
a.card .c{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--volt);font-weight:700;}
a.card h3{font-family:'Anton',sans-serif;font-weight:400;text-transform:uppercase;font-size:20px;line-height:1.12;}
a.card p{font-size:15px;color:var(--steel);}
.back{display:inline-block;margin-top:34px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--steel);}
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
<link rel="alternate" type="application/rss+xml" title="Greene MMA — Original stories" href="${SITE}/feed.xml">
${extra}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>`;

const page404 = () => head("Story not found — Greene MMA", '<meta name="robots" content="noindex">') +
  NAV +
  `<div class="wrap"><div class="notfound">Story not found.<br><a class="back" href="/">← Back to the news</a></div></div>` +
  FOOTER + "</body></html>";

export default async function handler(req, context) {
  const id = (context && context.params && context.params.id) ||
    new URL(req.url).pathname.split("/").filter(Boolean).pop() || "";
  if (!id || id.length > 200) {
    return new Response(page404(), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  let s = null;
  try {
    const snap = await db.collection("stories").doc(id).get();
    if (snap.exists) s = snap.data();
  } catch (e) {
    console.error("Story read failed:", e.message);
  }
  if (!s) {
    return new Response(page404(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" },
    });
  }

  const url = `${SITE}/s/${encodeURIComponent(id)}`;
  const published = s.publishedAt && s.publishedAt.toDate ? s.publishedAt.toDate() : null;
  const original = s.original === true;
  const author = s.author || "Greene MMA";
  const desc = String(s.summary || "").slice(0, 300);

  // Related: newest originals (one cheap doc read), excluding this story.
  let others = [];
  try {
    const idxSnap = await db.collection("site").doc("originals").get();
    others = ((idxSnap.data() || {}).stories || []).filter((o) => o.id !== id).slice(0, 3);
  } catch (e) { /* section just stays empty */ }

  // Per-story share card when the Studio generated one (/og/:id.jpg),
  // otherwise the house card so a link never unfurls broken.
  const shareImg = s.ogCard ? `${SITE}/og/${encodeURIComponent(id)}.jpg` : `${SITE}/assets/share-card.png`;

  /* Every story gets structured data, not just our own writing — an
     aggregated item is still an article and previously emitted none at all.
     Ours is credited to its author; a wire item is credited to the outlet
     that reported it, which is both accurate and the honest signal to send.
     A breadcrumb sits alongside so the story shows its place in the site. */
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: s.headline,
    description: desc,
    datePublished: published ? published.toISOString() : undefined,
    author: original
      ? [{ "@type": "Person", name: author }]
      : [{ "@type": "Organization", name: s.sourceName || "Wire report" }],
    publisher: {
      "@type": "Organization",
      name: "Greene MMA",
      logo: { "@type": "ImageObject", url: `${SITE}/assets/icon-512.png` },
    },
    image: [shareImg],
    articleSection: s.category || "News",
    isAccessibleForFree: true,
    mainEntityOfPage: url,
    ...(original ? {} : (s.sourceUrl ? { isBasedOn: s.sourceUrl } : {})),
  };
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Greene MMA", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "News", item: `${SITE}/news.html` },
      { "@type": "ListItem", position: 3, name: s.headline },
    ],
  };
  const jsonld =
    `<script type="application/ld+json">${JSON.stringify(articleSchema)}</script>` +
    `<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>`;

  const metaExtra = `
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Greene MMA">
<meta property="og:title" content="${esc(s.headline)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${shareImg}">
${published ? `<meta property="article:published_time" content="${published.toISOString()}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(s.headline)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${shareImg}">
${jsonld}`;

  const bodyHtml = original && s.body ? gmFormat(s.body) : "<p>" + esc(s.summary || "") + "</p>";

  const credit = original
    ? `<div class="src"><div class="lbl">Written by</div><div class="name">${esc(author)}</div>
       <p>From the Greene corner. If we got something wrong, tell us.</p></div>`
    : `<div class="src"><div class="lbl">Original reporting</div><div class="name">${esc(s.sourceName || "")}</div>
       <p>Our take is above. The full reporting lives with the people who did it — go read it there.</p>
       ${s.sourceUrl ? `<a class="go" href="${esc(s.sourceUrl)}" target="_blank" rel="noopener">Read the full story →</a>` : ""}</div>`;

  // Share row. On phones the first button opens the native share sheet (the
  // way people actually text a link); everywhere else it copies. X, Facebook
  // and email are explicit so nobody has to hunt for them.
  const shareText = encodeURIComponent(s.headline || "Greene MMA");
  const shareUrlEnc = encodeURIComponent(url);
  const shareRow = `
<div class="share">
  <span class="lbl">Share this</span>
  <div class="btns">
    <button type="button" class="sbtn primary" id="shareGo" data-url="${esc(url)}" data-title="${esc(s.headline || "")}">
      <span id="shareGoTxt">Share</span></button>
    <a class="sbtn" href="https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrlEnc}" target="_blank" rel="noopener">X</a>
    <a class="sbtn" href="https://www.facebook.com/sharer/sharer.php?u=${shareUrlEnc}" target="_blank" rel="noopener">Facebook</a>
    <a class="sbtn" href="mailto:?subject=${shareText}&body=${shareUrlEnc}">Email</a>
  </div>
</div>`;

  const html = head(`${esc(s.headline)} — Greene MMA`, metaExtra) + `
<div class="progress" id="progress" aria-hidden="true"></div>` + NAV + `
<header class="hero"><div class="wrap">
  <span class="cat">${esc(s.category || "News")}</span>${original ? '<span class="origbadge">Greene MMA Original</span>' : ""}
  <h1>${esc(s.headline)}</h1>
  <div class="meta">
    ${published ? `<span>${timeAgo(published)}</span>` : ""}
    ${original ? `<span>by ${esc(author)}</span>` : `<span>via ${esc(s.sourceName || "")}</span>`}
  </div>
</div></header>
<div class="wrap"><div class="rule"></div>
  <div class="body">${bodyHtml}</div>
  ${shareRow}
  ${credit}
</div>
<script>
(function(){
  var bar=document.getElementById('progress');
  if(!bar) return;
  var ticking=false;
  function update(){
    var h=document.documentElement;
    var max=h.scrollHeight-h.clientHeight;
    bar.style.width=(max>0?(h.scrollTop/max*100):0)+'%';
    ticking=false;
  }
  addEventListener('scroll',function(){ if(!ticking){ ticking=true; requestAnimationFrame(update); } },{passive:true});
  update();
})();
(function(){
  var b=document.getElementById('shareGo'); if(!b) return;
  var t=document.getElementById('shareGoTxt');
  var url=b.dataset.url, title=b.dataset.title;
  if(navigator.share) t.textContent='Share';
  else t.textContent='Copy link';
  b.addEventListener('click',async function(){
    if(navigator.share){
      try{ await navigator.share({title:title,text:title,url:url}); return; }
      catch(e){ if(e && e.name==='AbortError') return; }
    }
    try{ await navigator.clipboard.writeText(url); }
    catch(e){
      var ta=document.createElement('textarea'); ta.value=url; ta.setAttribute('readonly','');
      ta.style.position='absolute'; ta.style.left='-9999px';
      document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); }catch(_){}
      document.body.removeChild(ta);
    }
    t.textContent='Link copied'; b.classList.add('done');
    setTimeout(function(){ t.textContent=navigator.share?'Share':'Copy link'; b.classList.remove('done'); },2200);
  });
})();
</script>
${others.length ? `<div class="more"><div class="wrap wide">
  <h2>More from the corner</h2>
  <div class="feed">${others.map((o) => `
    <a class="card" href="/s/${encodeURIComponent(o.id)}">
      <span class="c">${esc(o.category || "News")}</span>
      <h3>${esc(o.headline)}</h3>
      <p>${esc(o.summary || "")}</p>
    </a>`).join("")}
  </div><a class="back" href="/">← All news</a>
</div></div>` : ""}
${FOOTER}
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      /* max-age=0 so a reader's own refresh always revalidates — editing a
         story and seeing the old text come back reads as a failed save.
         The edge still absorbs the traffic: fresh for 30s, then it serves
         the stale copy while fetching the new one behind it. */
      "cache-control": "public, max-age=0, s-maxage=30, stale-while-revalidate=300",
    },
  });
}

export const config = { path: "/s/:id" };
