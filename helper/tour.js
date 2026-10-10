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
export function validateStoryboard(worktree, stop, beats) {
  const source = fs.readFileSync(checkedFile(worktree, stop.file), 'utf8').split('\n');
  const lo = Math.max(1, stop.startLine - 5);
  const hi = Math.min(source.length, stop.endLine + 5);
  const inStop = (n) => Number.isInteger(n) && n >= lo && n <= hi;
  const result = [];
  for (const beat of beats) {
    let [first, last = first] = beat.lines.map(Math.round);
    if (!inStop(first) || !inStop(last) || last < first) continue;
    const clean = { ...beat };
    if (clean.token && !source[first - 1].includes(clean.token)) {
      // The agent is often a line or two off: move the beat to the nearest line with the token.
      const near = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6].map((d) => first + d).find((n) => inStop(n) && source[n - 1]?.includes(clean.token));
      if (near) {
        if (clean.arrowTo != null) clean.arrowTo += near - first;
        last += near - first;
        first = near;
      } else {
        delete clean.token;
      }
    }
    clean.lines = [first, Math.max(first, Math.min(last, hi))];
    if (!clean.token && clean.shape !== 'bracket') clean.shape = last > first ? 'bracket' : 'underline';
    if (clean.arrowTo != null && (!inStop(Math.round(clean.arrowTo)) || Math.round(clean.arrowTo) === first)) {
      delete clean.arrowTo;
      delete clean.arrowLabel;
    }
    result.push(clean);
  }
  return result;
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
