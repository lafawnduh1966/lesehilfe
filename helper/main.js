#!/usr/bin/env node
// Lesehilfe native messaging host. Chrome starts this when the side panel connects
// and stops it when the panel closes.
//
// Requests:  { id, method, params }
// Responses: { id, result } | { id, error }
// Events:    { id, event, data }   (progress for a pending request)
import { log, onMessage, send } from './native.js';
import fs from 'node:fs';
import { preparePR, cleanupWorktrees, gitVersion, worktreePath } from './repo.js';
import * as agent from './agent.js';

const VERSION = '0.2.0';

const methods = {
  async status() {
    return {
      version: VERSION,
      node: process.version,
      pi: agent.PI_VERSION,
      git: await gitVersion(),
      codex: agent.codexStatus(),
    };
  },

  codexLogin({ method = 'browser' }, emit) {
    return agent.codexLogin(method, (step) => emit('codexLogin', step));
  },
  codexLoginCancel: () => agent.codexLoginCancel(),
  codexLogout: () => agent.codexLogout(),

  async prepare(params, emit) {
    return preparePR(params, (message) => emit('progress', { message }));
  },

  // Past conversation for a PR, without cloning anything if it was never prepared.
  async history({ owner, repo, number, model }) {
    const path = worktreePath(owner, repo, number);
    return fs.existsSync(path) ? agent.history(path, model || agent.DEFAULT_MODEL) : [];
  },

  async ask(params, emit) {
    const { path, sha } = await preparePR(params, (message) => emit('progress', { message }));
    emit('progress', { message: null });
    await agent.ask(path, params.model || agent.DEFAULT_MODEL, params.message, (data) => emit('agent', data), {
      fresh: params.fresh,
    });
    return { sha };
  },

  async abort({ owner, repo, number }) {
    await agent.abort(worktreePath(owner, repo, number));
  },
};

onMessage(async ({ id, method, params = {} }) => {
  const emit = (event, data) => send({ id, event, data });
  try {
    if (!methods[method]) throw new Error(`Unknown method ${method}`);
    const result = await methods[method](params, emit);
    send({ id, result: result ?? null });
  } catch (e) {
    log(`${method} failed`, e);
    send({ id, error: e.message });
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));

log(`helper ${VERSION} started (node ${process.version})`);
cleanupWorktrees().catch((e) => log('cleanup failed', e));
