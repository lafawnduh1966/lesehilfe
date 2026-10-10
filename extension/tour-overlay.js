// Draws a tour stop over GitHub's PR diff (new diff view): sticky notes in a margin next
// to the code, hand-drawn marks on tokens and line ranges, connectors that only travel
// through free space, numbered badges, a spotlight on the stop, and a remote control.
// Content script; exposes globalThis.LesehilfeOverlay.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const MARGIN = 340; // room made next to the diff for notes
  const TONES = { neutral: '#0b57d0', good: '#1a7f37', risk: '#cf222e' };

  // --- Hand-drawn shapes (seeded, so a re-layout draws the same wobble) ---------------------
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const j = (a) => (rnd() - 0.5) * 2 * a;

  function roughLine(x1, y1, x2, y2, amp = 1.6) {
    let d = '';
    for (let pass = 0; pass < 2; pass++) {
      const mx = (x1 + x2) / 2 + j(amp * 1.5);
      const my = (y1 + y2) / 2 + j(amp * 1.5);
      d += `M${x1 + j(amp)},${y1 + j(amp)} Q${mx},${my} ${x2 + j(amp)},${y2 + j(amp)} `;
    }
    return d;
  }
  function roughEllipse(cx, cy, rx, ry) {
    let d = '';
    const steps = 26;
    const start = rnd() * Math.PI * 2;
    for (let i = 0; i <= steps; i++) {
      const a = start + (Math.PI * 2 * 1.12 * i) / steps;
      const k = 1 + j(0.06);
      d += `${i ? 'L' : 'M'}${cx + Math.cos(a) * rx * k},${cy + Math.sin(a) * ry * k} `;
    }
    return d;
  }
  const roughBox = (l, t, r, b) =>
    [[l, t, r, t], [r, t, r, b], [r, b, l, b], [l, b, l, t]].map((q) => roughLine(...q, 1.2)).join('');
  function roughArrow(x1, y1, x2, y2, bend) {
    const cx = (x1 + x2) / 2 - (y2 - y1) * bend + j(6);
    const cy = (y1 + y2) / 2 + (x2 - x1) * bend + j(6);
    const ang = Math.atan2(y2 - cy, x2 - cx);
    const head = [-0.45, 0.45].map((da) => roughLine(x2, y2, x2 - 11 * Math.cos(ang + da), y2 - 11 * Math.sin(ang + da), 0.6)).join('');
    return [`M${x1},${y1} Q${cx},${cy} ${x2},${y2}`, head];
  }

  // --- Reading the diff -----------------------------------------------------------------------
  const docRect = (r) => ({
    left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY, width: r.width, height: r.height,
  });
  const tableFor = (file) => document.querySelector(`table[aria-label="Diff for: ${CSS.escape(file)}"]`) ||
    [...document.querySelectorAll('table[aria-label^="Diff for"]')].find((t) => t.getAttribute('aria-label') === `Diff for: ${file}`);

  function rowCell(table, n) {
    return [...table.querySelectorAll('td.diff-text-cell')].find((c) => (c.dataset.diffLineKey || '').split('-').includes(`r:${n}`));
  }
  function textRects(code) {
    const rects = [];
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node;
    let first = true;
    while ((node = walker.nextNode())) {
      // Skip whitespace and the leading +/- diff marker.
      if (!node.data.trim() || (first && /^[+-]$/.test(node.data))) { first = false; continue; }
      first = false;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].filter((r) => r.width > 0).map(docRect));
    }
    return rects;
  }
  function tokenRect(code, token) {
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = '';
    let node;
    while ((node = walker.nextNode())) { nodes.push([node, text.length]); text += node.data; }
    const at = text.indexOf(token);
    if (at < 0) return null;
    const find = (pos) => { for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i][1] <= pos) return [nodes[i][0], pos - nodes[i][1]]; };
    const range = document.createRange();
    range.setStart(...find(at));
    range.setEnd(...find(at + token.length));
    return docRect(range.getBoundingClientRect());
  }

  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const noteHtml = (s) => escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const STYLE = `
    :host { all: initial; }
    svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
    .shade { position: absolute; background: rgba(255,255,255,0.6); pointer-events: none; }
    .ink { fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .draw { stroke-dasharray: var(--len); stroke-dashoffset: var(--len); animation: draw var(--dur, .5s) ease-out forwards; animation-delay: var(--delay, 0s); }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    .note { position: absolute; width: 270px; box-sizing: border-box; padding: 10px 12px 12px; background: #fff8b8; color: #3b3200;
      font: 17px/1.28 "Noteworthy", "Marker Felt", "Bradley Hand", "Comic Sans MS", "Comic Neue", cursive;
      box-shadow: 0 1px 1px rgba(0,0,0,.08), 0 6px 14px rgba(0,0,0,.14); border-radius: 2px 2px 6px 2px;
      pointer-events: auto; transform: rotate(var(--rot)); transition: opacity .35s, transform .35s, box-shadow .2s; }
    .note.enter { opacity: 0; transform: translateY(6px) rotate(var(--rot)); }
    .note:hover { box-shadow: 0 1px 1px rgba(0,0,0,.08), 0 10px 22px rgba(0,0,0,.22); }
    .note b { font-weight: 700; }
    .note code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(0,0,0,.06); padding: 0 3px; border-radius: 3px; }
    .note .num { display: inline-block; width: 20px; height: 20px; margin-right: 6px; border-radius: 50%; background: var(--c); color: #fff;
      font: 700 12px/20px -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; vertical-align: 2px; }
    .note.wide { width: 300px; }
    .note .muted { opacity: .65; font-size: 14px; }
    .note .actions { display: flex; gap: 6px; margin-top: 8px; opacity: 0; transition: opacity .15s; }
    .note:hover .actions, .note.current .actions, .note.has-thread .actions { opacity: 1; }
    .note .actions button { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 999px; background: rgba(59,50,0,.08);
      font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #3b3200; }
    .note .actions button:hover { background: rgba(59,50,0,.16); }
    .note .actions .level { font: 11px -apple-system, sans-serif; opacity: .6; align-self: center; margin-left: auto; }
    .note.unfolded { width: 330px; background: #fff3a0; }
    .note.dim, .badge.dim { opacity: .35 !important; }
    .note.dim:hover { opacity: .9 !important; }
    .thread { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
    .thread .q { font: 600 12px/1.35 -apple-system, BlinkMacSystemFont, sans-serif; color: #3b3200; }
    .thread .a { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #0b3d6b; background: #ddf4ff;
      border-radius: 6px; padding: 6px 8px; max-height: 180px; overflow: auto; white-space: pre-wrap; }
    .thread .a code { font: 11px ui-monospace, monospace; background: rgba(9,105,218,.1); }
    .thread .a.pending::after { content: "▍"; animation: blink 1s steps(2) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .thread .err { font: 12px -apple-system, sans-serif; color: #cf222e; }
    .thread textarea { all: unset; box-sizing: border-box; width: 100%; min-height: 34px; padding: 6px 8px; border-radius: 6px; background: #fff;
      border: 1px solid rgba(59,50,0,.25); font: 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif; color: #1f2328; white-space: pre-wrap; }
    .thread .hint { font: 11px -apple-system, sans-serif; opacity: .6; }
    .badge { position: absolute; min-width: 18px; padding: 0 4px; box-sizing: border-box; width: 18px; height: 18px; border-radius: 50%; background: var(--c); color: #fff; transition: opacity .3s;
      font: 700 11px/18px -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; box-shadow: 0 0 0 2px #fff; pointer-events: none; }
    .badge.enter { opacity: 0; }
    .conn { transition: opacity .5s; }
    .conn.faded { opacity: 0; }
    .conn.faded.hover { opacity: 1; }
    .label { position: absolute; font: 15px "Noteworthy", "Marker Felt", "Comic Sans MS", cursive; color: var(--c); transition: opacity .4s;
      transform: rotate(-90deg); transform-origin: left top; white-space: nowrap; pointer-events: none; }
    .label.enter { opacity: 0; }
  `;

  const REMOTE_STYLE = `
    :host { all: initial; }
    .remote { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 40px);
      padding: 7px 8px 7px 16px; background: #1f2328; color: #fff; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,.25);
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .flow { opacity: .65; margin-right: 6px; }
    b { font-weight: 600; }
    code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .9; }
    .status { opacity: .65; margin-left: 4px; }
    button { all: unset; cursor: pointer; flex: none; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,.12); }
    button:hover { background: rgba(255,255,255,.24); }
    button[disabled] { opacity: .35; cursor: default; }
    .card { position: fixed; left: 50%; top: 40%; transform: translate(-50%, -50%); width: 360px; padding: 16px 18px; background: #fff8b8; color: #3b3200;
      font: 17px/1.3 "Noteworthy", "Marker Felt", "Comic Sans MS", cursive; box-shadow: 0 10px 30px rgba(0,0,0,.2); border-radius: 3px; }
    .card a { color: #0b57d0; }
    .card.transition { width: 440px; padding: 18px 22px 16px; background: #fff; color: #1f2328; border-radius: 12px; border: 1px solid #d1d9e0;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 16px 40px rgba(0,0,0,.18); animation: pop .25s ease-out; }
    @keyframes pop { from { opacity: 0; transform: translate(-50%, -46%); } }
    .transition .eyebrow { font-size: 12px; color: #59636e; margin-bottom: 8px; }
    .transition .files { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; margin-bottom: 10px; }
    .transition .file { padding: 2px 8px; border-radius: 6px; background: #f6f8fa; border: 1px solid #d1d9e0; }
    .transition .file.to { background: #ddf4ff; border-color: #54aeff; }
    .transition .arrow { color: #59636e; }
    .transition .kind { display: inline-flex; gap: 6px; align-items: center; font-weight: 600; margin-bottom: 4px; }
    .transition .why { font: 18px/1.3 "Noteworthy", "Marker Felt", "Comic Sans MS", cursive; color: #3b3200; background: #fff8b8; padding: 8px 12px; border-radius: 3px; margin: 8px 0 12px; }
    .transition .role { color: #59636e; font-size: 13px; }
    .transition .hint { font-size: 12px; color: #59636e; text-align: right; }
    .transition kbd { font: 11px ui-monospace, monospace; padding: 1px 5px; border: 1px solid #d1d9e0; border-bottom-width: 2px; border-radius: 4px; background: #f6f8fa; }
  `;

  function create({ onPrev, onNext, onPrevStop, onNextStop, onReplay, onClose, onBeatAction, onThreadDraft, onThreadSend }) {
    // Drawing layer: below GitHub's sticky file header (z-index 5) and page header (11).
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:4;pointer-events:none';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    // Spotlight: four plain boxes around the stop. (One document-sized translucent SVG made
    // Chrome paint the whole page white on long files.)
    root.innerHTML = `<style>${STYLE}</style><div class="shades"></div><svg class="ink-layer"><g></g></svg><div class="notes"></div>`;
    const shades = root.querySelector('.shades');
    const svgEl = root.querySelector('.ink-layer');
    const svgInk = svgEl.querySelector('g');
    const notesEl = root.querySelector('.notes');

    const remoteHost = document.createElement('div');
    remoteHost.style.cssText = 'position:fixed;z-index:30;left:0;top:0';
    document.body.appendChild(remoteHost);
    const remoteRoot = remoteHost.attachShadow({ mode: 'open' });
    remoteRoot.innerHTML = `<style>${REMOTE_STYLE}</style><div class="remote"><span class="text"></span>
      <button class="prev-stop" title="Previous stop (Shift+←)">«</button><button class="prev" title="Back (←)">‹</button>
      <button class="next" title="Next (→)">›</button><button class="next-stop" title="Next stop (Shift+→)">»</button>
      <button class="replay" title="Replay this stop">↻</button><button class="close" title="End tour (Esc)">✕</button></div><div class="card-slot"></div>`;
    remoteRoot.querySelector('.prev').onclick = onPrev;
    remoteRoot.querySelector('.next').onclick = onNext;
    remoteRoot.querySelector('.prev-stop').onclick = onPrevStop;
    remoteRoot.querySelector('.next-stop').onclick = onNextStop;
    remoteRoot.querySelector('.replay').onclick = onReplay;
    remoteRoot.querySelector('.close').onclick = onClose;

    // Hide drawings and notes behind GitHub's sticky headers: clip the layer at their bottom edge.
    // (Notes are regular elements; z-index alone doesn't keep them under the headers.)
    let clipFrame = 0;
    function clipToHeaders() {
      cancelAnimationFrame(clipFrame);
      clipFrame = requestAnimationFrame(() => {
        const headers = [...document.querySelectorAll('[class*="diffHeaderWrapper"], [class*="stickyHeader"]')];
        const bottom = Math.max(0, ...headers.map((h) => h.getBoundingClientRect().bottom).filter((b) => b < innerHeight / 2));
        const y = scrollY + bottom;
        host.style.clipPath = `polygon(0 ${y}px, 100000px ${y}px, 100000px 10000000px, 0 10000000px)`;
      });
    }
    addEventListener('scroll', clipToHeaders, { passive: true });
    clipToHeaders();

    let stop = null; // { file, startLine, endLine, beats }
    let drawn = 0; // beats drawn so far
    let playToken = 0;
    let padded = null; // [element, previous padding]
    let observers = [];

    function path(parent, d, { color, width = 2.2, animate, delay = 0, dur = 0.5, opacity = 1 }) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('class', `ink${animate ? ' draw' : ''}`);
      p.setAttribute('stroke', color);
      p.setAttribute('stroke-width', width);
      if (opacity < 1) p.setAttribute('opacity', opacity);
      parent.appendChild(p);
      if (animate) {
        p.style.setProperty('--len', Math.ceil(p.getTotalLength()) + 2);
        p.style.setProperty('--delay', `${delay}s`);
        p.style.setProperty('--dur', `${dur}s`);
      }
      return p;
    }
    function element(cls, html, animate, delayMs) {
      const e = document.createElement('div');
      e.className = cls + (animate ? ' enter' : '');
      e.innerHTML = html;
      notesEl.appendChild(e);
      if (animate) setTimeout(() => e.classList.remove('enter'), delayMs);
      return e;
    }

    // Layout state shared by the beats of one drawing pass.
    let geo = null;

    function measure() {
      const table = tableFor(stop.file);
      if (!table) return null;
      const first = rowCell(table, stop.startLine);
      const last = rowCell(table, stop.endLine) || first;
      if (!first) return null;
      const t = docRect(table.getBoundingClientRect());
      return { table, t, lane: t.right + 16, badges: {}, first: docRect(first.closest('tr').getBoundingClientRect()), last: docRect(last.closest('tr').getBoundingClientRect()), nextFree: 0 };
    }

    function clear() {
      svgInk.innerHTML = '';
      shades.innerHTML = '';
      notesEl.innerHTML = '';
      seed = 7;
      drawn = 0;
      geo = measure();
      if (!geo) return false;
      const { t, first, last } = geo;

      // The drawing layer only spans the area around the stop (paths use page coordinates).
      const W = document.documentElement.scrollWidth;
      const y0 = Math.max(0, first.top - 600);
      const y1 = Math.max(last.bottom, first.top + innerHeight) + 1500;
      svgEl.style.top = `${y0}px`;
      svgEl.setAttribute('width', W);
      svgEl.setAttribute('height', y1 - y0);
      svgInk.setAttribute('transform', `translate(0, ${-y0})`);

      // Fade only the diff column (and the margin next to it), never GitHub's file tree on the left.
      const hole = { left: t.left - 6, top: first.top - 6, right: t.right + 6, bottom: last.bottom + 6 };
      const H = Math.max(document.documentElement.scrollHeight, hole.bottom);
      const x0 = t.left - 12;
      for (const [left, top, width, height] of [
        [x0, 0, W - x0, hole.top],
        [x0, hole.bottom, W - x0, H - hole.bottom],
        [x0, hole.top, hole.left - x0, hole.bottom - hole.top],
        [hole.right, hole.top, W - hole.right, hole.bottom - hole.top],
      ]) {
        const shade = document.createElement('div');
        shade.className = 'shade';
        shade.style.cssText = `left:${left}px;top:${top}px;width:${Math.max(0, width)}px;height:${Math.max(0, height)}px`;
        shades.appendChild(shade);
      }
      return true;
    }

    // Under a note: the actions (ask, zoom) and the beat's question thread.
    const md = (t) => noteHtml(t).replace(/\n/g, '<br>');
    function noteExtras(beat) {
      if (beat.actions === false) return '';
      const level = beat.level > 1 ? `<span class="level">detail ${beat.level}${beat.maxed ? ' (max)' : ''}</span>` : '';
      let html = `<div class="actions"><button data-act="ask" title="Ask about this (?)">💬 Ask</button>` +
        `${beat.maxed ? '' : '<button data-act="deeper" title="More detail (↓)">🔍 Deeper</button>'}` +
        `${beat.level > 1 || beat.canUp ? '<button data-act="up" title="Less detail (↑)">↑</button>' : ''}${level}</div>`;
      const thread = beat.thread;
      if (thread?.messages?.length || thread?.open) {
        html += '<div class="thread">';
        for (const m of thread.messages || []) {
          html += `<div class="q">${escapeHtml(m.q)}</div>`;
          if (m.error) html += `<div class="err">${escapeHtml(m.error)}</div>`;
          else html += `<div class="a${m.pending ? ' pending' : ''}">${md(m.a || '')}</div>`;
        }
        if (thread.open) html += `<textarea rows="1" placeholder="Ask about this…">${escapeHtml(thread.draft || '')}</textarea><div class="hint">Enter to send · the whole conversation is in the Lesehilfe panel</div>`;
        html += '</div>';
      }
      return html;
    }
    function wireNote(note, i) {
      note.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act) {
          e.stopPropagation();
          onBeatAction?.(i, act);
        }
      });
      const input = note.querySelector('textarea');
      if (input) {
        input.addEventListener('input', () => onThreadDraft?.(i, input.value));
        input.addEventListener('keydown', (e) => {
          e.stopPropagation(); // typing doesn't drive the tour
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (input.value.trim()) onThreadSend?.(i, input.value.trim());
          } else if (e.key === 'Escape') {
            onBeatAction?.(i, 'close-thread');
          }
        });
        // Focus only right after "Ask" was clicked, or to keep it while the user is typing
        // during a redraw — never as a side effect of other actions, and without scrolling.
        if (focusInput === i || keepFocus === i) {
          focusInput = null;
          requestAnimationFrame(() => {
            input.focus({ preventScroll: true });
            input.setSelectionRange(input.value.length, input.value.length);
          });
        }
      }
    }
    let focusInput = null; // beat whose question box gets the focus once (after "Ask")
    let keepFocus = null; // beat whose question box had the focus when a redraw started

    // Draws one beat; returns the document y range to keep in view while it plays.
    function drawBeat(i, animate) {
      const beat = stop.beats[i];
      const { table, t, lane } = geo;
      const color = TONES[beat.tone] || TONES.neutral;
      const opacity = beat.dim ? 0.3 : 1;
      const label = beat.label || String(i + 1);
      const [firstLine, lastLine] = beat.lines;
      const cellA = rowCell(table, firstLine);
      const cellB = rowCell(table, lastLine) || cellA;
      if (!cellA) return null;
      const a = docRect(cellA.closest('tr').getBoundingClientRect());
      const b = docRect(cellB.closest('tr').getBoundingClientRect());
      const code = cellA.querySelector('code');
      const rects = code ? textRects(code) : [];

      // Fade the previous beat's connector: one connector on screen at a time.
      root.querySelectorAll('.conn:not(.faded)').forEach((g) => g.classList.add('faded'));

      let anchor = null;
      if (beat.shape === 'bracket') {
        const x = t.right - 14;
        path(svgInk, roughLine(x - 10, a.top + 3, x, a.top + 3, 0.8) + roughLine(x, a.top + 3, x, b.bottom - 3, 1.2) + roughLine(x, b.bottom - 3, x - 10, b.bottom - 3, 0.8), { color, animate, opacity });
        anchor = { x: x + 6, y: (a.top + b.bottom) / 2 };
      } else {
        let r = beat.token && code ? tokenRect(code, beat.token) : null;
        if (!r && rects.length) {
          const row1 = rects.filter((q) => Math.abs(q.top - rects[0].top) < 2);
          r = { left: Math.min(...row1.map((q) => q.left)), right: Math.max(...row1.map((q) => q.right)), top: rects[0].top, bottom: rects[0].bottom };
          r.width = r.right - r.left;
          r.height = r.bottom - r.top;
        }
        if (r) {
          if (beat.shape === 'circle') path(svgInk, roughEllipse((r.left + r.right) / 2, (r.top + r.bottom) / 2, r.width / 2 + 12, r.height / 2 + 7), { color, animate, opacity });
          else if (beat.shape === 'box') path(svgInk, roughBox(r.left - 7, r.top - 4, r.right + 7, r.bottom + 4), { color, animate, opacity });
          else path(svgInk, roughLine(r.left - 4, r.bottom + 2, r.right + 6, r.bottom + 1, 1.2), { color, width: 2.6, animate, opacity });
        }
        // A connector may only run through the empty space after the line's text.
        const end = rects.reduce((m, q) => (!m || q.bottom > m.bottom + 1 || (Math.abs(q.bottom - m.bottom) <= 1 && q.right > m.right) ? q : m), null);
        if (end && lane - (end.right + 14) >= 36) anchor = { x: end.right + 14, y: (end.top + end.bottom) / 2 };
      }

      // Numbered badge on the edge between line numbers and code (covers no text).
      const cellLeft = docRect(cellA.getBoundingClientRect()).left;
      const badge = element(`badge${beat.dim ? ' dim' : ''}`, escapeHtml(label), animate, 250);
      badge.style.setProperty('--c', color);
      // Several beats on one line: line their badges up to the left instead of stacking them.
      const onLine = (geo.badges[firstLine] = (geo.badges[firstLine] || 0) + 1) - 1;
      badge.style.left = `${cellLeft - 9 - onLine * 22}px`;
      if (label.length > 1) badge.style.width = 'auto';
      badge.style.top = `${a.top + Math.min(a.height, 24) / 2 - 9}px`;

      // Sticky note in the margin, as close to its line as the notes above allow.
      const classes = ['note', beat.wide && 'wide', beat.unfolded && 'unfolded', beat.dim && 'dim', beat.current && 'current', beat.thread?.messages?.length && 'has-thread'];
      const note = element(classes.filter(Boolean).join(' '), `<span class="num">${escapeHtml(label)}</span>${noteHtml(beat.note)}${beat.extra || ''}${noteExtras(beat)}`, animate, 300);
      note.dataset.beat = i;
      wireNote(note, i);
      note.style.setProperty('--c', color);
      note.style.setProperty('--rot', `${j(1.6).toFixed(2)}deg`);
      note.style.left = `${t.right + 34}px`;
      const top = Math.max((anchor?.y ?? a.top) - 24, geo.nextFree);
      note.style.top = `${top}px`;
      geo.nextFree = top + note.offsetHeight + 14;

      if (anchor) {
        const y0 = top + 24;
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'conn');
        svgInk.appendChild(g);
        const d = roughLine(t.right + 32, y0, lane, y0, 0.7) + (Math.abs(y0 - anchor.y) > 3 ? roughLine(lane, y0, lane, anchor.y, 0.9) : '') + roughLine(lane, anchor.y, anchor.x, anchor.y, 0.7);
        path(g, d, { color, width: 1.8, animate, delay: 0.45, dur: 0.45, opacity });
        path(g, roughLine(anchor.x, anchor.y, anchor.x + 9, anchor.y - 5, 0.4) + roughLine(anchor.x, anchor.y, anchor.x + 9, anchor.y + 5, 0.4), { color, width: 1.8, animate, delay: 0.85, dur: 0.15 });
        note.addEventListener('mouseenter', () => g.classList.add('hover'));
        note.addEventListener('mouseleave', () => g.classList.remove('hover'));
      }

      // Control-flow arrow in the left gutter (line numbers: no code there).
      if (beat.arrowTo) {
        const toCell = rowCell(table, beat.arrowTo);
        if (toCell) {
          const to = docRect(toCell.closest('tr').getBoundingClientRect());
          const x = t.left + 4;
          const y1 = (a.top + a.bottom) / 2;
          const y2 = (to.top + to.bottom) / 2;
          const [body, head] = roughArrow(x, y1, x + 2, y2, y2 < y1 ? 0.55 : -0.55);
          path(svgInk, body, { color, animate, delay: 0.9, dur: 0.6 });
          path(svgInk, head, { color, animate, delay: 1.4, dur: 0.2 });
          if (beat.arrowLabel) {
            const label = element('label', escapeHtml(beat.arrowLabel), animate, 1500);
            label.style.setProperty('--c', color);
            label.style.left = `${x - 40}px`;
            label.style.top = `${(y1 + y2) / 2 + 28}px`;
          }
        }
      }
      drawn = i + 1;
      return { top: Math.min(a.top, top), bottom: Math.max(b.bottom, top + note.offsetHeight) };
    }

    // Redraw the revealed beats without animation (after layout changes or when stepping back).
    let drawnTarget = 0; // beats revealed in the current stop
    function redraw() {
      const typing = root.activeElement?.tagName === 'TEXTAREA' ? root.activeElement.closest('.note')?.dataset.beat : null;
      keepFocus = typing == null ? null : Number(typing);
      if (!stop || !clear()) return;
      for (let i = 0; i < drawnTarget; i++) drawBeat(i, false);
    }

    // Smooth when a beat is being animated in; instant when showing something already seen.
    async function ensureVisible(range, { smooth = true } = {}) {
      const top = range.top - 100;
      const bottom = range.bottom + 120;
      if (top >= scrollY + 60 && bottom <= scrollY + innerHeight - 60) return;
      window.scrollTo({ top: Math.max(0, range.top - innerHeight * 0.3), behavior: smooth ? 'smooth' : 'instant' });
      if (smooth) await sleep(550);
    }
    const beatRange = (i) => {
      const cell = geo && rowCell(geo.table, stop.beats[i].lines[0]);
      if (!cell) return null;
      const r = docRect(cell.closest('tr').getBoundingClientRect());
      return { top: r.top, bottom: r.bottom + 60 };
    };

    /**
     * Shows the first `n` beats of the current stop. Revealing exactly one more beat than
     * before animates it (after scrolling it into view); anything else is drawn at once.
     */
    async function reveal(n, { animate = false } = {}) {
      const token = ++playToken;
      if (!stop) return;
      n = Math.max(0, Math.min(n, stop.beats.length));
      if (animate && n === drawnTarget + 1) {
        const range = beatRange(n - 1);
        if (range) await ensureVisible(range);
        if (token !== playToken) return;
        redraw(); // positions may have shifted while scrolling
        drawnTarget = n;
        drawBeat(n - 1, true);
      } else {
        drawnTarget = n;
        const range = n ? beatRange(n - 1) : null;
        if (range) await ensureVisible(range, { smooth: false });
        redraw();
      }
    }

    function watch() {
      for (const o of observers) o.disconnect();
      observers = [];
      const table = tableFor(stop.file);
      let timer;
      const later = () => {
        clearTimeout(timer);
        timer = setTimeout(redraw, 200);
      };
      const ro = new ResizeObserver(later);
      ro.observe(document.documentElement);
      if (table) ro.observe(table);
      observers.push(ro);
      addEventListener('resize', later);
      observers.push({ disconnect: () => removeEventListener('resize', later) });
    }

    // GitHub renders each file with `content-visibility: auto`: away from the viewport it collapses
    // to a small placeholder. A tour scrolls straight to lines far down a file, so keep the
    // current file rendered while it is shown, and make room for notes next to it.
    let forced = []; // [element, previous inline content-visibility]
    function makeRoom(file) {
      const table = tableFor(file);
      for (const [el, prev] of forced) el.style.contentVisibility = prev;
      forced = [];
      for (let el = table?.parentElement; el && el !== document.body; el = el.parentElement) {
        if (getComputedStyle(el).contentVisibility === 'auto') {
          forced.push([el, el.style.contentVisibility]);
          el.style.contentVisibility = 'visible';
        }
      }
      const content = table?.closest('[class^="prc-PageLayout-Content-"]');
      if (!content || padded?.[0] === content) return;
      unpad();
      padded = [content, content.style.paddingRight];
      content.style.paddingRight = `${MARGIN}px`;
    }
    function unpad() {
      if (padded) padded[0].style.paddingRight = padded[1];
      padded = null;
      for (const [el, prev] of forced) el.style.contentVisibility = prev;
      forced = [];
    }

    return {
      setRemote({ flowTitle, index, total, title, beat, beats, status, where, canPrev, canNext, canPrevStop, canNextStop }) {
        remoteRoot.querySelector('.text').innerHTML =
          `<span class="flow">${escapeHtml(flowTitle)}</span><b>Stop ${index + 1} of ${total}: ${escapeHtml(title)}</b>` +
          (where ? `<span class="status">· <code>${escapeHtml(where)}</code></span>` : '') +
          (beats > 1 ? `<span class="status">· beat ${beat} of ${beats}</span>` : '') +
          (status ? `<span class="status">· ${escapeHtml(status)}</span>` : '');
        remoteRoot.querySelector('.prev').disabled = !canPrev;
        remoteRoot.querySelector('.next').disabled = !canNext;
        remoteRoot.querySelector('.prev-stop').disabled = !canPrevStop;
        remoteRoot.querySelector('.next-stop').disabled = !canNextStop;
      },
      /** Shows a card instead of drawings: a transition between stops, or a note that the code isn't in the diff. */
      showCard(html, { transition = false } = {}) {
        stop = null;
        playToken++;
        svgInk.innerHTML = '';
        shades.innerHTML = '';
        notesEl.innerHTML = '';
        remoteRoot.querySelector('.card-slot').innerHTML = html ? `<div class="card${transition ? ' transition' : ''}">${html}</div>` : '';
      },
      /**
       * Draws a stop with its first `reveal` beats: animated from the first beat for a new
       * stop, all at once for one seen before. Returns false if its lines aren't on the page.
       */
      async showStop(next, { reveal: n = 1, animate = true } = {}) {
        remoteRoot.querySelector('.card-slot').innerHTML = '';
        playToken++;
        stop = next;
        drawnTarget = 0;
        makeRoom(stop.file);
        clipToHeaders();
        watch();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // let the forced layout happen
        if (!clear()) return false;
        if (animate && n === 1) {
          await ensureVisible({ top: geo.first.top, bottom: Math.min(geo.last.bottom, geo.first.top + innerHeight * 0.5) });
          await reveal(1, { animate: true });
        } else {
          window.scrollTo({ top: Math.max(0, geo.first.top - 120), behavior: 'instant' });
          await reveal(n);
        }
        return true;
      },
      /** Shows `n` beats of the current stop (animating if it's the next one). */
      reveal: (n, options) => reveal(n, options),
      /** Replaces the stop's beats (e.g. a beat unfolded, a thread changed) and redraws in place. */
      update(beats, n = drawnTarget) {
        if (!stop) return;
        stop = { ...stop, beats };
        drawnTarget = Math.min(n, beats.length);
        redraw();
      },
      focusThread(i) {
        focusInput = i;
      },
      /** Brings a beat's code into view (after zooming into it). */
      showBeat(i) {
        const range = stop && i >= 0 && i < stop.beats.length ? beatRange(i) : null;
        if (range) ensureVisible(range);
      },
      /** Streams an answer into a note without a full redraw. */
      setAnswer(i, index, text, pending) {
        const a = root.querySelector(`.note[data-beat="${i}"] .thread`)?.querySelectorAll('.a')[index];
        if (!a) return false;
        a.innerHTML = md(text);
        a.classList.toggle('pending', pending);
        a.scrollTop = a.scrollHeight;
        return true;
      },
      destroy() {
        playToken++;
        removeEventListener('scroll', clipToHeaders);
        for (const o of observers) o.disconnect();
        unpad();
        host.remove();
        remoteHost.remove();
      },
    };
  }

  globalThis.LesehilfeOverlay = { create, tableFor, rowCell };
})();
