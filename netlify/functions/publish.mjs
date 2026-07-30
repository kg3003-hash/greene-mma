// GREENE MMA — Publish pipeline
// Posts a hype card to X and/or Instagram. All credentials live in Netlify
// env vars and never touch the browser.
//
// Required env vars:
//   STUDIO_KEY                  — the passcode for studio.html
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
//   IG_USER_ID, IG_ACCESS_TOKEN — Instagram Business account + long-lived token
//   FIREBASE_SERVICE_ACCOUNT    — same one the aggregator uses
//   FIREBASE_STORAGE_BUCKET     — e.g. your-project.appspot.com

import { TwitterApi } from "twitter-api-v2";
import admin from "firebase-admin";
import crypto from "node:crypto";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

// Instagram needs a publicly reachable image URL, so the card goes to
// Firebase Storage first and is made public.
async function hostImage(base64, label) {
  const bucket = admin.storage().bucket();
  const name = `hype-cards/${Date.now()}-${label}-${crypto.randomBytes(4).toString("hex")}.jpg`;
  const file = bucket.file(name);
  await file.save(Buffer.from(base64, "base64"), {
    metadata: { contentType: "image/jpeg" },
  });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/${name}`;
}

async function postToX({ imageBase64, caption, handle }) {
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
  const mediaId = await client.v1.uploadMedia(Buffer.from(imageBase64, "base64"), {
    mimeType: "image/jpeg",
  });
  // Note: posts containing links cost far more per write on X's pay-per-use
  // pricing, so the card and the tag go out clean. Put the link in a reply.
  const text = handle ? `${caption}\n\n${handle.startsWith("@") ? handle : "@" + handle}` : caption;
  const tweet = await client.v2.tweet({ text, media: { media_ids: [mediaId] } });
  return `posted — id ${tweet.data.id}`;
}

async function igPublish({ imageUrl, caption, isStory, igHandle }) {
  const base = `https://graph.facebook.com/v21.0/${process.env.IG_USER_ID}`;
  const token = process.env.IG_ACCESS_TOKEN;

  const params = new URLSearchParams({ image_url: imageUrl, access_token: token });
  if (isStory) {
    params.set("media_type", "STORIES");
  } else {
    params.set("caption", caption + (igHandle ? `\n\n${igHandle.startsWith("@") ? igHandle : "@" + igHandle}` : ""));
    if (igHandle) {
      // Tag the fighter on the image itself (feed posts only)
      params.set(
        "user_tags",
        JSON.stringify([{ username: igHandle.replace(/^@/, ""), x: 0.5, y: 0.5 }])
      );
    }
  }

  const create = await fetch(`${base}/media`, { method: "POST", body: params });
  const created = await create.json();
  if (!created.id) throw new Error(created.error?.message || "container failed");

  const pub = await fetch(`${base}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: created.id, access_token: token }),
  });
  const published = await pub.json();
  if (!published.id) throw new Error(published.error?.message || "publish failed");
  return `posted — id ${published.id}`;
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Auth
  if (req.headers.get("x-studio-key") !== process.env.STUDIO_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400 });
  }
  if (body.ping) return new Response(JSON.stringify({ ok: true }), { status: 200 });

  const results = [];
  const { targets = [], caption = "", xHandle, igHandle, postImage, storyImage } = body;

  // X
  if (targets.includes("x")) {
    try {
      const msg = await postToX({ imageBase64: postImage, caption, handle: xHandle });
      results.push({ target: "X", ok: true, message: msg });
    } catch (err) {
      results.push({ target: "X", ok: false, message: err.message });
    }
  }

  // Instagram feed
  if (targets.includes("ig_feed")) {
    try {
      const url = await hostImage(postImage, "feed");
      const msg = await igPublish({ imageUrl: url, caption, isStory: false, igHandle });
      results.push({ target: "Instagram feed", ok: true, message: msg });
    } catch (err) {
      results.push({ target: "Instagram feed", ok: false, message: err.message });
    }
  }

  // Instagram story
  // Meta's API cannot attach the @mention sticker to a story — that sticker is
  // what notifies the fighter and lets them one-tap reshare. So the story is
  // published here, and the mention gets added by hand if the reshare matters.
  if (targets.includes("ig_story")) {
    try {
      const url = await hostImage(storyImage || postImage, "story");
      const msg = await igPublish({ imageUrl: url, isStory: true });
      results.push({
        target: "Instagram story",
        ok: true,
        message: msg + " — no mention sticker (API limit), add by hand for the reshare",
      });
    } catch (err) {
      results.push({ target: "Instagram story", ok: false, message: err.message });
    }
  }

  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

