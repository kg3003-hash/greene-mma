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

  return { stagger: stagger, tabs: tabs };
})();
