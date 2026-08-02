/* GREENE MMA — motion for state changes.
   The site animates plenty on first load and then goes still: switch a
   division or a filter and content swaps instantly, which reads as a page
   redraw rather than a response. These two helpers cover that.

   GMUi.stagger(nodes)  — brings a freshly rendered list in, item by item.
   GMUi.tabs(container) — slides the volt pill to the active tab instead of
                          having it blink from one place to another.

   Both no-op safely if the elements are not there, and both are wired to
   respect prefers-reduced-motion through the CSS in site.css. */
window.GMUi = (function () {
  /* Rows arrive one after another rather than all at once. The cap keeps a
     long roster from turning the tail of the list into a slow reveal. */
  function stagger(nodes, step, maxDelay) {
    var list = typeof nodes === 'string' ? document.querySelectorAll(nodes) : nodes;
    if (!list) return;
    step = step || 26;
    maxDelay = maxDelay == null ? 420 : maxDelay;
    Array.prototype.forEach.call(list, function (el, i) {
      el.style.setProperty('--i', Math.min(i * step, maxDelay) + 'ms');
      el.classList.add('gm-stagger');
    });
  }

  /* A single volt pill that travels to whichever tab is active. The buttons
     keep their own styling when this never runs, so a JS failure just leaves
     the original solid-fill active state. */
  function tabs(container, activeSel) {
    var el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!el) return;
    activeSel = activeSel || '.on';
    el.classList.add('gm-tabs');
    var ind = el.querySelector(':scope > .gm-ind');
    if (!ind) {
      ind = document.createElement('span');
      ind.className = 'gm-ind';
      ind.setAttribute('aria-hidden', 'true');
      el.appendChild(ind);
    }
    var move = function () {
      var on = el.querySelector(activeSel);
      if (!on) { ind.style.opacity = '0'; return; }
      ind.style.opacity = '1';
      ind.style.left = on.offsetLeft + 'px';
      ind.style.top = on.offsetTop + 'px';
      ind.style.width = on.offsetWidth + 'px';
      ind.style.height = on.offsetHeight + 'px';
      el.classList.add('gm-hasind');
    };
    move();
    // the pill is measured in pixels, so it has to be re-measured when the
    // row rewraps at a new width
    if (!el.__gmResize) {
      var t;
      el.__gmResize = function () { clearTimeout(t); t = setTimeout(move, 120); };
      window.addEventListener('resize', el.__gmResize);
    }
    el.__gmMove = move;
    return move;
  }

  /* Back to top. The homepage runs about eleven screens on a phone and there
     was no way back up. Only mounts where the page is actually long enough to
     need it, and the control is the mark itself. */
  function backToTop(minPages) {
    if (document.querySelector('.gm-top')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'gm-top';
    b.setAttribute('aria-label', 'Back to top');
    b.innerHTML = '<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M104.35,41.63 78.37,15.65 41.63,15.65 15.65,41.63 15.65,78.37 41.63,104.35 78.37,104.35 104.35,78.37 104.35,64 71,64" fill="none" stroke="#C9F73A" stroke-width="11" stroke-linejoin="miter"/></svg>';
    b.addEventListener('click', function () {
      var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    });
    document.body.appendChild(b);
    /* The page height is measured once here and again on resize, never on
       scroll: reading scrollHeight forces layout, and doing that on every
       scroll event is the expensive way to build this. The scroll path then
       only reads scrollY and toggles a class, which is cheap enough to run
       directly — no requestAnimationFrame gate, so the control still behaves
       when rAF is throttled. */
    var threshold = 0, longEnough = false;
    function measure() {
      var vh = window.innerHeight || 800;
      threshold = vh * 1.4;
      longEnough = document.documentElement.scrollHeight > (minPages || 3) * vh;
      if (!longEnough) b.classList.remove('on');
    }
    function onScroll() {
      if (!longEnough) return;
      b.classList.toggle('on', window.scrollY > threshold);
    }
    measure(); onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t); t = setTimeout(function () { measure(); onScroll(); }, 150);
    });
    /* These pages are short at DOMContentLoaded and only get long once the
       feed, roster or rankings arrive — measuring once at mount would mean
       the control never appears on exactly the pages that need it. Re-measure
       whenever the document actually changes height. */
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { measure(); onScroll(); });
      ro.observe(document.body);
    } else {
      var seen = document.documentElement.scrollHeight;
      setInterval(function () {
        var h = document.documentElement.scrollHeight;
        if (h !== seen) { seen = h; measure(); onScroll(); }
      }, 1000);
    }
    return b;
  }

  /* Containers marked aria-busy start out saying "Loading…". Once their
     contents are replaced — with stories, or with an error, either way the
     wait is over — drop the busy flag so a screen reader is not told the
     page is still loading forever. */
  function watchBusy() {
    if (!window.MutationObserver) return;
    Array.prototype.forEach.call(document.querySelectorAll('[aria-busy="true"]'), function (el) {
      var mo = new MutationObserver(function () {
        el.setAttribute('aria-busy', 'false');
        mo.disconnect();
      });
      mo.observe(el, { childList: true });
    });
  }

  // long pages get the control automatically
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { backToTop(); watchBusy(); });
  } else { backToTop(); watchBusy(); }

  return { stagger: stagger, tabs: tabs, backToTop: backToTop };
})();
