# GREENE MMA 🟩

Fight news from the Greene corner. Static site + scheduled news bot.

**Stack:** vanilla JS · Firebase (Firestore) · Netlify · Anthropic API

---

## How it works

1. `netlify/functions/aggregate.mjs` runs every 2 hours (cron in the file).
2. It pulls MMA news RSS feeds, skips anything already published, and rewrites up to 8 new stories in the brand voice via the Anthropic API — original wording, always credited and linked to the source.
3. Stories land in the Firestore `stories` collection.
4. `index.html` reads the newest 13 stories: #1 becomes the lead story, the rest fill The Feed. If Firestore is empty or unreachable, the designed placeholders stay — the page never breaks.

## Setup (one time, ~20 min)

### 1. GitHub
Create the new repo, drop these files in, push.

### 2. Firebase (reusing the greene.bet project)
- Firestore → the bot will create the `stories` collection on first run, nothing to make manually.
- Publish the security rules from `firestore.rules` (Firestore → Rules tab → paste → Publish).
- Project settings → Your apps → copy the **web config** and paste it into the `firebaseConfig` block near the bottom of `index.html`.
- Project settings → Service accounts → **Generate new private key**. Keep the JSON file for step 3. Never commit it.

### 3. Netlify
- Add new site → import the GitHub repo. Build settings come from `netlify.toml` automatically.
- Site configuration → Environment variables → add:
  - `ANTHROPIC_API_KEY` — from console.anthropic.com
  - `FIREBASE_SERVICE_ACCOUNT` — paste the **entire contents** of the service account JSON as the value
- Deploy.

### 4. Subdomain
- Netlify → Domain management → add custom domain `mma.greene.bet`.
- In your DNS (wherever greene.bet lives): add a CNAME record, host `mma`, pointing to your Netlify site URL (e.g. `something.netlify.app`).

### 5. First run
- Netlify → Logs → Functions → `aggregate` → **Trigger** to run it manually.
- Check the log for "Run complete" and refresh the site — real stories should replace the placeholders.

## Costs
- Netlify + Firebase: free tiers cover this easily at launch.
- Anthropic API: ~8 small rewrites every 2 hours ≈ pennies per day.

## Not built yet (next phases)
- X/Twitter auto-posting (needs paid X API or a scheduler tool)
- Newsletter capture wiring (form is designed, needs a provider like Buttondown/Beehiiv)
- Affiliate links in the Picks section
- Split Decision show pages

---

## The Studio (`/studio`)

Private hype card generator + publisher. Not linked anywhere on the site.

**Extra env vars needed in Netlify:**

| Variable | Where it comes from |
|---|---|
| `STUDIO_KEY` | Make one up. This is your passcode. |
| `X_API_KEY` / `X_API_SECRET` | developer.x.com → your app → Keys and tokens |
| `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | Same page, generate with **Read and Write** permission |
| `IG_USER_ID` | Your Instagram Business account ID (via the linked Facebook Page) |
| `IG_ACCESS_TOKEN` | Long-lived Instagram token — **expires every 60 days, must be refreshed** |
| `FIREBASE_STORAGE_BUCKET` | e.g. `your-project.appspot.com` |

**Instagram requirements:** the account must be a Business or Creator account linked to a Facebook Page, and the app needs `instagram_basic` + `instagram_content_publish` permissions through Meta app review.

**Known platform limits:**
- Instagram's API cannot attach a **@mention sticker** to a Story. Stories publish fine, but the sticker that notifies the fighter and enables one-tap reshare has to be added by hand. Feed posts *can* tag users automatically.
- X charges per post on pay-per-use pricing, and a post containing a **link** costs roughly 13× a plain one. Cards go out link-free; put the site link in a reply.

---

## Live data (added v5)

**New functions**
- `odds.mjs` — pulls MMA moneylines from The Odds API every 6 hours into `site/fightweek`. Drives the ticker, Fight Week tape, and the fallback Live Dogs.
- `site.mjs` — saves your written picks from the studio (`site/picks`) and captures newsletter signups (`subscribers`).

**New env var:** `ODDS_API_KEY` (from the-odds-api.com — the same key greene.bet uses).

**Important:** if the odds feed is empty or the API key is missing, the Fight Week and Live Dogs sections **hide themselves** rather than showing placeholder numbers. Nothing invented ever appears on the live site.

**New pages**
- `story.html?id=...` — individual story pages. Feed cards now link here instead of straight off-site, so readers stay with you. The page shows your take plus a prominent credit and link to the original reporting.
- `utah.html` — now animated (logo draw-on, staggered scroll reveals).

**Newsletter:** signups save to the `subscribers` collection in Firestore. Export them any time from the studio, or wire a provider like Beehiiv later — the list is yours either way.

**Share cards:** `assets/share-card.png` is what shows when a link is posted to X, Instagram, or texted.

**Firestore rules:** re-publish `firestore.rules` — it now covers `site` and `subscribers` too. Remember to keep your existing Bragging Rights rules below the marked line.
