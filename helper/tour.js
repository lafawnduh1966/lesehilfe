// Data for guided tours through a user flow: code excerpts for a stop (with the
// lines the PR changed), the PR's diff around a stop, and cached sub-stops.
import fs from 'node:fs';
import path from 'node:path';
import { OVERVIEWS_DIR, WORKTREES_DIR } from './paths.js';
import { getPRState, prGit } from './repo.js';
import { outsideCheckout } from './sandbox.js';

const CONTEXT_LINES = 3;
const MAX_EXCERPT_LINES = 160;

function checkedFile(worktree, file) {
  const reason = outsideCheckout(worktree, { path: file });
  if (reason) throw new Error(`Not inside the PR checkout: ${reason}`);
  return path.join(worktree, file);
}

/** Parses `@@ -a,b +c,d @@` hunk headers of a zero-context diff into added/modified new-file lines. */
async function changedLines(worktree, file) {
  const state = getPRState(worktree);
  if (!state?.baseSha) return new Set();
  const diff = await prGit(worktree, ['diff', '-M', '--unified=0', state.baseSha, state.sha, '--', file]);
  const lines = new Set();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] == null ? 1 : Number(m[2]);
    for (let n = start; n < start + count; n++) lines.add(n);
  }
  return lines;
}

/** Lines of `file` around [startLine, endLine] in the PR head: { lines: [{ n, text, changed, inRange }], truncated }. */
export async function excerpt(worktree, { file, startLine, endLine }) {
  const source = fs.readFileSync(checkedFile(worktree, file), 'utf8').split('\n');
  const changed = await changedLines(worktree, file);
  const from = Math.max(1, startLine - CONTEXT_LINES);
  const to = Math.min(source.length, endLine + CONTEXT_LINES, from + MAX_EXCERPT_LINES - 1);
  const lines = [];
  for (let n = from; n <= to; n++) {
    lines.push({ n, text: source[n - 1], changed: changed.has(n), inRange: n >= startLine && n <= endLine });
  }
  return { lines, truncated: to < Math.min(source.length, endLine + CONTEXT_LINES), changedInFile: changed.size };
}

/** The PR's diff hunks that touch [startLine, endLine] (new-file numbering). */
export async function stopDiff(worktree, { file, startLine, endLine }) {
  checkedFile(worktree, file);
  const state = getPRState(worktree);
  if (!state?.baseSha) throw new Error('The PR diff is not available.');
  const diff = await prGit(worktree, ['diff', '-M', '--unified=3', state.baseSha, state.sha, '--', file]);
  if (!diff) return { status: 'unchanged', hunks: [] };
  if (/^new file mode/m.test(diff)) return { status: 'added', hunks: [] };

  const hunks = [];
  for (const part of diff.split(/^(?=@@ )/m).slice(1)) {
    const m = part.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    const start = Number(m[1]);
    const end = start + (m[2] == null ? 1 : Number(m[2])) - 1;
    if (end >= startLine && start <= endLine) hunks.push(part.trimEnd());
  }
  return { status: hunks.length ? 'changed' : 'unchanged-here', hunks };
}

// --- Storyboards ---------------------------------------------------------------------------

/**
 * Checks an agent-written storyboard against the file: beats must lie within (or right
 * around) the stop, and tokens must actually appear on their line; otherwise the beat
 * falls back to marking whole lines rather than pointing at the wrong place.
 */
export function validateStoryboard(worktree, stops, index, storyboard) {
  const stop = stops[index];
  const lines = (file) => fs.readFileSync(checkedFile(worktree, file), 'utf8').split('\n');
  const source = lines(stop.file);
  const within = (s, src) => {
    const lo = Math.max(1, s.startLine - 5);
    const hi = Math.min(src.length, s.endLine + 5);
    return { lo, hi, ok: (n) => Number.isInteger(n) && n >= lo && n <= hi };
  };
  const here = within(stop, source);

  // The agent is often a line or two off: move to the nearest line that has the token.
  const snap = (line, token, src, range) => {
    if (!range.ok(line)) return null;
    if (!token || src[line - 1].includes(token)) return { line, token };
    const near = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6].map((d) => line + d).find((n) => range.ok(n) && src[n - 1]?.includes(token));
    return near ? { line: near, token } : { line, token: undefined };
  };

  const beats = [];
  for (const beat of storyboard.beats || []) {
    let [first, last = first] = beat.lines.map(Math.round);
    if (!here.ok(first) || !here.ok(last) || last < first) continue;
    const clean = { ...beat };
    const snapped = snap(first, clean.token, source, here);
    if (snapped.line !== first) {
      if (clean.arrowTo != null) clean.arrowTo += snapped.line - first;
      last += snapped.line - first;
      first = snapped.line;
    }
    if (!snapped.token) delete clean.token;
    clean.lines = [first, Math.max(first, Math.min(last, here.hi))];
    if (!clean.token && clean.shape !== 'bracket') clean.shape = last > first ? 'bracket' : 'underline';
    if (clean.arrowTo != null && (!here.ok(Math.round(clean.arrowTo)) || Math.round(clean.arrowTo) === first)) {
      delete clean.arrowTo;
      delete clean.arrowLabel;
    }
    beats.push(clean);
  }

  // Arrival: where control left the previous stop and where it enters this one.
  const arrival = {
    kind: storyboard.arrival?.kind || (index === 0 ? 'start' : 'calls'),
    why: storyboard.arrival?.why || '',
    short: (storyboard.arrival?.short || '').split(/\s+/).slice(0, 8).join(' '),
  };
  const prev = stops[index - 1];
  if (prev && storyboard.arrival?.fromLine != null) {
    const prevSource = prev.file === stop.file ? source : lines(prev.file);
    const from = snap(Math.round(storyboard.arrival.fromLine), storyboard.arrival.fromToken, prevSource, within(prev, prevSource));
    if (from) Object.assign(arrival, { fromLine: from.line, fromToken: from.token });
  }
  if (storyboard.arrival?.entryLine != null) {
    const entry = snap(Math.round(storyboard.arrival.entryLine), storyboard.arrival.entryToken, source, here);
    if (entry) Object.assign(arrival, { entryLine: entry.line, entryToken: entry.token });
  }
  return {
    beats,
    arrival,
    fileRole: storyboard.fileRole || '',
    inFunction: storyboard.inFunction || '',
    runsIn: (storyboard.runsIn || '').split(/\s+/).slice(0, 4).join(' '),
  };
}

// --- Cached sub-stops ("Go deeper") ------------------------------------------------------

function toursPath(worktree) {
  return path.join(OVERVIEWS_DIR, `${path.relative(WORKTREES_DIR, worktree)}.tours.json`);
}

/** Sub-stops per stop key ("<flow>/<step>/<substep>…"), valid for one overview run. */
export function loadTours(worktree, overviewCreatedAt) {
  try {
    const data = JSON.parse(fs.readFileSync(toursPath(worktree), 'utf8'));
    return data.overviewCreatedAt === overviewCreatedAt ? data.stops : {};
  } catch {
    return {};
  }
}

export function saveSubStops(worktree, overviewCreatedAt, key, stops) {
  saveTourEntry(worktree, overviewCreatedAt, key, stops);
}

/** Stores one entry (sub-stops, or a storyboard under "sb:<flow>:<stop>") for this overview run. */
export function saveTourEntry(worktree, overviewCreatedAt, key, value) {
  const all = { ...loadTours(worktree, overviewCreatedAt), [key]: value };
  const file = toursPath(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ overviewCreatedAt, stops: all }, null, 2));
}
