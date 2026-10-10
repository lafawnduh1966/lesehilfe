// Runs a guided tour through a user flow on the GitHub PR page: moves between files via
// GitHub's single-file mode, draws each stop with LesehilfeOverlay, and keeps the tour in
// storage so it survives page reloads. The side panel starts it and streams storyboards in.
//
// Between stops a transition card says where the flow goes next and why; a stop starts with
// where control arrives and ends by marking where it leaves. Content script.
(() => {
  const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
  const STORAGE_KEY = 'pageTour';
  // Set in this tab's sessionStorage right before a reload the tour itself causes (switching into
  // single-file mode). Only then does the tour continue by itself; a fresh visit or a manual
  // reload leaves it paused until it is resumed from the side panel.
  const RESUME_FLAG = 'lesehilfe-tour-resume';
  const { create, tableFor, rowCell } = globalThis.LesehilfeOverlay;
  // Stop texts come from the agent, which reads untrusted PR content: never insert them as HTML.
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const base = (file) => file.split('/').pop();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const KINDS = {
    start: ['▶', 'Where it starts'],
    calls: ['⤵', 'Calls into'],
    transaction: ['⛓', 'On-chain transaction'],
    later: ['⏭', 'Later, separately'],
    event: ['📡', 'Reacts to an event'],
    returns: ['↩', 'Returns to'],
  };

  // { prKey, owner, repo, number, sha, flowIndex, flowTitle, flowSummary, stops,
  //   storyboards: { [i]: { beats, arrival, fileRole, inFunction } },
  //   index (current stop), phase ('card' before entering a stop | 'stop'),
  //   beat (beats revealed), seen: { [i]: true }, lastFile }
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
  // Where the tour is, for the side panel's map.
  const position = () => ({
    prKey: tour.prKey, flowIndex: tour.flowIndex, index: tour.index, total: tour.stops.length,
    phase: tour.phase, beat: tour.beat, seen: tour.seen || {},
    notes: beatsFor(tour.index).map((b) => ({ note: b.note, tone: b.tone, placeholder: Boolean(b.extra) })),
    zoom: [
      ...(tour.zoom?.unfold ? [`beat ${tour.zoom.unfold.beat + 1} · detail ${tour.zoom.unfold.levels.length + 1}`] : []),
      ...(tour.zoom?.dives || []).map((d) => d.title + (d.unfold ? ` · detail ${d.unfold.levels.length + 1}` : '')),
    ],
  });
  const report = () => tour && notify(position());

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
      return true;
    }
    // Full navigation: the tour resumes from storage after the reload.
    sessionStorage.setItem(RESUME_FLAG, tour.prKey);
    location.assign(`/${tour.owner}/${tour.repo}/pull/${tour.number}/changes?mode=single${hash}`);
    return false;
  }

  async function waitForLines(stop, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const table = tableFor(stop.file);
      if (table && rowCell(table, stop.startLine)) return 'ok';
      if (table && table.querySelector('td.diff-text-cell') && Date.now() - start > 3000) return 'not-in-diff';
      await sleep(200);
    }
    return tableFor(stop.file) ? 'not-in-diff' : 'missing';
  }

  // --- The tour's route in GitHub's file tree ------------------------------------------------
  // Every file with stops gets their numbers; the current file is highlighted and kept in view
  // in the tree. GitHub re-renders the tree, so the marks are re-applied after DOM changes.

  // The visible row of a file's tree item (the <li> also wraps nothing else for files).
  const treeRow = (file) => {
    const li = document.getElementById(file);
    return li?.getAttribute('role') === 'treeitem' ? li.querySelector(':scope > [class*="TreeView-item-container"]') : null;
  };

  function markTree() {
    document.querySelectorAll('.lesehilfe-tree-badge').forEach((badge) => badge.remove());
    document.querySelectorAll('.lesehilfe-tree-stop, .lesehilfe-tree-current').forEach((row) => row.classList.remove('lesehilfe-tree-stop', 'lesehilfe-tree-current'));
    if (!tour || !overlay) return;
    const stopsByFile = new Map();
    tour.stops.forEach((stop, i) => stopsByFile.set(stop.file, [...(stopsByFile.get(stop.file) || []), i + 1]));
    // A real element rather than ::after: GitHub uses the pseudo-elements for its own current-file bar.
    for (const [file, numbers] of stopsByFile) {
      const row = treeRow(file);
      if (!row) continue;
      row.classList.add('lesehilfe-tree-stop');
      const badge = document.createElement('span');
      badge.className = 'lesehilfe-tree-badge';
      badge.textContent = numbers.join(' ');
      // Inside the name element, before the name: the row is a grid that would put a sibling
      // at the end; here the badge comes first and only the name gets truncated.
      const name = row.querySelector('[class*="TreeView-item-content-text"]');
      if (name) name.prepend(badge);
      else row.appendChild(badge);
    }
    const current = treeRow(tour.stops[tour.index].file);
    if (!current) return;
    current.classList.add('lesehilfe-tree-current');
    // Scroll only the tree's own pane (scrollIntoView would also move the page).
    let pane = current.parentElement;
    while (pane && !(/(auto|scroll)/.test(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight)) pane = pane.parentElement;
    if (pane) {
      const item = current.getBoundingClientRect();
      const box = pane.getBoundingClientRect();
      if (item.top < box.top + 40 || item.bottom > box.bottom - 40) pane.scrollTop += item.top - box.top - box.height / 3;
    }
  }

  let treeTimer;
  new MutationObserver(() => {
    if (!tour || !overlay) return;
    clearTimeout(treeTimer);
    treeTimer = setTimeout(() => {
      const current = tour && treeRow(tour.stops[tour.index].file);
      if (current && !(current.classList.contains('lesehilfe-tree-current') && current.querySelector('.lesehilfe-tree-badge'))) markTree();
    }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // --- What a stop shows ----------------------------------------------------------------------

  const storyboard = (i) => {
    const sb = tour.storyboards[i];
    return Array.isArray(sb) ? { beats: sb } : sb || null;
  };

  /** The stop's beats: where control arrives, the agent's storyboard, then where it leaves. */
  function beatsFor(i) {
    const stop = tour.stops[i];
    const sb = storyboard(i);
    if (!sb) {
      // Until the storyboard arrives, show the overview's explanation.
      return [{ lines: [stop.startLine, stop.endLine], shape: 'bracket', tone: 'neutral', note: stop.explanation, wide: true,
        extra: '<div class="muted">Lesehilfe is sketching this stop…</div>' }];
    }
    const beats = [...sb.beats];
    const arrival = sb.arrival || {};
    const prev = tour.stops[i - 1];
    if (arrival.entryLine && !(beats[0]?.lines[0] === arrival.entryLine && beats[0]?.token === arrival.entryToken)) {
      const from = prev && arrival.fromLine ? ` from \`${base(prev.file)}:${arrival.fromLine}\`` : '';
      beats.unshift({ lines: [arrival.entryLine], token: arrival.entryToken, shape: arrival.entryToken ? 'circle' : 'underline', tone: 'neutral',
        note: i === 0 ? `**Start here.** ${arrival.why || ''}`.trim() : `↳ **Arrives here**${from}.` });
    }
    const next = tour.stops[i + 1];
    const out = storyboard(i + 1)?.arrival;
    if (next && out?.fromLine && out.fromLine >= stop.startLine - 5 && out.fromLine <= stop.endLine + 5) {
      const where = next.file === stop.file ? 'further down this file' : `in \`${base(next.file)}\``;
      beats.push({ lines: [out.fromLine], token: out.fromToken, shape: out.fromToken ? 'circle' : 'underline', tone: 'neutral',
        note: `→ **Next:** ${next.title} — ${where}.` });
    }
    return beats;
  }

  function transitionCard(i) {
    const stop = tour.stops[i];
    const sb = storyboard(i);
    const arrival = sb?.arrival || {};
    const prev = tour.stops[i - 1];
    const [icon, label] = KINDS[arrival.kind || (i === 0 ? 'start' : 'calls')] || KINDS.calls;
    const files = prev && prev.file !== stop.file
      ? `<span class="file">${esc(base(prev.file))}</span><span class="arrow">→</span><span class="file to">${esc(base(stop.file))}</span>`
      : `<span class="file to">${esc(base(stop.file))}</span>${prev ? '<span class="arrow">(same file)</span>' : ''}`;
    const why = arrival.why || (i === 0 ? tour.flowSummary : '') || '';
    return (
      `<div class="eyebrow">${i === 0 ? esc(tour.flowTitle) : `Next · stop ${i + 1} of ${tour.stops.length}`}</div>` +
      `<div class="files">${files}</div>` +
      `<div class="kind">${icon} ${esc(label)}: ${esc(stop.title)}</div>` +
      (sb?.fileRole ? `<div class="role">${esc(base(stop.file))} — ${esc(sb.fileRole)}</div>` : '') +
      (why ? `<div class="why">${esc(why)}</div>` : '<div class="why">Lesehilfe is still sketching this part…</div>') +
      `<div class="hint"><kbd>→</kbd> continue · <kbd>←</kbd> back · <kbd>Esc</kbd> end</div>`
    );
  }

  // --- Zooming and questions --------------------------------------------------------------
  // What's on screen is a frame: the stop itself, or a sub-tour reached by zooming into a beat
  // ("dive"). In a frame, one beat can be unfolded through several levels of detail.
  // tour.zoom = { unfold: { beat, levels }, dives: [{ key, title, file, startLine, endLine, beats, beat, unfold }] }
  // tour.threads = { "<frame key>:<beat>": { messages: [{ q, a, pending, error }], open, draft } }

  let lastView = []; // beats as last drawn, with .orig = index in the frame's own beats
  let zoomPending = null; // { frameKey, beat } while the helper works on a zoom

  function frameInfo() {
    const dive = tour.zoom?.dives?.at(-1);
    if (dive) return { ...dive, dive };
    const stop = tour.stops[tour.index];
    return { key: `s${tour.index}`, title: '', file: stop.file, startLine: stop.startLine, endLine: stop.endLine,
      beats: beatsFor(tour.index), beat: tour.beat, unfold: tour.zoom?.unfold || null, dive: null };
  }
  function setFrameBeat(f, n) {
    if (f.dive) f.dive.beat = n;
    else tour.beat = n;
  }
  function setFrameUnfold(f, unfold) {
    if (f.dive) f.dive.unfold = unfold;
    else tour.zoom = { ...(tour.zoom || { dives: [] }), unfold };
  }

  /** The beats to draw for a frame: threads, the unfolded beat with its finer marks, the rest dimmed. */
  function viewBeats(f) {
    const view = [];
    f.beats.forEach((b, i) => {
      const unfolded = f.unfold?.beat === i;
      const v = { ...b, orig: i, label: String(i + 1), thread: tour.threads?.[`${f.key}:${i}`], current: i === f.beat - 1,
        canUp: Boolean(f.dive) };
      if (b.extra) v.actions = false; // placeholder while sketching
      if (zoomPending?.frameKey === f.key && zoomPending.beat === i) v.extra = '<div class="muted">Zooming in…</div>';
      if (unfolded) {
        const levels = f.unfold.levels;
        Object.assign(v, { note: levels.at(-1).detail || b.note, unfolded: true, level: levels.length + 1, maxed: levels.at(-1).canGoDeeper === false });
      } else if (f.unfold) {
        v.dim = true;
      }
      view.push(v);
      if (unfolded) {
        f.unfold.levels.flatMap((l) => l.marks || []).forEach((m, k) => view.push({ ...m, orig: null, label: `${i + 1}${'abcdefghij'[k] || k}`, actions: false }));
      }
    });
    return view;
  }
  // How many view beats are revealed: the frame's beats so far, plus the marks of an unfolded beat among them.
  const shownCount = (f, view) => view.filter((v, n) => (v.orig ?? view.slice(0, n).reverse().find((w) => w.orig != null)?.orig) < f.beat).length;

  function renderFrame() {
    const f = frameInfo();
    lastView = viewBeats(f);
    overlay.update(lastView, shownCount(f, lastView));
  }

  /** Draws the current frame from scratch (after a file change or going up out of a dive). */
  async function enterFrame({ animate }) {
    const f = frameInfo();
    lastView = viewBeats(f);
    overlay.showCard('');
    if (!(await openFile(f.file))) return;
    const status = await waitForLines(f);
    if (status !== 'ok' || frameInfo().key !== f.key) return;
    tour.lastFile = f.file;
    await overlay.showStop({ file: f.file, startLine: f.startLine, endLine: f.endLine, beats: lastView }, { reveal: animate ? 1 : shownCount(f, lastView), animate });
    overlay.setContext(f.dive ? `${base(f.file)} › ${f.dive.inFunction || f.dive.title}` : `${base(f.file)}${storyboard(tour.index)?.inFunction ? ` › ${storyboard(tour.index).inFunction}()` : ''}`);
  }

  // ↓ : the next level of detail for a beat — unfold it, or dive into what it calls (the agent decides).
  async function deeper(viewIndex) {
    if (!tour || tour.phase !== 'stop' || zoomPending) return;
    const f = frameInfo();
    const v = lastView[viewIndex ?? lastView.findIndex((b) => b.current)];
    if (!v || v.orig == null || v.actions === false) return;
    const i = v.orig;
    const levels = f.unfold?.beat === i ? f.unfold.levels : [];
    if (levels.at(-1)?.canGoDeeper === false) return;
    if (f.beat < i + 1) setFrameBeat(f, i + 1);
    zoomPending = { frameKey: f.key, beat: i };
    renderFrame();
    updateRemote('zooming in…');
    const beat = f.beats[i];
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'tourZoom',
        request: {
          stopIndex: tour.index, frameKey: f.key, beatIndex: i,
          frame: { file: f.file, startLine: f.startLine, endLine: f.endLine, title: f.title },
          beat: { lines: beat.lines, token: beat.token, note: beat.note },
          history: levels.map((l) => l.detail),
        },
      });
    } catch {
      res = { error: 'Open the Lesehilfe side panel to zoom in.' };
    }
    zoomPending = null;
    if (!tour || frameInfo().key !== f.key) return;
    if (!res?.result) {
      updateRemote(res?.error || 'no more detail here');
      return renderFrame();
    }
    if (res.result.mode === 'dive') {
      tour.zoom = { ...(tour.zoom || {}), dives: [...(tour.zoom?.dives || []), {
        key: `${f.key}/${i}`, title: res.result.title, file: res.result.file, startLine: res.result.startLine, endLine: res.result.endLine,
        inFunction: res.result.inFunction, beats: res.result.beats, beat: 1, unfold: null,
      }] };
      save();
      report();
      updateRemote();
      return enterFrame({ animate: true });
    }
    setFrameUnfold(f, { beat: i, levels: [...levels, res.result] });
    save();
    report();
    updateRemote();
    renderFrame();
  }

  // ↑ : one level less detail; out of a dive back to where it started.
  function up() {
    if (!tour || tour.phase !== 'stop') return false;
    const f = frameInfo();
    if (f.unfold) {
      const levels = f.unfold.levels.slice(0, -1);
      setFrameUnfold(f, levels.length ? { ...f.unfold, levels } : null);
      save();
      report();
      updateRemote();
      renderFrame();
      return true;
    }
    if (f.dive) {
      tour.zoom.dives = tour.zoom.dives.slice(0, -1);
      save();
      report();
      updateRemote();
      enterFrame({ animate: false });
      return true;
    }
    return false;
  }

  function onBeatAction(viewIndex, action) {
    const f = frameInfo();
    const v = lastView[viewIndex];
    if (!v) return;
    if (action === 'deeper') return deeper(viewIndex);
    if (action === 'up') return up();
    const key = `${f.key}:${v.orig}`;
    tour.threads = tour.threads || {};
    if (action === 'ask') {
      tour.threads[key] = { messages: [], ...tour.threads[key], open: true };
      overlay.focusThread(viewIndex);
    } else if (action === 'close-thread') {
      if (tour.threads[key]) tour.threads[key].open = false;
      overlay.focusThread(null);
    }
    save();
    renderFrame();
  }

  function onThreadDraft(viewIndex, text) {
    const thread = tour.threads?.[`${frameInfo().key}:${lastView[viewIndex]?.orig}`];
    if (thread) thread.draft = text;
  }

  function onThreadSend(viewIndex, question) {
    const f = frameInfo();
    const v = lastView[viewIndex];
    const threadKey = `${f.key}:${v.orig}`;
    const thread = (tour.threads[threadKey] ||= { messages: [], open: true });
    thread.messages.push({ q: question, a: '', pending: true });
    thread.draft = '';
    save();
    renderFrame();
    chrome.runtime
      .sendMessage({
        type: 'tourAsk',
        threadKey,
        question,
        where: { stopIndex: tour.index, frameTitle: f.title, file: f.file, startLine: f.startLine, endLine: f.endLine,
          lines: v.lines, token: v.token, note: v.note, label: v.label },
      })
      .catch(() => onAnswer({ threadKey, error: 'Open the Lesehilfe side panel to ask questions.', done: true }));
  }

  let reflowAt = 0;
  function onAnswer({ threadKey, text, error, done }) {
    const thread = tour?.threads?.[threadKey];
    const message = thread?.messages.findLast((m) => m.pending) || thread?.messages.at(-1);
    if (!message) return;
    if (error) message.error = error;
    if (text != null) message.a = text;
    message.pending = !done;
    if (done) save();
    const f = frameInfo();
    const viewIndex = lastView.findIndex((v) => `${f.key}:${v.orig}` === threadKey);
    if (viewIndex < 0) return;
    // Stream into the note directly; re-layout now and then so the notes below make room.
    const shown = overlay.setAnswer(viewIndex, thread.messages.indexOf(message), message.a, message.pending);
    if (done || !shown || Date.now() - reflowAt > 800) {
      reflowAt = Date.now();
      renderFrame();
    }
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = create({
      onPrev: back, onNext: forward, onPrevStop: prevStop, onNextStop: nextStop, onReplay: replay, onClose: end,
      onBeatAction, onThreadDraft, onThreadSend,
    });
  }

  function updateRemote(note = '') {
    const stop = tour.stops[tour.index];
    const f = tour.phase === 'stop' ? frameInfo() : null;
    const beats = f ? f.beats.length : 0;
    const pending = tour.stops.filter((_, i) => !storyboard(i)).length;
    const last = tour.stops.length - 1;
    overlay.setRemote({
      flowTitle: tour.flowTitle,
      index: tour.index,
      total: tour.stops.length,
      title: f?.dive ? `${stop.title} › ${f.dive.title}` : stop.title,
      beat: f ? f.beat : 0,
      beats,
      status: note || (f?.unfold ? `detail ${f.unfold.levels.length + 1} · ↑ less` : '') || (pending ? `sketching ${tour.stops.length - pending}/${tour.stops.length}` : ''),
      canPrev: tour.index > 0 || (tour.phase === 'stop' && tour.beat > 1),
      canNext: true,
      canPrevStop: tour.index > 0,
      canNextStop: tour.index < last,
    });
  }

  // --- Moving through the tour ------------------------------------------------------------

  /** The card before stop `index`: where the flow goes next, and why. */
  function showTransition(index) {
    tour.index = index;
    tour.phase = 'card';
    tour.zoom = null;
    tour.beat = 0;
    save();
    report();
    ensureOverlay();
    updateRemote();
    markTree();
    shownKey = `${index}:card:${storyboard(index) ? 'sb' : 'fallback'}`;
    overlay.showCard(transitionCard(index), { transition: true });
  }

  /**
   * Shows stop `index`. A new stop starts with its first beat, animated, after a look at the
   * top of its file when the file changed; a stop seen before (or reached by stepping back)
   * shows all its beats at once.
   */
  async function show(index, { all = false } = {}) {
    const seenBefore = Boolean(tour.seen?.[index]) || all;
    tour.index = index;
    tour.phase = 'stop';
    tour.zoom = null;
    tour.beat = seenBefore ? beatsFor(index).length : 1;
    save();
    report();
    ensureOverlay();
    updateRemote();
    markTree();
    const stop = tour.stops[index];
    overlay.showCard('');
    if (!(await openFile(stop.file))) return; // page is navigating
    const status = await waitForLines(stop);
    if (tour?.index !== index || tour.phase !== 'stop') return;
    if (status !== 'ok') {
      const url = `https://github.com/${tour.owner}/${tour.repo}/blob/${tour.sha}/${stop.file.split('/').map(encodeURIComponent).join('/')}#L${stop.startLine}-L${stop.endLine}`;
      shownKey = null;
      overlay.showCard(
        `<b>${esc(stop.title)}</b><br>${esc(stop.explanation)}<br><br>` +
          `This code (<code>${esc(base(stop.file))}:${stop.startLine}</code>) isn't part of the visible diff. ` +
          `<a href="${esc(url)}" target="_blank" rel="noopener">Open it on GitHub ↗</a>`
      );
      return;
    }

    // Establishing shot: arriving in a new file, look at its top before gliding down to the stop.
    if (!seenBefore && tour.lastFile !== stop.file) {
      const table = tableFor(stop.file);
      window.scrollTo({ top: Math.max(0, table.getBoundingClientRect().top + scrollY - 140), behavior: 'instant' });
      await sleep(700);
      if (tour?.index !== index || tour.phase !== 'stop') return;
    }
    tour.lastFile = stop.file;

    const sb = storyboard(index);
    shownKey = `${index}:${sb ? 'sb' : 'fallback'}`;
    if (sb) tour.seen = { ...tour.seen, [index]: true };
    save();
    report();
    lastView = viewBeats(frameInfo());
    await overlay.showStop(
      { file: stop.file, startLine: stop.startLine, endLine: stop.endLine, beats: lastView },
      { reveal: tour.beat, animate: !seenBefore }
    );
    if (tour?.index === index) overlay.setContext(`${base(stop.file)}${sb?.inFunction ? ` › ${sb.inFunction}()` : ''}`);
  }

  // → : continue past a card, reveal the next beat (closing an unfolded one), leave a dive at its
  // end, or go to the next stop's card.
  function forward() {
    if (!tour || !overlay) return;
    if (tour.phase === 'card') return show(tour.index);
    const f = frameInfo();
    if (f.unfold) setFrameUnfold(f, null);
    if (f.beat < f.beats.length) {
      setFrameBeat(f, f.beat + 1);
      save();
      report();
      updateRemote();
      const view = viewBeats(frameInfo());
      lastView = view;
      overlay.update(view, f.beat);
      return overlay.reveal(f.beat + 1, { animate: true });
    }
    if (f.dive) return up();
    if (tour.index < tour.stops.length - 1) return showTransition(tour.index + 1);
    end();
  }
  // ← : less detail, back a beat, out of a dive, or to the previous stop (fully shown).
  function back() {
    if (!tour || !overlay) return;
    const f = tour.phase === 'stop' ? frameInfo() : null;
    if (f?.unfold) return up();
    if (f && f.beat > 1) {
      setFrameBeat(f, f.beat - 1);
      save();
      report();
      updateRemote();
      return renderFrame();
    }
    if (f?.dive) return up();
    if (tour.index > 0) return show(tour.index - 1, { all: true });
  }
  const nextStop = () => tour && tour.index < tour.stops.length - 1 && showTransition(tour.index + 1);
  const prevStop = () => tour && tour.index > 0 && show(tour.index - 1, { all: true });

  // Replay the current stop from its first beat.
  function replay() {
    if (!tour) return;
    tour.seen = { ...tour.seen, [tour.index]: false };
    tour.lastFile = null;
    show(tour.index);
  }

  function end() {
    overlay?.destroy();
    overlay = null;
    markTree(); // clears the marks
    const prKey = tour?.prKey ?? currentPR();
    tour = null;
    shownKey = null;
    if (alive()) chrome.storage.local.remove(STORAGE_KEY);
    notify({ prKey, ended: true });
  }

  document.addEventListener('keydown', (e) => {
    if (!tour || !overlay || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Escape', '?'].includes(e.key)) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    const inStop = tour.phase === 'stop';
    if (e.key === 'ArrowRight') (e.shiftKey ? nextStop : forward)();
    else if (e.key === 'ArrowLeft') (e.shiftKey ? prevStop : back)();
    else if (e.key === 'ArrowDown' && inStop) deeper();
    else if (e.key === 'ArrowUp' && inStop) {
      if (!up()) return; // nothing to zoom out of: let the page scroll
    } else if (e.key === '?' && inStop) onBeatAction(lastView.findIndex((b) => b.current), 'ask');
    else if (e.key === 'Escape') end();
    else return;
    e.preventDefault();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'tourStart') {
      tour = { ...message.tour, storyboards: message.tour.storyboards || {}, index: 0, phase: 'card', beat: 0, seen: {}, lastFile: null };
      showTransition(0);
      sendResponse({ ok: true });
    } else if (message.type === 'tourStoryboard' && tour && message.flowIndex === tour.flowIndex && message.prKey === tour.prKey) {
      tour.storyboards[message.index] = message.storyboard;
      save();
      if (!overlay) return;
      updateRemote();
      // Replace placeholders on screen: a card waiting for its "why", or a stop's fallback note.
      if (message.index === tour.index && shownKey === `${tour.index}:card:fallback`) showTransition(tour.index);
      else if (message.index === tour.index && shownKey === `${tour.index}:fallback`) show(tour.index);
    } else if (message.type === 'tourAnswer') {
      onAnswer(message);
    } else if (message.type === 'tourEnd') {
      end();
    } else if (message.type === 'tourGoto' && tour && overlay) {
      if (tour.zoom?.dives?.length || tour.zoom?.unfold) {
        // From the map: leave any zoom first.
        tour.zoom = null;
        if (message.index === tour.index) {
          tour.beat = Math.min(message.beat || tour.beat, beatsFor(tour.index).length);
          save();
          report();
          updateRemote();
          return enterFrame({ animate: false });
        }
      }
      // From the panel's map: a beat of the stop on screen, or another stop.
      if (message.index === tour.index && tour.phase === 'stop' && message.beat) {
        tour.beat = Math.min(message.beat, beatsFor(tour.index).length);
        save();
        report();
        updateRemote();
        renderFrame();
      } else if (message.index !== tour.index || tour.phase !== 'stop') {
        show(message.index, { all: Boolean(tour.seen?.[message.index]) || message.index < tour.index });
      }
    } else if (message.type === 'tourResume') {
      resumeSaved().then((ok) => sendResponse({ ok }));
      return true;
    } else if (message.type === 'tourStatus') {
      if (tour) {
        sendResponse(position());
      } else {
        // A saved tour for this PR that isn't running: the panel offers to resume it.
        savedTour().then((saved) =>
          sendResponse(saved ? { prKey: saved.prKey, flowIndex: saved.flowIndex, index: saved.index, total: saved.stops.length, seen: saved.seen || {}, paused: true } : null)
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

  async function resumeSaved({ afterNavigation = false } = {}) {
    const saved = await savedTour();
    if (!saved) return false;
    tour = { ...saved, zoom: null };
    // After the tour's own navigation, continue where it was headed; otherwise show the stop.
    if (saved.phase === 'card' && !afterNavigation) showTransition(saved.index);
    else show(saved.index, { all: !afterNavigation });
    return true;
  }

  // Continue only after a reload the tour caused itself.
  const resumeFor = sessionStorage.getItem(RESUME_FLAG);
  sessionStorage.removeItem(RESUME_FLAG);
  if (resumeFor && resumeFor === currentPR()) resumeSaved({ afterNavigation: true });

  // Leaving the PR (GitHub navigates without reloading): put the drawings away, keep the tour.
  setInterval(() => {
    if (tour && overlay && currentPR() !== tour.prKey) {
      overlay.destroy();
      overlay = null;
      shownKey = null;
      markTree();
    }
  }, 1000);
})();
