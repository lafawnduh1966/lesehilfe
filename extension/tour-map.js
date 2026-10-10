// The side panel's view of a running tour: a timeline of the flow. Stops sit on one vertical
// line; a heading appears whenever the flow moves to another place (client, backend, on-chain…);
// between stops a short label says how the flow gets there — a solid line for a direct call,
// dashed for "later" (another request, actor or moment). The current stop is expanded.
import { renderMarkdown } from './markdown.js';

const KINDS = {
  start: ['▶', 'starts'],
  calls: ['⤵', 'calls'],
  transaction: ['⛓', 'submits a transaction'],
  later: ['⏭', 'later'],
  event: ['📡', 'reacts to an event'],
  returns: ['↩', 'returns'],
};
// Transitions that don't happen in the same moment are drawn dashed.
const DETACHED = new Set(['later', 'event', 'transaction']);

// Before storyboards name the place, guess it from the overview's layer and the path.
function guessPlace(stop) {
  if (stop.layer === 'contract' || /\/(foundry|contracts?)\//.test(stop.file)) return 'On-chain';
  if (stop.layer === 'ui' || /\/client\//.test(stop.file)) return 'Client';
  if (stop.layer === 'infra') return 'Infrastructure';
  if (stop.layer === 'api' || stop.layer === 'backend') return 'Backend';
  return 'Shared code';
}

/**
 * el: element helper of the panel. tour: { index, phase, beat, notes, seen, storyboards }.
 * onGoto(index, beat?) jumps on the page; onEnd ends the tour.
 */
export function renderTourMap(root, { el, flow, tour, onGoto, onEnd }) {
  const stops = flow.steps;
  const sb = (i) => {
    const s = tour.storyboards?.[i];
    return s && !Array.isArray(s) ? s : null;
  };
  const place = (i) => sb(i)?.runsIn || guessPlace(stops[i]);
  const reached = (i) => i <= tour.index || Boolean(tour.seen?.[i]);

  const end = el('button', { type: 'button', className: 'link', textContent: 'End tour' });
  end.addEventListener('click', onEnd);
  root.append(
    el('div', { className: 'map-head' },
      el('div', { className: 'grow' },
        el('div', { className: 'map-title', textContent: flow.title }),
        el('div', { className: 'muted small', textContent: `${flow.actor} · ${stops.length} stops · ← → on the page` })),
      end)
  );

  const timeline = el('div', { className: 'timeline' });
  stops.forEach((stop, i) => {
    const arrival = sb(i)?.arrival;
    const kind = arrival?.kind || (i === 0 ? 'start' : 'calls');
    const [icon, kindLabel] = KINDS[kind] || KINDS.calls;
    const newPlace = i === 0 || place(i) !== place(i - 1);

    // How the flow gets here (between the previous stop and this one), then the place heading.
    if (i > 0) {
      const text = arrival?.short || (kind === 'calls' && arrival?.entryToken ? `calls ${arrival.entryToken}()` : kindLabel);
      timeline.append(
        el('div', { className: `tl-link${DETACHED.has(kind) ? ' detached' : ''}${reached(i) ? ' done' : ''}` },
          el('span', { className: 'tl-link-text' }, el('span', { className: 'tl-kind', textContent: icon }), document.createTextNode(text)))
      );
    }
    if (newPlace) {
      timeline.append(el('div', { className: `tl-place${reached(i) ? ' done' : ''}${i === 0 ? ' first' : ''}`, textContent: place(i) }));
    }

    const current = i === tour.index;
    const fileLine = `${stop.file.split('/').pop()}${sb(i)?.inFunction ? ` › ${sb(i).inFunction}()` : ''}`;
    const ends = `${i === 0 ? ' first' : ''}${i === stops.length - 1 ? ' last' : ''}`;
    const row = el('div', { className: `tl-stop${ends}${current ? ' current' : ''}${reached(i) && !current ? ' seen' : ''}` },
      el('span', { className: 'tl-dot', textContent: String(i + 1) }),
      el('div', { className: 'tl-title', textContent: stop.title }));

    if (current) {
      row.append(el('div', { className: 'muted small mono', textContent: fileLine }));
      if (tour.zoom?.length) row.append(el('div', { className: 'zoom-path small', textContent: `🔍 ${tour.zoom.join(' › ')} · ↑ on the page to zoom out` }));
      if (arrival?.why) row.append(el('div', { className: 'why', textContent: arrival.why }));
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
        row.append(beats);
      } else if (tour.phase === 'card') {
        row.append(el('div', { className: 'muted small', textContent: 'On the page: where the flow goes next. Press → to enter the stop.' }));
      }
    } else {
      row.title = `${fileLine} — go to this stop`;
      row.addEventListener('click', () => onGoto(i));
    }
    timeline.append(row);
  });
  root.append(timeline);
}
