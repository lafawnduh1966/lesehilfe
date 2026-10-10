// Experiment: a hand-drawn tour stop drawn over GitHub's PR diff (new React view,
// single-file mode). Paste into the DevTools console on the URL in README.md.
// Re-running replaces the previous overlay.
window.__lhTour?.destroy?.();
window.__lhTour = (() => {
  const FILE = 'packages/foundry/contracts/composable-issuance/IssuerCoordinator.sol';
  const STOP = {
    flow: 'Mint a leveraged Morpho position', index: 4, total: 6,
    title: 'Provide emUSD before the leverage callback', range: [357, 386],
    marks: [
      { at: 358, token: '_accepted', shape: 'circle', note: 'Is this still <b>exactly</b> the agreement that was accepted? Same revision, same terms hash — or revert.' },
      { at: [362, 369], shape: 'bracket', note: 'The participant’s signature must cover <b>this exact execution</b>: evidence, callback data, ETH value.' },
      { at: 378, token: '_deliverOutput', shape: 'underline', color: '#1a7f37', note: 'emUSD is minted to the user’s vault <b>first</b>…' },
      { at: 379, token: 'onOutputReceived', shape: 'circle', color: '#1a7f37', note: '…<b>then</b> the user’s own route runs: stake → Morpho collateral → borrow USDC → pay the issuer.' },
      { at: 381, token: 'verifySettlement', shape: 'box', color: '#cf222e', back: 378, note: 'Only now is payment proven. Not paid exactly? <b>Everything reverts</b> — including the mint.' },
    ],
  };
  const INK = '#0b57d0', MARGIN = 340;

  // --- Seeded randomness so shapes stay stable on re-layout -----------------
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const j = (a) => (rnd() - 0.5) * 2 * a;

  // Sketchy line: two slightly different passes, each a curve through a jittered midpoint.
  function roughLine(x1, y1, x2, y2, amp = 1.6) {
    let d = '';
    for (let pass = 0; pass < 2; pass++) {
      const mx = (x1 + x2) / 2 + j(amp * 1.5), my = (y1 + y2) / 2 + j(amp * 1.5);
      d += `M${x1 + j(amp)},${y1 + j(amp)} Q${mx},${my} ${x2 + j(amp)},${y2 + j(amp)} `;
    }
    return d;
  }
  function roughEllipse(cx, cy, rx, ry) {
    let d = ''; const steps = 26, start = rnd() * Math.PI * 2, turn = Math.PI * 2 * 1.12;
    for (let i = 0; i <= steps; i++) {
      const a = start + (turn * i) / steps, k = 1 + j(0.06);
      d += `${i ? 'L' : 'M'}${cx + Math.cos(a) * rx * k},${cy + Math.sin(a) * ry * k} `;
    }
    return d;
  }
  function roughArrow(x1, y1, x2, y2, bend = 0.25) {
    const dx = x2 - x1, dy = y2 - y1;
    const cx = (x1 + x2) / 2 - dy * bend + j(6), cy = (y1 + y2) / 2 + dx * bend + j(6);
    const body = `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
    const ang = Math.atan2(y2 - cy, x2 - cx), h = 11;
    const head = roughLine(x2, y2, x2 - h * Math.cos(ang - 0.45), y2 - h * Math.sin(ang - 0.45), 0.6) + roughLine(x2, y2, x2 - h * Math.cos(ang + 0.45), y2 - h * Math.sin(ang + 0.45), 0.6);
    return [body, head];
  }

  // --- Page anchors ------------------------------------------------------------
  const table = () => document.querySelector(`table[aria-label="Diff for: ${FILE}"]`);
  const docRect = (r) => ({ left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY, width: r.width, height: r.height });
  function row(n) {
    return [...table().querySelectorAll('td.diff-text-cell')].find((c) => (c.dataset.diffLineKey || '').split('-').includes(`r:${n}`));
  }
  // Rect of a token inside a line, across the syntax-highlighting spans.
  function tokenRect(n, token) {
    const code = row(n)?.querySelector('code'); if (!code) return null;
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT); let node, text = ''; const nodes = [];
    while ((node = walker.nextNode())) { nodes.push([node, text.length]); text += node.data; }
    const at = text.indexOf(token); if (at < 0) return null;
    const range = document.createRange();
    const find = (pos) => { for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i][1] <= pos) return [nodes[i][0], pos - nodes[i][1]]; };
    range.setStart(...find(at)); range.setEnd(...find(at + token.length));
    return docRect(range.getBoundingClientRect());
  }
  const lineRect = (n) => { const c = row(n); return c && docRect(c.closest('tr').getBoundingClientRect()); };
  // Where the text of line n ends (on its last visual line, if it wraps): the free space after it is ours.
  function textEnd(n) {
    const code = row(n)?.querySelector('code'); if (!code) return null;
    // Only text boxes count: GitHub wraps lines in inline elements that span the whole column.
    const rects = [];
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) {
      if (!node.data.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].filter((r) => r.width > 0));
    }
    const last = rects.reduce((a, r) => (!a || r.bottom > a.bottom + 1 || (Math.abs(r.bottom - a.bottom) <= 1 && r.right > a.right) ? r : a), null);
    return last && docRect(last);
  }

  // --- Overlay ------------------------------------------------------------------------
  const content = table().closest('[class^="prc-PageLayout-Content-"]');
  const prevPadding = content.style.paddingRight;
  content.style.paddingRight = MARGIN + 'px'; // make room for margin notes

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:30;pointer-events:none';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    svg { position: absolute; left: 0; top: 0; overflow: visible; }
    .ink { fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .draw { stroke-dasharray: var(--len); stroke-dashoffset: var(--len); animation: draw var(--dur, .6s) ease-out forwards; animation-delay: var(--delay, 0s); }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    .note { position: absolute; width: 270px; padding: 10px 12px 12px; background: #fff8b8; color: #3b3200;
      font: 17px/1.25 "Noteworthy", "Marker Felt", "Bradley Hand", "Comic Sans MS", cursive;
      box-shadow: 0 1px 1px rgba(0,0,0,.08), 0 6px 14px rgba(0,0,0,.14); border-radius: 2px 2px 6px 2px;
      pointer-events: auto; opacity: 0; transform: translateY(6px) rotate(var(--rot)); transition: opacity .35s, transform .35s; }
    .note.in { opacity: 1; transform: translateY(0) rotate(var(--rot)); }
    .note b { font-weight: 700; }
    .note .num { display: inline-block; width: 20px; height: 20px; margin-right: 6px; border-radius: 50%; background: var(--c); color: #fff;
      font: 700 12px/20px -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; vertical-align: 2px; }
    .note:hover { box-shadow: 0 1px 1px rgba(0,0,0,.08), 0 10px 22px rgba(0,0,0,.22); }
    .badge { position: absolute; width: 18px; height: 18px; border-radius: 50%; background: var(--c); color: #fff; opacity: 0; transition: opacity .3s;
      font: 700 11px/18px -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; box-shadow: 0 0 0 2px #fff; }
    .badge.in { opacity: 1; }
    .conn { transition: opacity .5s; }
    .conn.faded { opacity: 0; }
    .conn.faded.hover { opacity: 1; }
    .label { position: absolute; font: 15px "Noteworthy", "Marker Felt", cursive; color: #cf222e; opacity: 0; transition: opacity .4s; transform: rotate(-90deg); transform-origin: left top; white-space: nowrap; }
    .label.in { opacity: 1; }
    .remote { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
      padding: 8px 10px 8px 16px; background: #1f2328; color: #fff; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,.25);
      font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; pointer-events: auto; }
    .remote .flow { opacity: .7; } .remote b { font-weight: 600; }
    .remote button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,.12); }
    .remote button:hover { background: rgba(255,255,255,.22); }
  </style><svg id="dim"></svg><svg id="ink"></svg><div id="notes"></div>
  <div class="remote"><span class="flow">${STOP.flow}</span><span>·</span><b>Stop ${STOP.index} of ${STOP.total}: ${STOP.title}</b>
  <button title="Previous stop">‹</button><button title="Next stop">›</button><button id="replay" title="Replay">↻</button><button id="close" title="End tour">✕</button></div>`;
  const svgDim = root.getElementById('dim'), svgInk = root.getElementById('ink'), notes = root.getElementById('notes');
  root.getElementById('close').onclick = () => api.destroy();
  root.getElementById('replay').onclick = () => layout(true);

  const NS = 'http://www.w3.org/2000/svg';
  function path(svg, d, { color = INK, width = 2.2, delay = 0, dur = 0.6, animate, dash } = {}) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('class', 'ink' + (animate ? ' draw' : ''));
    p.setAttribute('stroke', color); p.setAttribute('stroke-width', width);
    if (dash) p.setAttribute('stroke-dasharray', dash);
    svg.appendChild(p);
    if (animate) { const len = Math.ceil(p.getTotalLength()) + 2; p.style.setProperty('--len', len); p.style.setProperty('--delay', delay + 's'); p.style.setProperty('--dur', dur + 's'); }
    return p;
  }

  function layout(animate) {
    seed = 7; svgInk.innerHTML = ''; svgDim.innerHTML = ''; notes.innerHTML = '';
    const W = document.documentElement.scrollWidth, H = document.documentElement.scrollHeight;
    for (const s of [svgDim, svgInk]) { s.setAttribute('width', W); s.setAttribute('height', H); }
    const t = docRect(table().getBoundingClientRect());
    const first = lineRect(STOP.range[0]), last = lineRect(STOP.range[1]);

    // Spotlight: fade everything except the stop's lines.
    const hole = { x: t.left - 6, y: first.top - 6, w: t.width + 12, h: last.bottom - first.top + 12 };
    const dim = document.createElementNS(NS, 'path');
    dim.setAttribute('d', `M0,0H${W}V${H}H0Z M${hole.x},${hole.y}v${hole.h}h${hole.w}v${-hole.h}Z`);
    dim.setAttribute('fill', 'rgba(255,255,255,0.62)'); dim.setAttribute('fill-rule', 'evenodd');
    svgDim.appendChild(dim);
    path(svgInk, roughLine(hole.x, hole.y, hole.x + hole.w, hole.y, 1) + roughLine(hole.x, hole.y + hole.h, hole.x + hole.w, hole.y + hole.h, 1) + roughLine(hole.x, hole.y, hole.x, hole.y + hole.h, 1) + roughLine(hole.x + hole.w, hole.y, hole.x + hole.w, hole.y + hole.h, 1), { width: 1.4, color: 'rgba(11,87,208,.45)', animate, dur: 0.9 });

    let nextFree = 0;
    const connectors = [];
    const lane = t.right + 16; // vertical lane between the code column and the notes
    STOP.marks.forEach((m, i) => {
      const delay = animate ? 0.9 + i * 1.5 : 0;
      const color = m.color || INK;
      const num = i + 1;
      const lines = Array.isArray(m.at) ? m.at : [m.at, m.at];
      const a = lineRect(lines[0]), b = lineRect(lines[1]);
      let anchor; // where a connector may end: right after the line's text, if there's room
      let badgeAt; // where the number goes next to the marking
      if (m.shape === 'bracket') {
        const x = t.right - 14;
        path(svgInk, roughLine(x - 10, a.top + 3, x, a.top + 3, 0.8) + roughLine(x, a.top + 3, x, b.bottom - 3, 1.2) + roughLine(x, b.bottom - 3, x - 10, b.bottom - 3, 0.8), { color, animate, delay });
        anchor = { x: x + 6, y: (a.top + b.bottom) / 2 }; // the bracket sits at the column edge

      } else {
        const r = tokenRect(lines[0], m.token) || { left: a.left + 80, right: a.left + 200, top: a.top, bottom: a.bottom, width: 120, height: a.height };
        if (m.shape === 'circle') path(svgInk, roughEllipse((r.left + r.right) / 2, (r.top + r.bottom) / 2, r.width / 2 + 12, r.height / 2 + 7), { color, animate, delay });
        if (m.shape === 'underline') path(svgInk, roughLine(r.left - 4, r.bottom + 2, r.right + 6, r.bottom + 1, 1.2), { color, width: 2.6, animate, delay });
        if (m.shape === 'box') path(svgInk, [[r.left - 7, r.top - 4, r.right + 7, r.top - 4], [r.right + 7, r.top - 4, r.right + 7, r.bottom + 4], [r.right + 7, r.bottom + 4, r.left - 7, r.bottom + 4], [r.left - 7, r.bottom + 4, r.left - 7, r.top - 4]].map((q) => roughLine(...q, 1.2)).join(''), { color, animate, delay });
        const end = textEnd(lines[0]);
        const free = end ? lane - (end.right + 14) : 0;
        if (free >= 36) anchor = { x: end.right + 14, y: (end.top + end.bottom) / 2 };
      }

      // Numbered badge at the start of the line, on the edge between line numbers and code: covers no text.
      const cellLeft = docRect(row(lines[0]).getBoundingClientRect()).left;
      badgeAt = { x: cellLeft - 9, y: a.top + Math.min(a.height, 24) / 2 - 9 };
      const badge = document.createElement('div');
      badge.className = 'badge'; badge.textContent = num; badge.style.setProperty('--c', color);
      badge.style.left = `${badgeAt.x}px`; badge.style.top = `${badgeAt.y}px`;
      notes.appendChild(badge);
      setTimeout(() => badge.classList.add('in'), (delay + 0.3) * 1000);

      // Sticky note in the right margin, as close to its line as the notes above allow.
      const note = document.createElement('div');
      note.className = 'note';
      note.innerHTML = `<span class="num">${num}</span>${m.note}`;
      note.style.setProperty('--c', color);
      note.style.setProperty('--rot', `${j(1.6).toFixed(2)}deg`);
      note.style.left = `${t.right + 34}px`;
      notes.appendChild(note);
      const top = Math.max((anchor?.y ?? a.top) - 24, nextFree);
      note.style.top = `${top}px`;
      nextFree = top + note.offsetHeight + 14;
      setTimeout(() => note.classList.add('in'), (delay + 0.35) * 1000);

      // Connector: note → lane → along the line's empty tail. It never crosses text.
      if (anchor) {
        const y0 = top + 24;
        const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'conn'); svgInk.appendChild(g);
        const d = roughLine(t.right + 32, y0, lane, y0, 0.7) + (Math.abs(y0 - anchor.y) > 3 ? roughLine(lane, y0, lane, anchor.y, 0.9) : '') + roughLine(lane, anchor.y, anchor.x, anchor.y, 0.7);
        path(g, d, { color, width: 1.8, animate, delay: delay + 0.55, dur: 0.45 });
        const head = roughLine(anchor.x, anchor.y, anchor.x + 9, anchor.y - 5, 0.4) + roughLine(anchor.x, anchor.y, anchor.x + 9, anchor.y + 5, 0.4);
        path(g, head, { color, width: 1.8, animate, delay: delay + 0.95, dur: 0.15 });
        connectors.push(g);
        note.addEventListener('mouseenter', () => g.classList.add('hover'));
        note.addEventListener('mouseleave', () => g.classList.remove('hover'));
        // Once the next beat starts, this connector fades; hovering the note brings it back.
        if (i < STOP.marks.length - 1) setTimeout(() => g.classList.add('faded'), (animate ? delay + 1.5 + 0.3 : 0) * 1000);
      }

      // "Reverts" arrow in the left gutter (line numbers, no code), from this line back up to `back`.
      if (m.back) {
        const from = lineRect(lines[0]), to = lineRect(m.back);
        const x = t.left + 4;
        const [bb, bh] = roughArrow(x, (from.top + from.bottom) / 2, x + 2, (to.top + to.bottom) / 2, 0.55);
        path(svgInk, bb, { color, width: 2.2, animate, delay: delay + 1.1, dur: 0.6 });
        path(svgInk, bh, { color, width: 2.2, animate, delay: delay + 1.6, dur: 0.2 });
        const label = document.createElement('div');
        label.className = 'label'; label.textContent = 'reverts!';
        label.style.left = `${x - 40}px`; label.style.top = `${(from.top + to.bottom) / 2 + 28}px`;
        notes.appendChild(label);
        setTimeout(() => label.classList.add('in'), (delay + 1.6) * 1000);
      }
    });
  }

  const first = lineRect(STOP.range[0]);
  window.scrollTo({ top: first.top - 140, behavior: 'instant' });
  setTimeout(() => layout(true), 400);
  let resizeTimer; const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => layout(false), 150); };
  addEventListener('resize', onResize);
  const api = { destroy() { removeEventListener('resize', onResize); host.remove(); content.style.paddingRight = prevPadding; } };
  return api;
})();
