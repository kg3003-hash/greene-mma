/* GREENE MMA — the fight-week pulse.
   The site knows when the next card starts but never says so outside the
   Fight Week page, so it reads the same on a dead Tuesday as it does an hour
   before a main event. This puts a small live chip in the nav on every page
   and escalates it as the card approaches:

     > 24h    quiet, steel      MEDIC VS RODRIGUEZ · T-MINUS 2 DAYS
     < 24h    volt              TONIGHT · T-MINUS 5H
     started  red, pulsing      LIVE NOW · MEDIC VS RODRIGUEZ

   Reads site/fightweek straight over the Firestore REST API — one small GET,
   no SDK — so it can run on pages that never load Firebase. The key below is
   the same public web key already shipped in every page of this site;
   Firestore rules are what protect the data, not this string. */
(function () {
  var KEY = 'AIzaSyCN2eOBaQBiZDOexipJ-KS7pqkOaNJq7gU';
  var URL_ = 'https://firestore.googleapis.com/v1/projects/bragging-rights-public/'
           + 'databases/(default)/documents/site/fightweek?key=' + KEY;
  // how long after the first bell we keep calling a card live
  var LIVE_WINDOW_MS = 5 * 60 * 60 * 1000;

  function val(v) {
    if (!v) return null;
    var k = Object.keys(v)[0];
    if (k === 'mapValue') {
      var o = {}, f = v.mapValue.fields || {};
      for (var a in f) o[a] = val(f[a]);
      return o;
    }
    if (k === 'arrayValue') return (v.arrayValue.values || []).map(val);
    if (k === 'integerValue') return +v.integerValue;
    return v[k];
  }

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  function lastName(n) {
    var parts = String(n || '').trim().split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
  }

  function state(startMs) {
    var diff = startMs - Date.now();
    if (diff <= 0) {
      return diff > -LIVE_WINDOW_MS ? { key: 'live', text: 'Live now' } : null;
    }
    var hrs = diff / 3600000;
    if (hrs >= 24) {
      var days = Math.round(hrs / 24);
      return { key: 'soon', text: 'T-minus ' + days + (days === 1 ? ' day' : ' days') };
    }
    if (hrs >= 1) return { key: 'today', text: 'Tonight · T-minus ' + Math.floor(hrs) + 'h' };
    var mins = Math.max(1, Math.floor(diff / 60000));
    return { key: 'today', text: 'Starting in ' + mins + 'm' };
  }

  function render(chip, h, startMs) {
    var st = state(startMs);
    if (!st) { chip.style.display = 'none'; return false; }
    chip.style.display = '';
    chip.className = 'fw-chip fw-' + st.key;
    var bout = h && h.favourite && h.underdog
      ? lastName(h.favourite.name) + ' vs ' + lastName(h.underdog.name) : '';
    chip.innerHTML = (st.key === 'live' ? '<span class="dot"></span>' : '') +
      '<span class="lbl">' + esc(st.text) + '</span>' +
      (bout ? '<span class="bout">' + esc(bout) + '</span>' : '');
    chip.setAttribute('title', bout ? bout + ' — ' + st.text : st.text);
    fit(chip);
    return true;
  }

  /* The nav row is capped at 1060px and already runs full on the homepage,
     where the league button also sits. Rather than guess a breakpoint, drop
     the fighters' names whenever the row would otherwise overflow — pages
     with more room keep them. */
  function fit(chip) {
    var wrap = chip.parentElement;
    if (!wrap) return;
    chip.classList.remove('fw-compact');
    if (wrap.scrollWidth > wrap.clientWidth) chip.classList.add('fw-compact');
  }

  function mount() {
    var wrap = document.querySelector('nav .wrap');
    if (!wrap || document.querySelector('.fw-chip')) return null;
    var a = document.createElement('a');
    a.className = 'fw-chip';
    a.href = '/fightweek.html';
    a.style.display = 'none';
    wrap.appendChild(a);
    return a;
  }

  function start() {
    var chip = mount();
    if (!chip) return;
    fetch(URL_, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) {
        if (!doc || !doc.fields) { chip.remove(); return; }
        var h = val(doc.fields.headline);
        var startMs = h && h.startTime ? new Date(h.startTime).getTime() : NaN;
        if (!isFinite(startMs)) { chip.remove(); return; }
        if (!render(chip, h, startMs)) { chip.remove(); return; }
        // keep the countdown honest without hammering anything
        setInterval(function () { render(chip, h, startMs); }, 60000);
        var t;
        window.addEventListener('resize', function () {
          clearTimeout(t); t = setTimeout(function () { fit(chip); }, 150);
        });
      })
      .catch(function () { chip.remove(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else { start(); }

  // exposed like GMArt/GMUi so the escalation thresholds can be exercised
  // without waiting for a real fight night to come around
  window.GMPulse = { state: state, render: render, lastName: lastName };
})();
