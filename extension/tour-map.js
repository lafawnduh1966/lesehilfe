// The side panel's view of a running tour: a subway-style map of the flow (one row per stop,
// its dot in the column of its layer, lines showing where the flow changes layer), with the
// current stop expanded to its "why" and beats.
import { renderMarkdown } from './markdown.js';

const LANES = [
  ['ui', '🖥', 'UI'],
  ['api', '🔌', 'API'],
  ['backend', '⚙', 'Backend'],
  ['contract', '⛓', 'Contracts'],
  ['infra', '☁', 'Infra'],
  ['other', '•', 'Other'],
];
const KIND_ICONS = { start: '▶', calls: '⤵', transaction: '⛓', later: '⏭', event: '📡', returns: '↩' };
const KIND_LABELS = { start: 'starts', calls: 'calls', transaction: 'transaction', later: 'later', event: 'event', returns: 'returns' };
const LANE_W = 24;
const NODE_Y = 15; // dot position within a row
const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * el: element helper of the panel. tour: { index, phase, beat, notes, seen, storyboards }.
 * onGoto(index, beat?) jumps on the page; onEnd ends the tour.
 */
export function renderTourMap(root, { el, flow, tour, onGoto, onEnd }) {
  const stops = flow.steps;
  const used = LANES.filter(([id]) => stops.some((s) => (s.layer || 'other') === id || (id === 'other' && !LANES.some(([l]) => l === s.layer))));
  const laneOf = (stop) => Math.max(0, used.findIndex(([id]) => id === (LANES.some(([l]) => l === stop.layer) ? stop.layer : 'other')));
  const laneX = (i) => 10 + i * LANE_W;
  const width = laneX(used.length - 1) + 12;

  const end = el('button', { type: 'button', className: 'link', textContent: 'End tour' });
  end.addEventListener('click', onEnd);
  root.append(
    el('div', { className: 'map-head' },
      el('div', { className: 'grow' }, el('div', { className: 'map-title', textContent: flow.title }), el('div', { className: 'muted small', textContent: `${flow.actor} · ${stops.length} stops · ← → on the page` })),
      end),
    el('div', { className: 'lane-row' },
      el('div', { className: 'lane-head', style: `width:${width}px` },
        ...used.map(([, icon, label], i) => el('span', { className: 'lane-icon', title: label, textContent: icon, style: `left:${laneX(i) - 9}px` }))),
      el('div', { className: 'muted small lane-legend', textContent: used.map(([, icon, label]) => `${icon} ${label}`).join(' · ') }))
  );

  const list = el('div', { className: 'map' });
  stops.forEach((stop, i) => {
    const current = i === tour.index;
    const seen = Boolean(tour.seen?.[i]) || i < tour.index;
    const sb = tour.storyboards?.[i];
    const arrival = sb && !Array.isArray(sb) ? sb.arrival : null;
    const kind = arrival?.kind || (i === 0 ? 'start' : null);
    const lane = laneOf(stop);

    // Track: line in from the previous stop's lane, the dot, and a line down to the next row.
    const track = svg('svg', { class: 'track', width, height: '100%' });
    track.style.height = '100%';
    if (i > 0) {
      const from = laneX(laneOf(stops[i - 1]));
      const to = laneX(lane);
      track.append(svg('path', { d: `M${from},0 C${from},${NODE_Y * 0.7} ${to},${NODE_Y * 0.3} ${to},${NODE_Y}`, class: `line${seen || current ? ' done' : ''}` }));
    }
    if (i < stops.length - 1) {
      track.append(svg('line', { x1: laneX(lane), y1: NODE_Y, x2: laneX(lane), y2: 2000, class: `line${seen ? ' done' : ''}` }));
    }
    track.append(svg('circle', { cx: laneX(lane), cy: NODE_Y, r: current ? 8 : 6, class: `dot${current ? ' current' : seen ? ' seen' : ''}` }));
    const num = svg('text', { x: laneX(lane), y: NODE_Y + 3.5, class: `num${current || seen ? ' on' : ''}` });
    num.textContent = String(i + 1);
    track.append(num);

    const label = el('div', { className: 'stop-label' },
      el('div', { className: 'stop-name' }, kind ? el('span', { className: 'kind', title: KIND_LABELS[kind], textContent: KIND_ICONS[kind] }) : null, document.createTextNode(stop.title)),
      el('div', { className: 'muted small mono', textContent: `${stop.file.split('/').pop()}${sb?.inFunction ? ` › ${sb.inFunction}()` : ''}` }));

    const row = el('div', { className: `map-row${current ? ' current' : ''}` }, el('div', { className: 'track-cell', style: `width:${width}px` }, track), label);
    if (!current) {
      row.addEventListener('click', () => onGoto(i));
      row.title = 'Go to this stop';
    }

    if (current) {
      if (arrival?.why) {
        label.append(el('div', { className: 'why', textContent: arrival.why }));
      }
      if (tour.phase === 'stop' && tour.notes?.length) {
        const beats = el('ol', { className: 'beats' });
        tour.notes.forEach((b, n) => {
          const item = el('li', { className: `beat tone-${b.tone || 'neutral'}${n < tour.beat ? ' shown' : ''}${n === tour.beat - 1 ? ' now' : ''}` });
          item.innerHTML = renderMarkdown(b.note).replace(/^<p>|<\/p>$/g, '');
          if (!b.placeholder) {
            item.title = 'Show up to here';
            item.addEventListener('click', (e) => {
              e.stopPropagation();
              onGoto(i, n + 1);
            });
          }
          beats.append(item);
        });
        label.append(beats);
      } else if (tour.phase === 'card') {
        label.append(el('div', { className: 'muted small', textContent: 'On the page: the transition card. Press → to enter the stop.' }));
      }
    }
    list.append(row);
  });
  root.append(list);
}
