/* GREENE MMA — generated card art.
   No photography anywhere on this site, so a story card's artwork has to
   carry the visual load. Every composition is derived from the story's own
   id, which means each story looks like itself — the same story renders
   identically on the homepage, the archive and anywhere else, and no two
   cards in a feed look alike. Pure CSS variables; nothing is downloaded.

   Exposes window.GMArt.art(category, seed, original) -> HTML string. */
window.GMArt = (function () {
  var MARK = '<path d="M104.35,41.63 78.37,15.65 41.63,15.65 15.65,41.63 15.65,78.37 41.63,104.35 78.37,104.35 104.35,78.37 104.35,64 71,64" fill="none" stroke="currentColor" stroke-width="11" stroke-linejoin="miter"/>';

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  /* FNV-1a: the same string always produces the same composition. */
  function hash(str) {
    var h = 2166136261, s = String(str || '');
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  /* mulberry32 — small, well-distributed, deterministic from the hash */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Category decides the accent, sparingly. Volt is the house colour and
     stays the default — an earlier version cooled "Results" to steel and,
     because most of the wire is results, three quarters of the feed went
     grey and the page lost its charge. So only the genuinely different
     things get a different colour: live cards go red, our own writing goes
     pale lime. Everything else is volt, and the variety comes from the
     composition instead of the hue. */
  var TINTS = {
    volt: '201,247,58',
    foam: '233,255,143',
    red:  '255,75,62',
  };
  function tintFor(cat, original) {
    var c = String(cat || '').toLowerCase();
    if (/live|weigh|tonight/.test(c)) return TINTS.red;
    if (original || /corner|original|feature/.test(c)) return TINTS.foam;
    return TINTS.volt;
  }

  function art(cat, seed, original) {
    var r = rng(hash(seed || cat || 'greene'));
    var pick = function (min, max) { return min + r() * (max - min); };
    var round = function (n) { return Math.round(n * 10) / 10; };

    var vars = [
      '--a-tint:' + tintFor(cat, original),
      '--a-bg-angle:' + round(pick(105, 190)) + 'deg',
      '--a-glow-x:' + round(pick(4, 92)) + '%',
      '--a-glow-y:' + round(pick(78, 124)) + '%',
      '--a-glow-size:' + round(pick(62, 108)) + '%',
      '--a-skew:' + round(pick(-27, -6)) + 'deg',
      '--a-stripe-x:' + round(pick(-22, 46)) + '%',
      '--a-dot-angle:' + round(pick(120, 260)) + 'deg',
      // the big mark, bottom-right by default but roaming
      '--a-m1-size:' + round(pick(96, 158)) + 'px',
      '--a-m1-x:' + round(pick(-40, 4)) + 'px',
      '--a-m1-y:' + round(pick(-44, 2)) + 'px',
      '--a-m1-rot:' + round(pick(-22, 22)) + 'deg',
      '--a-m1-op:' + round(pick(0.34, 0.6)),
      // a second, quieter octagon so compositions differ in structure,
      // not just in position — half the cards get a visible one
      '--a-m2-size:' + round(pick(46, 92)) + 'px',
      '--a-m2-x:' + round(pick(-10, 58)) + 'px',
      '--a-m2-y:' + round(pick(-26, 12)) + 'px',
      '--a-m2-rot:' + round(pick(-30, 30)) + 'deg',
      '--a-m2-op:' + (r() > 0.45 ? round(pick(0.12, 0.26)) : 0),
    ].join(';');

    return '<div class="art" style="' + vars + '" aria-hidden="true">' +
      '<div class="glow"></div><div class="dots"></div><div class="stripe"></div>' +
      '<div class="tagbig">' + esc(cat || 'News') + '</div>' +
      '<svg class="m1" viewBox="0 0 120 120">' + MARK + '</svg>' +
      '<svg class="m2" viewBox="0 0 120 120">' + MARK + '</svg>' +
      '</div>';
  }

  return { art: art, tintFor: tintFor, TINTS: TINTS };
})();
