// Keeps one partial bare clone per repo and one worktree per PR, checked out at the PR head:
//   ~/.lesehilfe/repos/<owner>/<repo>.git
//   ~/.lesehilfe/worktrees/<owner>/<repo>/pr-<n>
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPOS_DIR, WORKTREES_DIR } from './paths.js';
import { log } from './native.js';

const WORKTREE_MAX_AGE_DAYS = 14;
const NAME = /^[A-Za-z0-9_.-]+$/;

function git(args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `git ${args[0]} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`;
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// Ways to reach GitHub, tried in order. The token is passed via environment
// config so it never lands in a remote URL, git config, or the process list.
function strategies(owner, repo, token) {
  const https = `https://github.com/${owner}/${repo}.git`;
  const list = [];
  if (token) {
    list.push({
      name: 'GitHub sign-in',
      url: https,
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      },
    });
  }
  list.push({ name: 'git credentials', url: https, env: {} });
  list.push({ name: 'SSH', url: `git@github.com:${owner}/${repo}.git`, env: { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } });
  return list;
}

async function withStrategies(owner, repo, token, fn) {
  const errors = [];
  for (const s of strategies(owner, repo, token)) {
    try {
      return await fn(s);
    } catch (e) {
      errors.push(`${s.name}: ${e.message}`);
    }
  }
  throw new Error(`Could not access ${owner}/${repo} on GitHub.\n${errors.join('\n')}`);
}

// Serialize git operations per repo.
const locks = new Map();
function locked(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  return run;
}

export async function gitVersion() {
  try {
    return await git(['--version']);
  } catch {
    return null;
  }
}

export function worktreePath(owner, repo, number) {
  if (!NAME.test(owner) || !NAME.test(repo) || !Number.isInteger(number)) throw new Error('Invalid PR reference');
  return path.join(WORKTREES_DIR, owner, repo, `pr-${number}`);
}

const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._\/-]+$/;

// Per checkout: what the diff tools need (bare repo, head/base commits, git credentials).
const prState = new Map();
export const getPRState = (worktree) => prState.get(worktree);

/** Runs git in a PR's bare repo with the credentials that worked for fetching. */
export function prGit(worktree, args) {
  const state = prState.get(worktree);
  if (!state) throw new Error('PR is not prepared.');
  return git(args, { cwd: state.bare, env: state.env });
}

/**
 * Ensures a worktree at the PR head exists. With `base` (the PR's base branch),
 * also fetches it so the PR's diff can be computed locally.
 * Returns { path, sha, baseSha } (baseSha = merge base, or null without `base`).
 */
export function preparePR({ owner, repo, number, token, base }, progress = () => {}) {
  const worktree = worktreePath(owner, repo, number);
  if (base != null && !BRANCH.test(base)) throw new Error('Invalid base branch');

  return locked(`${owner}/${repo}`, async () => {
    const bare = path.join(REPOS_DIR, owner, `${repo}.git`);
    const ref = `refs/lesehilfe/pr-${number}`;

    if (!fs.existsSync(bare)) {
      progress(`Cloning ${owner}/${repo}…`);
      fs.mkdirSync(path.dirname(bare), { recursive: true });
      const tmp = `${bare}.tmp-${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      await withStrategies(owner, repo, token, async (s) => {
        fs.rmSync(tmp, { recursive: true, force: true });
        await git(['clone', '--bare', '--filter=blob:none', '--quiet', s.url, tmp], { env: s.env });
        log(`cloned ${owner}/${repo} via ${s.name}`);
      });
      fs.renameSync(tmp, bare);
    }

    progress(`Fetching PR #${number}…`);
    const baseRef = base ? `refs/lesehilfe/base/${base}` : null;
    const refspecs = [`+refs/pull/${number}/head:${ref}`, ...(base ? [`+refs/heads/${base}:${baseRef}`] : [])];
    const env = await withStrategies(owner, repo, token, async (s) => {
      await git(['fetch', '--quiet', '--filter=blob:none', s.url, ...refspecs], { cwd: bare, env: s.env });
      return s.env;
    });
    const sha = await git(['rev-parse', ref], { cwd: bare });
    const baseSha = base ? await git(['merge-base', baseRef, sha], { cwd: bare }) : prState.get(worktree)?.baseSha ?? null;

    progress('Checking out PR code…');
    // Checkout may lazily fetch file contents from origin, so reuse the working credentials.
    if (fs.existsSync(path.join(worktree, '.git'))) {
      await git(['checkout', '--quiet', '--force', '--detach', sha], { cwd: worktree, env });
    } else {
      fs.rmSync(worktree, { recursive: true, force: true });
      await git(['worktree', 'prune'], { cwd: bare });
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      await git(['worktree', 'add', '--quiet', '--detach', worktree, sha], { cwd: bare, env });
    }
    fs.utimesSync(worktree, new Date(), new Date());
    prState.set(worktree, { bare, env, sha, baseSha });
    return { path: worktree, sha, baseSha };
  });
}
/** Removes PR worktrees that haven't been used for a while. */
export async function cleanupWorktrees() {
  const cutoff = Date.now() - WORKTREE_MAX_AGE_DAYS * 86400_000;
  if (!fs.existsSync(WORKTREES_DIR)) return;
  for (const owner of fs.readdirSync(WORKTREES_DIR)) {
    for (const repo of fs.readdirSync(path.join(WORKTREES_DIR, owner))) {
      const bare = path.join(REPOS_DIR, owner, `${repo}.git`);
      for (const pr of fs.readdirSync(path.join(WORKTREES_DIR, owner, repo))) {
        const dir = path.join(WORKTREES_DIR, owner, repo, pr);
        if (fs.statSync(dir).mtimeMs > cutoff) continue;
        try {
          await locked(`${owner}/${repo}`, () => git(['worktree', 'remove', '--force', dir], { cwd: bare }));
          log('removed stale worktree', dir);
        } catch (e) {
          log('could not remove worktree', dir, e.message);
        }
      }
    }
  }
}
