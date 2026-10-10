// Guided tour through one user flow of the overview: one stop at a time, with the
// GitHub page following along, a code excerpt, the PR's changes at that stop, and
// "Go deeper" to split a stop into sub-stops that follow the code further in.
import { renderMarkdown } from './markdown.js';

/**
 * ctx: { el, helper, prParams, getToken, getState: () => ({ pr, tab, overview }), onExit, render }
 * Stop keys: "<flow>/<step>/<substep>…" (indices), used to cache sub-stops in the helper.
 */
export function createTour(ctx) {
  const { el, helper } = ctx;
  let tour = null; // { flowIndex, levels: [{ key, title, stops, index }] }
  let subStops = {}; // stop key → stops (from the helper's cache)
  const excerpts = {}; // stop key → excerpt | { error }
  const diffs = {}; // stop key → stop diff | { error }
  let showDiff = false;
  let deepening = null; // { key, actions: [], error }
  let inDiff = null; // whether the current stop is visible in the page's diff

  const level = () => tour.levels.at(-1);
  const stop = () => level().stops[level().index];
  const stopKey = () => `${level().key}/${level().index}`;

  async function start(flowIndex) {
    const { overview } = ctx.getState();
    const flow = overview.flows[flowIndex];
    tour = { flowIndex, levels: [{ key: String(flowIndex), title: flow.title, stops: flow.steps, index: 0 }] };
    subStops = await helper.call('tours', await ctx.prParams()).catch(() => ({}));
    await show();
  }

  function exit() {
    tour = null;
    deepening = null;
    const { tab } = ctx.getState();
    chrome.tabs.sendMessage(tab.id, { type: 'highlight', stop: null }).catch(() => {});
    ctx.onExit();
  }

  // Moves to the current stop: highlight it on the page and load its excerpt.
  async function show() {
    showDiff = false;
    inDiff = null;
    ctx.render();
    const current = stop();
    const key = stopKey();
    const { tab } = ctx.getState();
    chrome.tabs
      .sendMessage(tab.id, { type: 'highlight', stop: current })
      .then((res) => (inDiff = Boolean(res?.ok)))
      .catch(() => (inDiff = false))
      .finally(() => tour && stopKey() === key && ctx.render());
    if (!excerpts[key]) {
      try {
        excerpts[key] = await helper.call('stopExcerpt', { ...(await ctx.prParams()), token: await ctx.getToken(), stop: current });
      } catch (e) {
        excerpts[key] = { error: e.message };
      }
      if (tour && stopKey() === key) ctx.render();
    }
  }

  const atEnd = () => tour.levels.every((l) => l.index === l.stops.length - 1);

  function next() {
    if (atEnd()) return exit();
    if (level().index < level().stops.length - 1) {
      level().index++;
      return show();
    }
    // Last sub-stop: continue with the next stop one level up.
    tour.levels.pop();
    return next();
  }

  function back() {
    if (level().index > 0) {
      level().index--;
      return show();
    }
    if (tour.levels.length > 1) {
      tour.levels.pop();
      return show();
    }
  }

  function upTo(depth) {
    tour.levels.length = depth + 1;
    return show();
  }

  async function deeper() {
    const key = stopKey();
    const enter = (stops) => {
      tour.levels.push({ key, title: stop().title, stops, index: 0 });
      return show();
    };
    if (subStops[key]) return enter(subStops[key]);

    deepening = { key, actions: [] };
    ctx.render();
    try {
      const trail = tour.levels.map((l) => l.stops[l.index]);
      const stops = await helper.call(
        'deepen',
        { ...(await ctx.prParams()), token: await ctx.getToken(), flowIndex: tour.flowIndex, key, trail },
        (event, data) => {
          if (event === 'agent' && data.type === 'tool') {
            deepening.actions.push(data);
            ctx.render();
          }
        }
      );
      subStops[key] = stops;
      deepening = null;
      if (tour && stopKey() === key) await enter(stops);
    } catch (e) {
      deepening = { key, error: /abort/i.test(e.message) ? null : e.message };
      ctx.render();
    }
  }

  async function toggleDiff() {
    showDiff = !showDiff;
    const key = stopKey();
    ctx.render();
    if (showDiff && !diffs[key]) {
      try {
        diffs[key] = await helper.call('stopDiff', { ...(await ctx.prParams()), token: await ctx.getToken(), stop: stop() });
      } catch (e) {
        diffs[key] = { error: e.message };
      }
      ctx.render();
    }
  }

  // --- Rendering -------------------------------------------------------------------------

  function excerptView(key) {
    const data = excerpts[key];
    if (!data) return el('p', { className: 'muted small', textContent: 'Loading code…' });
    if (data.error) return el('p', { className: 'error small', textContent: data.error });
    return el(
      'pre',
      { className: 'code excerpt' },
      ...data.lines.map((l) =>
        el(
          'div',
          { className: [l.changed ? 'add' : '', l.inRange ? 'in-range' : 'context'].join(' ') },
          el('span', { className: 'num', textContent: l.n }),
          el('span', { className: 'txt', textContent: `${l.changed ? '+' : ' '}${l.text}` })
        )
      ),
      data.truncated ? el('div', { className: 'muted', textContent: '  …' }) : null
    );
  }

  function diffView(key) {
    const data = diffs[key];
    if (!data) return el('p', { className: 'muted small', textContent: 'Loading changes…' });
    if (data.error) return el('p', { className: 'error small', textContent: data.error });
    if (data.status === 'added') return el('p', { className: 'small', textContent: 'This whole file is new in this PR.' });
    if (data.status !== 'changed') return el('p', { className: 'small', textContent: 'The PR does not change these lines.' });
    return el(
      'pre',
      { className: 'code' },
      ...data.hunks.flatMap((hunk) =>
        hunk.split('\n').map((line) =>
          el('div', { className: line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '' }, el('span', { className: 'txt', textContent: line }))
        )
      )
    );
  }

  function render(root) {
    const { pr, overview } = ctx.getState();
    const flow = overview.flows[tour.flowIndex];
    const current = stop();
    const key = stopKey();

    const crumbs = el('div', { className: 'crumbs' });
    tour.levels.forEach((l, depth) => {
      const label = depth === 0 ? flow.title : l.title;
      if (depth < tour.levels.length - 1) {
        const link = el('button', { type: 'button', className: 'link', textContent: label });
        link.addEventListener('click', () => upTo(depth));
        crumbs.append(link, el('span', { className: 'muted', textContent: ' › ' }));
      } else {
        crumbs.append(el('span', { textContent: label }));
      }
    });
    const end = el('button', { type: 'button', className: 'link', textContent: 'End tour' });
    end.addEventListener('click', exit);

    const location = el('div', { className: 'stop-location' });
    const range = `${current.startLine}${current.endLine > current.startLine ? `–${current.endLine}` : ''}`;
    location.append(el('code', { textContent: `${current.file}:${range}` }));
    if (inDiff === false) {
      const open = el('button', { type: 'button', className: 'link', textContent: 'open on GitHub' });
      open.addEventListener('click', () =>
        chrome.tabs.create({ url: `https://github.com/${pr.owner}/${pr.repo}/blob/${overview.sha}/${current.file}#L${current.startLine}-L${current.endLine}` })
      );
      location.append(el('span', { className: 'muted small', textContent: ' · not in the visible diff · ' }), open);
    } else if (inDiff) {
      location.append(el('span', { className: 'muted small', textContent: ' · highlighted in the diff' }));
    }

    const running = deepening?.key === key && !deepening.error;
    const deeperButton = el('button', {
      type: 'button',
      disabled: running || Boolean(deepening && !deepening.error),
      textContent: subStops[key] ? `Go deeper (${subStops[key].length})` : running ? 'Going deeper…' : 'Go deeper',
    });
    deeperButton.addEventListener('click', deeper);
    const diffButton = el('button', { type: 'button', textContent: showDiff ? 'Hide changes' : 'What changed here?' });
    diffButton.addEventListener('click', toggleDiff);

    const isLast = level().index === level().stops.length - 1;
    const prev = el('button', { type: 'button', textContent: '‹ Back', disabled: level().index === 0 && tour.levels.length === 1 });
    prev.addEventListener('click', back);
    const nextLabel = atEnd() ? 'Finish tour' : isLast ? 'Continue ›' : 'Next ›';
    const nextButton = el('button', { type: 'button', className: 'primary', textContent: nextLabel });
    nextButton.addEventListener('click', next);

    const explanation = el('div', { className: 'md' });
    explanation.innerHTML = renderMarkdown(current.explanation);

    root.append(
      ...[
      el('div', { className: 'tour-head' }, crumbs, end),
      el('div', { className: 'muted small', textContent: `Stop ${level().index + 1} of ${level().stops.length} · ${current.layer}` }),
      el('h3', { className: 'stop-title', textContent: current.title }),
      explanation,
      location,
      el('div', { className: 'row tour-actions' }, deeperButton, diffButton),
      running
        ? el('div', { className: 'deepening' },
            el('div', { className: 'muted small', textContent: 'Following the code further in… (usually under a minute)' }),
            ...deepening.actions.slice(-4).map((a) => el('div', { className: 'tool', textContent: `${a.name} ${a.detail}`.trim() })))
        : null,
      deepening?.key === key && deepening.error ? el('p', { className: 'error small', textContent: deepening.error }) : null,
      showDiff ? diffView(key) : null,
      excerptView(key),
      el('div', { className: 'row tour-nav' }, prev, nextButton),
      ].filter(Boolean)
    );
  }

  return {
    start,
    exit,
    render,
    get active() {
      return Boolean(tour);
    },
    onKey(e) {
      if (!tour || /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName)) return;
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') back();
    },
  };
}
