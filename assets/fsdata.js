/* GREENE MMA — Firestore over plain HTTPS.
   ------------------------------------------------------------------
   Why this exists.

   The Firestore Web SDK does not fetch data, it opens a WebChannel — a
   long-lived streaming connection. Plenty of networks quietly break that:
   corporate wifi, VPNs, some mobile carriers, ad blockers, privacy
   extensions. When it happens the SDK doesn't fail, it waits out an internal
   timeout and then falls back to long-polling. That wait is 10-15 seconds,
   which is exactly the "nothing, nothing, nothing, everything at once" the
   site was doing. On top of that the SDK is a few hundred KB fetched from
   gstatic before a single byte of real data is requested, and if a blocker
   eats that request the page waits forever with no way to recover.

   Every read this site does is public and read-only. Firestore's REST API
   serves those with one ordinary fetch: no streaming, no handshake, nothing
   for a proxy to object to, cacheable, and abortable. So we use that.

   The API key is public by design — it identifies the project, it does not
   grant anything. Security comes from Firestore rules, which allow reads on
   exactly these documents and nothing else.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var PROJECT = 'bragging-rights-public';
  var KEY = 'AIzaSyCN2eOBaQBiZDOexipJ-KS7pqkOaNJq7gU';
  var ROOT = 'https://firestore.googleapis.com/v1/projects/' + PROJECT +
             '/databases/(default)/documents';
  var TIMEOUT_MS = 8000;   // a read that takes longer than this is not coming
  var RETRIES = 1;         // one more go, for a dropped connection

  /* ---------- decoding ----------
     REST hands back tagged values ({stringValue:"x"}) rather than plain JSON,
     so unwrap them into ordinary JS. */

  // Timestamps arrive as ISO strings. Pages read them as Firestore Timestamps
  // — some call .toDate(), some read .seconds — so hand back something that
  // answers to both rather than rewriting every call site.
  function stamp(iso) {
    var d = new Date(iso);
    var ms = d.getTime();
    return {
      seconds: Math.floor(ms / 1000),
      nanoseconds: (ms % 1000) * 1e6,
      toDate: function () { return new Date(ms); },
      toMillis: function () { return ms; },
      toISOString: function () { return d.toISOString(); },
    };
  }

  function decodeValue(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('timestampValue' in v) return stamp(v.timestampValue);
    if ('nullValue' in v) return null;
    if ('referenceValue' in v) return String(v.referenceValue).split('/documents/')[1] || v.referenceValue;
    if ('geoPointValue' in v) return { latitude: v.geoPointValue.latitude, longitude: v.geoPointValue.longitude };
    if ('bytesValue' in v) return v.bytesValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
    if ('mapValue' in v) return decodeFields(v.mapValue.fields);
    return null;
  }

  function decodeFields(fields) {
    var out = {};
    if (!fields) return out;
    for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) {
      out[k] = decodeValue(fields[k]);
    }
    return out;
  }

  // A document's id is the last segment of its resource name.
  function idOf(name) {
    var parts = String(name || '').split('/');
    return parts[parts.length - 1];
  }

  /* ---------- transport ----------
     Bounded and retried, because the whole point is that a read either lands
     or reports back — it never hangs the page. */

  function once(url, init, ms) {
    // AbortController is what makes the timeout real: without it a stalled
    // request keeps its connection and the promise simply never settles.
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    var opts = Object.assign({}, init, ctl ? { signal: ctl.signal } : {});
    return fetch(url, opts).then(function (res) {
      clearTimeout(timer);
      if (res.status === 404) return null;            // missing doc, not an error
      if (!res.ok) throw new Error('Firestore ' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw (err && err.name === 'AbortError') ? new Error('timed out after ' + ms + 'ms') : err;
    });
  }

  function request(url, init, opts) {
    opts = opts || {};
    var ms = opts.timeout || TIMEOUT_MS;
    var left = opts.retries == null ? RETRIES : opts.retries;
    function attempt(n) {
      return once(url, init, ms).catch(function (err) {
        if (n <= 0) throw err;
        // A short pause: an instant retry usually hits the same dead socket.
        return new Promise(function (r) { setTimeout(r, 400); }).then(function () { return attempt(n - 1); });
      });
    }
    return attempt(left);
  }

  /* ---------- public surface ---------- */

  /* Reads are memoised by path for the life of the page load. Two reasons.
     One, a couple of pages genuinely read the same document twice. Two, and
     the point of it: it lets a page fire all of its reads at once with
     prefetch() and then keep its existing straight-line `await` code, which
     now resolves against requests already in flight instead of starting a new
     round trip each time. Rewriting those pages to await in parallel by hand
     would have meant restructuring rendering logic that works.
     Failures are evicted so a later attempt is a real attempt. */
  var inflight = {};

  // One document. `path` is "site/fightweek" or "stories/abc123".
  // Resolves to the decoded fields, or null when it does not exist.
  function getDoc(path, opts) {
    var key = String(path).replace(/^\/+/, '');
    if (!(opts && opts.fresh) && inflight[key]) return inflight[key];
    var url = ROOT + '/' + key + '?key=' + KEY;
    var p = request(url, { cache: 'no-cache' }, opts).then(function (json) {
      if (!json || !json.fields) return null;
      var out = decodeFields(json.fields);
      out.id = idOf(json.name);
      return out;
    });
    p.catch(function () { delete inflight[key]; });
    inflight[key] = p;
    return p;
  }

  // Start several reads at once without waiting on them. Pages call this
  // before their render code runs; each later getDoc then joins the request
  // already on the wire. Turns N stacked round trips into one.
  function prefetch(paths) {
    (paths || []).forEach(function (p) { getDoc(p).catch(function () {}); });
  }

  // An ordered slice of a collection.
  //   runQuery('stories', { orderBy:'publishedAt', desc:true, limit:30 })
  // `startAfter` takes the raw orderBy value of the last row you already have,
  // which is how the news archive pages through.
  function runQuery(collection, o, opts) {
    o = o || {};
    var sq = { from: [{ collectionId: collection }] };
    if (o.orderBy) {
      sq.orderBy = [{ field: { fieldPath: o.orderBy }, direction: o.desc ? 'DESCENDING' : 'ASCENDING' }];
    }
    if (o.limit) sq.limit = o.limit;
    if (o.startAfter != null) {
      // `before:false` is what turns startAt into startAfter.
      sq.startAt = { values: [encodeCursor(o.startAfter)], before: false };
    }
    return request(ROOT + ':runQuery?key=' + KEY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ structuredQuery: sq }),
      cache: 'no-cache',
    }, opts).then(function (rows) {
      if (!Array.isArray(rows)) return [];
      // Rows without a document are read-time markers; drop them.
      return rows.filter(function (r) { return r && r.document; }).map(function (r) {
        var out = decodeFields(r.document.fields);
        out.id = idOf(r.document.name);
        return out;
      });
    });
  }

  function encodeCursor(v) {
    if (v == null) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (v && typeof v.toDate === 'function') return { timestampValue: v.toDate().toISOString() };  // our stamp shim
    return { stringValue: String(v) };
  }

  // Run reads together instead of one after another, and let individual
  // failures come back as null rather than taking the whole page down with
  // them. This is the difference between one wait and seven stacked waits.
  function all(map) {
    var keys = Object.keys(map);
    return Promise.all(keys.map(function (k) {
      return Promise.resolve(map[k]).catch(function (e) {
        console.warn('read failed: ' + k, e && e.message);
        return null;
      });
    })).then(function (vals) {
      var out = {};
      keys.forEach(function (k, i) { out[k] = vals[i]; });
      return out;
    });
  }

  window.FS = {
    doc: getDoc,
    prefetch: prefetch,
    query: runQuery,
    all: all,
    timestamp: stamp,
    ROOT: ROOT,
    KEY: KEY,
    PROJECT: PROJECT,
  };

  /* ---------- SDK-shaped shims ----------
     The pages were written against the Firestore SDK, and their rendering
     logic is fine — it was only ever the transport that misbehaved. So rather
     than rewrite eleven pages of working code, these mirror the handful of
     SDK calls the site actually uses and answer them over REST. A page swaps
     its two gstatic imports for one destructure and keeps everything else.

     Deliberately not a general Firestore client: it covers doc reads and
     ordered/limited collection queries, which is the whole of what this site
     asks for. Anything else should use FS.doc / FS.query directly. */
  function docRef(_db, coll, id) { return { __path: coll + '/' + id }; }
  function collectionRef(_db, name) { return { __coll: name }; }
  function orderByOp(field, dir) { return { __orderBy: field, __desc: String(dir).toLowerCase() === 'desc' }; }
  function limitOp(n) { return { __limit: n }; }
  function startAfterOp(v) { return { __startAfter: v }; }
  function queryOp(base) {
    var q = { __coll: base && base.__coll };
    for (var i = 1; i < arguments.length; i++) Object.assign(q, arguments[i] || {});
    return q;
  }
  // Mirrors DocumentSnapshot closely enough for the call sites here:
  // .exists(), .id and .data().
  function getDocCompat(ref, opts) {
    return getDoc(ref.__path, opts).then(function (d) {
      return {
        exists: function () { return !!d; },
        id: d ? d.id : ref.__path.split('/').pop(),
        data: function () { return d || undefined; },
      };
    });
  }
  // Mirrors QuerySnapshot: .docs[], .empty, .size.
  function getDocsCompat(q, opts) {
    return runQuery(q.__coll, {
      orderBy: q.__orderBy, desc: q.__desc, limit: q.__limit, startAfter: q.__startAfter,
    }, opts).then(function (rows) {
      return {
        docs: rows.map(function (r) { return { id: r.id, data: function () { return r; }, exists: function () { return true; } }; }),
        empty: rows.length === 0,
        size: rows.length,
        forEach: function (fn) { rows.forEach(function (r) { fn({ id: r.id, data: function () { return r; } }); }); },
      };
    });
  }

  window.FSCompat = {
    initializeApp: function () { return null; },   // nothing to initialise
    getFirestore: function () { return null; },    // no connection to open
    doc: docRef,
    collection: collectionRef,
    query: queryOp,
    orderBy: orderByOp,
    limit: limitOp,
    startAfter: startAfterOp,
    getDoc: getDocCompat,
    getDocs: getDocsCompat,
  };

  /* ---------- site copy ----------
     Lived inline on nine pages and span up a second Firebase app purely to
     read one document. Same job, one fetch, no SDK. Runs itself when the page
     has anything to fill in. */
  function applyCopy() {
    var nodes = document.querySelectorAll('[data-copy]');
    if (!nodes.length) return;
    getDoc('site/copy', { timeout: 6000 }).then(function (d) {
      var blocks = (d && d.blocks) || {};
      Array.prototype.forEach.call(nodes, function (el) {
        var v = blocks[el.getAttribute('data-copy')];
        if (v && String(v).trim()) el.textContent = v;
      });
    }).catch(function () { /* the wording written into the HTML stays */ });
  }
  /* ---------- stalled-load watchdog ----------
     Reads are bounded now, but a page can still end up with nothing to show —
     a blocked request, a dead connection, a document that isn't there. Before
     this, that looked identical to "still loading": a spinner that never went
     away and no way to do anything about it.

     Every loading container on the site marks itself aria-busy="true" and
     clears it once filled, so that flag is the signal. If one is still busy
     well after any real read would have finished, say so and offer the one
     thing that actually helps. */
  var WATCHDOG_MS = 12000;

  function watchdog() {
    var hosts = document.querySelectorAll('[aria-busy="true"]');
    if (!hosts.length) return;
    setTimeout(function () {
      Array.prototype.forEach.call(hosts, function (el) {
        // Filled in the meantime, or already handled.
        if (el.getAttribute('aria-busy') !== 'true') return;
        if (el.getAttribute('data-fs-stalled')) return;
        el.setAttribute('data-fs-stalled', '1');
        el.setAttribute('aria-busy', 'false');
        el.innerHTML =
          '<div class="fs-stalled" role="alert">' +
            '<p class="fs-stalled-h">This didn\'t load.</p>' +
            '<p class="fs-stalled-p">Usually the connection rather than the site — ' +
              'a blocker or a patchy network will do it.</p>' +
            '<button type="button" class="fs-retry">Try again</button>' +
          '</div>';
        el.querySelector('.fs-retry').addEventListener('click', function () {
          location.reload();
        });
      });
    }, WATCHDOG_MS);
  }

  function boot() { applyCopy(); watchdog(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
