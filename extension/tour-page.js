// Runs a guided tour through a user flow on the GitHub PR page: moves between files via
// GitHub's single-file mode, draws each stop with LesehilfeOverlay, and keeps the tour in
// storage so it survives page reloads. The side panel starts it and streams storyboards in.
// Content script.
(() => {
  const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
  const STORAGE_KEY = 'pageTour';
  const { create, tableFor, rowCell } = globalThis.LesehilfeOverlay;
  // Stop texts come from the agent, which reads untrusted PR content: never insert them as HTML.
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let tour = null; // { prKey, owner, repo, number, sha, flowIndex, flowTitle, stops, storyboards: { [i]: beats }, index }
  let overlay = null;
  let shownKey = null; // which stop (and storyboard version) is currently drawn

  const currentPR = () => {
    const m = location.pathname.match(PR_PATH);
    return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
  };
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };
  const save = () => alive() && chrome.storage.local.set({ [STORAGE_KEY]: tour });
  const notify = (message) => alive() && chrome.runtime.sendMessage({ type: 'tourState', ...message }).catch(() => {});

  async function fileHash(file) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // GitHub virtualizes large diffs; single-file mode renders exactly the file we ask for.
  async function openFile(file) {
    const hash = `#diff-${await fileHash(file)}`;
    const onChanges = /\/pull\/\d+\/changes/.test(location.pathname);
    const single = new URLSearchParams(location.search).get('mode') === 'single';
    if (onChanges && single) {
      if (location.hash !== hash) location.hash = hash;
    } else {
      // Full navigation: the tour resumes from storage after the reload.
      location.assign(`/${tour.owner}/${tour.repo}/pull/${tour.number}/changes?mode=single${hash}`);
      return false;
    }
    return true;
  }

  async function waitForLines(stop, timeoutMs = 15000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const table = tableFor(stop.file);
      if (table && rowCell(table, stop.startLine)) return 'ok';
      if (table && table.querySelectorAll('td.diff-text-cell').length > 0 && Date.now() > until - timeoutMs + 3000) return 'not-in-diff';
      await new Promise((r) => setTimeout(r, 200));
    }
    return tableFor(stop.file) ? 'not-in-diff' : 'missing';
  }

  // Until the agent's storyboard arrives, the stop is shown with the overview's explanation.
  function beatsFor(i) {
    const stop = tour.stops[i];
    return (
      tour.storyboards[i] || [
        {
          lines: [stop.startLine, stop.endLine],
          shape: 'bracket',
          tone: 'neutral',
          note: stop.explanation,
          wide: true,
          extra: '<div class="muted">Lesehilfe is sketching this stop…</div>',
        },
      ]
    );
  }

  function updateRemote() {
    const stop = tour.stops[tour.index];
    const pending = tour.stops.filter((_, i) => !tour.storyboards[i]).length;
    overlay.setRemote({
      flowTitle: tour.flowTitle,
      index: tour.index,
      total: tour.stops.length,
      title: stop.title,
      status: pending ? `sketching ${tour.stops.length - pending}/${tour.stops.length}` : '',
      canPrev: tour.index > 0,
      canNext: tour.index < tour.stops.length - 1,
    });
  }

  async function show(index) {
    tour.index = index;
    save();
    notify({ prKey: tour.prKey, index, total: tour.stops.length });
    if (!overlay) overlay = create({ onPrev: prev, onNext: next, onReplay: () => overlay.replay(), onClose: end });
    updateRemote();
    const stop = tour.stops[index];
    overlay.showCard('');
    if (!(await openFile(stop.file))) return; // page is navigating
    const status = await waitForLines(stop);
    if (tour?.index !== index) return;
    if (status !== 'ok') {
      const url = `https://github.com/${tour.owner}/${tour.repo}/blob/${tour.sha}/${stop.file.split('/').map(encodeURIComponent).join('/')}#L${stop.startLine}-L${stop.endLine}`;
      shownKey = null;
      overlay.showCard(
        `<b>${esc(stop.title)}</b><br>${esc(stop.explanation)}<br><br>` +
          `This code (<code>${esc(stop.file.split('/').pop())}:${stop.startLine}</code>) isn't part of the visible diff. ` +
          `<a href="${esc(url)}" target="_blank" rel="noopener">Open it on GitHub ↗</a>`
      );
      return;
    }
    shownKey = `${index}:${tour.storyboards[index] ? 'sb' : 'fallback'}`;
    await overlay.showStop({ file: stop.file, startLine: stop.startLine, endLine: stop.endLine, beats: beatsFor(index) });
  }

  const next = () => tour && tour.index < tour.stops.length - 1 && show(tour.index + 1);
  const prev = () => tour && tour.index > 0 && show(tour.index - 1);

  function end() {
    overlay?.destroy();
    overlay = null;
    const prKey = tour?.prKey;
    tour = null;
    shownKey = null;
    if (alive()) chrome.storage.local.remove(STORAGE_KEY);
    notify({ prKey, ended: true });
  }

  document.addEventListener('keydown', (e) => {
    if (!tour || !overlay || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'Escape') end();
    else return;
    e.preventDefault();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'tourStart') {
      tour = { ...message.tour, storyboards: message.tour.storyboards || {}, index: 0 };
      show(0);
      sendResponse({ ok: true });
    } else if (message.type === 'tourStoryboard' && tour && message.flowIndex === tour.flowIndex && message.prKey === tour.prKey) {
      tour.storyboards[message.index] = message.beats;
      save();
      if (overlay) updateRemote();
      // Replace the placeholder of the stop on screen with its storyboard.
      if (message.index === tour.index && shownKey === `${tour.index}:fallback`) show(tour.index);
    } else if (message.type === 'tourEnd') {
      end();
    } else if (message.type === 'tourStatus') {
      sendResponse(tour ? { prKey: tour.prKey, flowIndex: tour.flowIndex, index: tour.index, total: tour.stops.length } : null);
    }
  });

  // Resume after a reload (e.g. the switch into single-file mode), only on the tour's PR.
  if (alive()) {
    chrome.storage.local.get(STORAGE_KEY).then(({ [STORAGE_KEY]: saved }) => {
      if (saved && saved.prKey === currentPR()) {
        tour = saved;
        show(saved.index);
      }
    });
  }

  // Leaving the PR (GitHub navigates without reloading): put the drawings away, keep the tour.
  setInterval(() => {
    if (tour && overlay && currentPR() !== tour.prKey) {
      overlay.destroy();
      overlay = null;
      shownKey = null;
    }
  }, 1000);
})();
