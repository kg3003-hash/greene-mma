/* GREENE MMA — the small markdown subset the Studio writes.
   ------------------------------------------------------------------
   The Studio's formatting bar produces a handful of markers, and the email
   template in netlify/functions/lib/mail.mjs turns them into a styled issue.
   The public archive at /newsletter.html did not: it escaped the body and
   wrapped paragraphs in <p>, so a subscriber read a formatted email while
   the same issue on the site showed **bold** and ## Heading as literal
   characters.

   Same rules as mdToEmailHtml, in the same order, so what is written once
   reads the same in both places. The difference is deliberate and only
   cosmetic: this emits bare tags and lets the page's stylesheet dress them,
   where the email bakes styles inline because mail clients discard <style>.

   Escaping happens FIRST and the rules run over escaped text, so a body
   containing markup is displayed, never executed.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(t) {
    // Links first: later rules must not chew through a URL.
    t = t.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,400})\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\*\*([^*]{1,300})\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]{1,300})__/g, '<u>$1</u>');
    // The leading group stops this from eating the inner halves of ** pairs.
    t = t.replace(/(^|[^*])\*([^*\n]{1,300})\*/g, '$1<em>$2</em>');
    return t;
  }

  function render(src) {
    var lines = esc(String(src || '')).split(/\r?\n/);
    var out = [], list = null, para = [];
    function flushPara() {
      if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
    }
    function flushList() { if (list) { out.push('</' + list + '>'); list = null; } }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim(), m;
      if (!line) { flushPara(); flushList(); continue; }
      if (/^---+$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
      if ((m = line.match(/^###\s+(.*)$/))) { flushPara(); flushList(); out.push('<h3>' + inline(m[1]) + '</h3>'); continue; }
      if ((m = line.match(/^##\s+(.*)$/)))  { flushPara(); flushList(); out.push('<h2>' + inline(m[1]) + '</h2>'); continue; }
      // esc() has already turned a leading "> " into "&gt; ".
      if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); continue; }
      if ((m = line.match(/^[-*]\s+(.*)$/))) {
        flushPara();
        if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inline(m[1]) + '</li>'); continue;
      }
      if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inline(m[1]) + '</li>'); continue;
      }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return out.join('\n');
  }

  window.GMMarkdown = { render: render, esc: esc };
})();
