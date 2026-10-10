// Runs a guided tour through a user flow on the GitHub PR page: moves between files via
// GitHub's single-file mode, draws each stop with LesehilfeOverlay, and keeps the tour in
// storage so it survives page reloads. The side panel starts it and streams storyboards in.
// Content script.
(() => {
  const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
  const STORAGE_KEY = 'pageTour';
  // Set in this tab's sessionStorage right before a reload the tour itself causes (switching into
  // single-file mode). Only then does the tour continue by itself; a fresh visit or a manual
  // reload leaves it paused until it is resumed from the side panel.
  const RESUME_FLAG = 'lesehilfe-tour-resume';
  const { create, tableFor, rowCell } = globalThis.LesehilfeOverlay;
  // Stop texts come from the agent, which reads untrusted PR content: never insert them as HTML.
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // { prKey, owner, repo, number, sha, flowIndex, flowTitle, stops, storyboards: { [i]: beats },
  //   index (current stop), beat (beats revealed in it), seen: { [i]: true } }
  let tour = null;
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
      sessionStorage.setItem(RESUME_FLAG, tour.prKey);
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
    const beats = beatsFor(tour.index).length;
    const pending = tour.stops.filter((_, i) => !tour.storyboards[i]).length;
    const last = tour.stops.length - 1;
    overlay.setRemote({
      flowTitle: tour.flowTitle,
      index: tour.index,
      total: tour.stops.length,
      title: stop.title,
      beat: tour.beat,
      beats,
      status: pending ? `sketching ${tour.stops.length - pending}/${tour.stops.length}` : '',
      canPrev: tour.index > 0 || tour.beat > 1,
      canNext: tour.index < last || tour.beat < beats,
      canPrevStop: tour.index > 0,
      canNextStop: tour.index < last,
    });
  }

  /**
   * Shows stop `index`. A new stop starts with its first beat, animated; a stop seen before
   * (or reached by stepping back) shows all its beats at once.
   */
  async function show(index, { all = false } = {}) {
    const seenBefore = Boolean(tour.seen?.[index]) || all;
    tour.index = index;
    tour.beat = seenBefore ? beatsFor(index).length : 1;
    save();
    notify({ prKey: tour.prKey, index, total: tour.stops.length });
    if (!overlay) {
      overlay = create({
        onPrev: back, onNext: forward, onPrevStop: prevStop, onNextStop: nextStop,
        onReplay: replay, onClose: end,
      });
    }
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
    const hasStoryboard = Boolean(tour.storyboards[index]);
    shownKey = `${index}:${hasStoryboard ? 'sb' : 'fallback'}`;
    if (hasStoryboard) {
      tour.seen = { ...tour.seen, [index]: true };
      save();
    }
    await overlay.showStop(
      { file: stop.file, startLine: stop.startLine, endLine: stop.endLine, beats: beatsFor(index) },
      { reveal: tour.beat, animate: !seenBefore }
    );
  }

  // → : next beat, or the next stop after the last beat. ← : back a beat, or the previous stop.
  function forward() {
    if (!tour || !overlay) return;
    if (tour.beat < beatsFor(tour.index).length) {
      tour.beat++;
      save();
      updateRemote();
      overlay.reveal(tour.beat, { animate: true });
    } else {
      nextStop();
    }
  }
  function back() {
    if (!tour || !overlay) return;
    if (tour.beat > 1) {
      tour.beat--;
      save();
      updateRemote();
      overlay.reveal(tour.beat);
    } else if (tour.index > 0) {
      show(tour.index - 1, { all: true });
    }
  }
  const nextStop = () => tour && tour.index < tour.stops.length - 1 && show(tour.index + 1);
  const prevStop = () => tour && tour.index > 0 && show(tour.index - 1, { all: true });

  // Replay the current stop from its first beat.
  function replay() {
    if (!tour) return;
    tour.seen = { ...tour.seen, [tour.index]: false };
    show(tour.index);
  }

  function end() {
    overlay?.destroy();
    overlay = null;
    const prKey = tour?.prKey ?? currentPR();
    tour = null;
    shownKey = null;
    if (alive()) chrome.storage.local.remove(STORAGE_KEY);
    notify({ prKey, ended: true });
  }

  document.addEventListener('keydown', (e) => {
    if (!tour || !overlay || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!['ArrowRight', 'ArrowLeft', 'Escape'].includes(e.key)) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    if (e.key === 'ArrowRight') (e.shiftKey ? nextStop : forward)();
    else if (e.key === 'ArrowLeft') (e.shiftKey ? prevStop : back)();
    else if (e.key === 'Escape') end();
    else return;
    e.preventDefault();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'tourStart') {
      tour = { ...message.tour, storyboards: message.tour.storyboards || {}, index: 0, beat: 1, seen: {} };
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
    } else if (message.type === 'tourResume') {
      resumeSaved().then((ok) => sendResponse({ ok }));
      return true;
    } else if (message.type === 'tourStatus') {
      if (tour) {
        sendResponse({ prKey: tour.prKey, flowIndex: tour.flowIndex, index: tour.index, total: tour.stops.length });
      } else {
        // A saved tour for this PR that isn't running: the panel offers to resume it.
        savedTour().then((saved) =>
          sendResponse(saved ? { prKey: saved.prKey, flowIndex: saved.flowIndex, index: saved.index, total: saved.stops.length, paused: true } : null)
        );
        return true;
      }
    }
  });

  async function savedTour() {
    if (!alive()) return null;
    const { [STORAGE_KEY]: saved } = await chrome.storage.local.get(STORAGE_KEY);
    return saved && saved.prKey === currentPR() ? saved : null;
  }

  async function resumeSaved() {
    const saved = await savedTour();
    if (!saved) return false;
    tour = saved;
    show(saved.index, { all: true });
    return true;
  }

  // Continue only after a reload the tour caused itself.
  const resumeFor = sessionStorage.getItem(RESUME_FLAG);
  sessionStorage.removeItem(RESUME_FLAG);
  if (resumeFor && resumeFor === currentPR()) resumeSaved();

  // Leaving the PR (GitHub navigates without reloading): put the drawings away, keep the tour.
  setInterval(() => {
    if (tour && overlay && currentPR() !== tour.prKey) {
      overlay.destroy();
      overlay = null;
      shownKey = null;
    }
  }, 1000);
})();
