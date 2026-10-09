import { helper } from './helper-client.js';
import { renderMarkdown } from './markdown.js';

const $ = (selector) => document.querySelector(selector);
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const REPO_URL = 'https://github.com/lafawnduh1966/lesehilfe';

let tab = null;
let pr = null;
let selection = [];
let snippets = [];
const prMeta = {}; // PR key → { loading } | { data } | { error }

// Conversation with the agent for the current PR.
let conversation = []; // { role: 'user'|'assistant', text, parts?: [{ type: 'tool'|'text', ... }] }
let asking = false;
let freshNext = false; // start a new agent session with the next question

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

function parsePR(url) {
  try {
    const m = new URL(url).pathname.match(PR_PATH);
    if (!m || new URL(url).hostname !== 'github.com') return null;
    return { owner: m[1], repo: m[2], number: Number(m[3]), key: `${m[1]}/${m[2]}#${m[3]}` };
  } catch {
    return null;
  }
}

function lineNumbers(lines) {
  const nums = lines.map((l) => l.new ?? l.old).filter((n) => n != null);
  const onlyOld = lines.every((l) => l.new == null);
  if (!nums.length) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return `L${min}${max > min ? `–${max}` : ''}${onlyOld ? ' (old)' : ''}`;
}

function changeSummary(lines) {
  const adds = lines.filter((l) => l.type === 'add').length;
  const dels = lines.filter((l) => l.type === 'del').length;
  return [adds && `+${adds}`, dels && `−${dels}`].filter(Boolean).join(' ');
}

function codeBlock(lines) {
  return el(
    'pre',
    { className: 'code' },
    ...lines.map((l) =>
      el(
        'div',
        { className: l.type },
        el('span', { className: 'num', textContent: l.new ?? l.old ?? '' }),
        el('span', { className: 'txt', textContent: `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}` })
      )
    )
  );
}

function snippetCard(snippet, { onRemove } = {}) {
  const first = snippet.lines.find((l) => l.new != null) || snippet.lines[0];
  const file = el('span', { className: 'file link', title: `${snippet.file} — click to jump`, textContent: snippet.file });
  file.addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, {
      type: 'reveal',
      file: snippet.file,
      line: first.new ?? first.old,
      side: first.new != null ? 'new' : 'old',
    }).catch(() => {});
  });

  const head = el(
    'div',
    { className: 'card-head' },
    file,
    el('span', { className: 'badge', textContent: `${lineNumbers(snippet.lines)} ${changeSummary(snippet.lines)}`.trim() })
  );
  if (onRemove) {
    const remove = el('button', { className: 'icon', type: 'button', title: 'Remove', textContent: '×' });
    remove.addEventListener('click', onRemove);
    head.append(remove);
  }
  return el('div', { className: 'card' }, head, codeBlock(snippet.lines));
}

// --- Rendering ---------------------------------------------------------------

function render() {
  $('#not-pr').hidden = Boolean(pr);
  $('#main').hidden = !pr;
  $('#pr-key').textContent = pr ? pr.key : '';
  renderPR();
  renderSelection();
  renderSnippets();
}

function renderPR() {
  const root = $('#pr');
  root.replaceChildren();
  if (!pr) return;
  const meta = prMeta[pr.key] || {};

  if (meta.loading) {
    root.append(el('p', { className: 'muted', textContent: 'Loading PR…' }));
  } else if (meta.error) {
    const fallbackTitle = tab?.title?.split(' · ')[0];
    root.append(
      fallbackTitle ? el('p', { className: 'pr-title', textContent: fallbackTitle }) : null,
      el('p', { className: 'error', textContent: meta.error })
    );
  } else if (meta.data) {
    const d = meta.data;
    root.append(
      el('p', { className: 'pr-title', textContent: d.title }),
      el('div', {
        className: 'pr-meta',
        textContent: `${d.author} · ${d.base} ← ${d.head} · ${d.changedFiles} files · +${d.additions} −${d.deletions} · ${d.state}`,
      }),
      el(
        'details',
        {},
        el('summary', { textContent: 'Description' }),
        el('div', { className: 'pr-body', textContent: d.body || '(no description)' })
      )
    );
  }
  renderPreview();
}

function renderSelection() {
  const root = $('#selection');
  root.replaceChildren();
  if (!selection.length) {
    root.append(el('p', { className: 'hint', textContent: 'Select code in the diff…' }));
    return;
  }
  for (const s of selection) root.append(snippetCard(s));
  const add = el('button', { type: 'button', textContent: '+ Add to snippets' });
  add.addEventListener('click', () => chrome.tabs.sendMessage(tab.id, { type: 'addSelection' }).catch(() => {}));
  root.append(add);
}

function renderSnippets() {
  const root = $('#snippets');
  root.replaceChildren();
  $('#snippet-count').textContent = snippets.length ? `(${snippets.length})` : '';
  $('#clear').hidden = !snippets.length;
  $('#copy').disabled = !snippets.length;
  renderAskControls();
  if (!snippets.length) {
    root.append(el('p', { className: 'hint', textContent: 'Nothing collected yet. Select code and click “+ Add”.' }));
  }
  for (const s of snippets) {
    root.append(snippetCard(s, { onRemove: () => saveSnippets(snippets.filter((x) => x.id !== s.id)) }));
  }
  renderPreview();
}

function renderPreview() {
  $('#preview').textContent = pr ? buildContext() : '';
}

// --- Context for the AI ------------------------------------------------------

function snippetBlock(s) {
  const body = s.lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`).join('\n');
  return `### ${s.file} (${lineNumbers(s.lines)})\n\n\`\`\`diff\n${body}\n\`\`\``;
}

function buildContext(list = snippets) {
  const d = prMeta[pr.key]?.data;
  const parts = [`# Pull request ${pr.key}${d ? `: ${d.title}` : ''}`];
  if (d) {
    parts.push(`Author: ${d.author} · ${d.base} ← ${d.head} · ${d.changedFiles} files changed (+${d.additions} −${d.deletions})`);
    parts.push(`## Description\n\n${d.body?.trim() || '(no description)'}`);
  }
  if (list.length) {
    parts.push('## Selected code');
    parts.push(...list.map(snippetBlock));
  }
  return parts.join('\n\n');
}

// --- Setup checklist ---------------------------------------------------------------

function renderSetup() {
  renderHelperSetup();
  renderCodexSetup();
  renderAskControls();
  chrome.storage.local.get('githubAuth').then(({ githubAuth }) => {
    const ready = helper.status && helper.status.codex?.signedIn && githubAuth;
    $('#setup-summary').textContent = ready ? 'Setup ✓' : 'Setup';
    if (ready && !$('#setup').dataset.touched) $('#setup').open = false;
  });
}

function renderHelperSetup() {
  const root = $('#setup-helper');
  root.replaceChildren();
  if (helper.status) {
    const s = helper.status;
    root.append(el('span', { className: 'ok', textContent: `✓ v${s.version} · pi ${s.pi}` }));
    if (!s.git) root.append(el('div', { className: 'error', textContent: 'git not found — install git and restart the browser.' }));
    return;
  }
  const retry = el('button', { className: 'link', type: 'button', textContent: 'Check again' });
  retry.addEventListener('click', () => helper.connect());
  if (helper.error === 'not-installed' || !helper.error) {
    root.append(
      el('div', { textContent: 'Not installed. In a terminal (needs Node.js 22.19+ and git):' }),
      el('pre', {
        className: 'install',
        textContent: `git clone ${REPO_URL}.git ~/lesehilfe\n~/lesehilfe/install.sh`,
      }),
      el('div', { className: 'muted', textContent: 'Then reload this extension from that folder (chrome://extensions).' }),
      retry
    );
  } else {
    root.append(el('div', { className: 'error', textContent: helper.error }), retry);
  }
}

let codexLogin = null; // { url } | { userCode, verificationUri } | { error } while signing in

function renderCodexSetup() {
  const root = $('#setup-codex');
  root.replaceChildren();
  if (!helper.status) {
    root.append(el('span', { className: 'muted', textContent: 'Needs the helper.' }));
    return;
  }
  if (helper.status.codex.signedIn) {
    const out = el('button', { className: 'link', type: 'button', textContent: 'Sign out' });
    out.addEventListener('click', async () => {
      helper.status.codex = await helper.call('codexLogout');
      renderSetup();
    });
    root.append(el('span', { className: 'ok grow', textContent: '✓ Signed in' }), out);
    return;
  }
  if (codexLogin?.url || codexLogin?.userCode) {
    const cancel = el('button', { className: 'link', type: 'button', textContent: 'Cancel' });
    cancel.addEventListener('click', () => helper.call('codexLoginCancel'));
    if (codexLogin.userCode) {
      const open = el('button', { type: 'button', textContent: 'Copy code & open OpenAI' });
      open.addEventListener('click', async () => {
        await navigator.clipboard.writeText(codexLogin.userCode);
        chrome.tabs.create({ url: codexLogin.verificationUri });
      });
      root.append(el('div', { className: 'device-code' }, el('div', { className: 'code', textContent: codexLogin.userCode }), open, cancel));
    } else {
      const reopen = el('button', { className: 'link', type: 'button', textContent: 'Open sign-in page again' });
      reopen.addEventListener('click', () => chrome.tabs.create({ url: codexLogin.url }));
      root.append(el('div', { textContent: 'Finish signing in in the opened tab…' }), reopen, document.createTextNode(' · '), cancel);
    }
    return;
  }
  const signIn = el('button', { type: 'button', textContent: 'Sign in with ChatGPT' });
  signIn.addEventListener('click', () => startCodexLogin('browser'));
  const device = el('button', { className: 'link', type: 'button', textContent: 'use a device code' });
  device.addEventListener('click', () => startCodexLogin('device_code'));
  root.append(signIn, el('span', { className: 'muted', textContent: ' or ' }), device);
  root.append(el('div', { className: 'muted small', textContent: 'Requires ChatGPT Plus or Pro. Usage counts against your plan.' }));
  if (codexLogin?.error) root.append(el('div', { className: 'error', textContent: codexLogin.error }));
}

async function startCodexLogin(method) {
  codexLogin = {};
  try {
    helper.status.codex = await helper.call('codexLogin', { method }, (event, data) => {
      if (event !== 'codexLogin') return;
      codexLogin = data;
      if (data.url) chrome.tabs.create({ url: data.url });
      renderCodexSetup();
    });
    codexLogin = null;
  } catch (e) {
    codexLogin = { error: /abort/i.test(e.message) ? null : e.message };
  }
  renderSetup();
}

// --- Asking the agent ----------------------------------------------------------------

async function sentSnippetIds() {
  const key = `sent:${pr.key}`;
  const { [key]: ids = [] } = await chrome.storage.local.get(key);
  return new Set(ids);
}

async function markSent(ids) {
  await chrome.storage.local.set({ [`sent:${pr.key}`]: ids });
}

function renderAskControls() {
  const question = $('#question').value.trim();
  const ready = helper.status?.codex?.signedIn;
  $('#explain').hidden = asking;
  $('#stop').hidden = !asking;
  $('#explain').disabled = !ready || (!question && !snippets.length);
  $('#explain').textContent = conversation.length ? 'Send' : 'Explain';
  $('#new-conversation').hidden = !conversation.length || asking;
  $('#ask-hint').textContent = !helper.status
    ? 'Install the helper (see Setup) to ask the AI.'
    : !ready
      ? 'Sign in with ChatGPT (see Setup) to ask the AI.'
      : !conversation.length && !snippets.length && !question
        ? 'Add snippets or type a question.'
        : '';
}

function renderConversation() {
  const root = $('#conversation');
  root.replaceChildren();
  for (const message of conversation) {
    if (message.role === 'user') {
      root.append(el('div', { className: 'msg user', textContent: message.label || message.text }));
      continue;
    }
    const node = el('div', { className: 'msg assistant' });
    for (const part of message.parts || [{ type: 'text', text: message.text }]) {
      if (part.type === 'tool') {
        node.append(el('div', { className: 'tool', textContent: `${part.name} ${part.detail}`.trim() }));
      } else if (part.text) {
        const md = el('div', { className: 'md' });
        md.innerHTML = renderMarkdown(part.text);
        node.append(md);
      }
    }
    root.append(node);
  }
  renderAskControls();
}

let renderQueued = false;
function scheduleConversationRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderConversation();
    $('#conversation').lastElementChild?.scrollIntoView({ block: 'end' });
  });
}

async function prParams() {
  const { model } = await chrome.storage.local.get('model');
  return { owner: pr.owner, repo: pr.repo, number: pr.number, model: model || helper.status?.codex.defaultModel };
}

async function ask() {
  const question = $('#question').value.trim();
  const fresh = freshNext || !conversation.length;
  const sent = fresh ? new Set() : await sentSnippetIds();
  const newSnippets = snippets.filter((s) => !sent.has(s.id));

  // First message carries the PR context; later ones only add new snippets.
  const parts = [];
  if (fresh) parts.push(buildContext(newSnippets));
  else if (newSnippets.length) parts.push(`## Additional selected code\n\n${newSnippets.map(snippetBlock).join('\n\n')}`);
  parts.push(`## Question\n\n${question || 'Explain what the selected code does and how it fits into this PR.'}`);
  const message = parts.join('\n\n');

  const label = [question || 'Explain the selected code', newSnippets.length ? `(+${newSnippets.length} snippet${newSnippets.length > 1 ? 's' : ''})` : '']
    .join(' ')
    .trim();
  if (fresh) conversation = [];
  conversation.push({ role: 'user', text: message, label });
  const answer = { role: 'assistant', parts: [] };
  conversation.push(answer);
  asking = true;
  $('#question').value = '';
  renderConversation();

  const status = $('#ask-status');
  const key = pr.key;
  try {
    await helper.call('ask', { ...(await prParams()), token: await getToken(), message, fresh }, (event, data) => {
      if (pr?.key !== key) return;
      if (event === 'progress') {
        status.hidden = !data.message;
        status.textContent = data.message || '';
      } else if (event === 'agent') {
        const last = answer.parts.at(-1);
        if (data.type === 'text') {
          if (last?.type === 'text') last.text += data.delta;
          else answer.parts.push({ type: 'text', text: data.delta });
        } else if (data.type === 'tool') {
          answer.parts.push({ type: 'tool', name: data.name, detail: data.detail });
        }
        status.hidden = true;
        scheduleConversationRender();
      }
    });
    freshNext = false;
    await markSent([...sent, ...newSnippets.map((s) => s.id)]);
  } catch (e) {
    answer.parts.push({ type: 'text', text: `**Error:** ${e.message}` });
  } finally {
    asking = false;
    status.hidden = true;
    if (pr?.key === key) renderConversation();
  }
}

async function loadConversation() {
  conversation = [];
  renderConversation();
  if (!helper.status || !pr) return;
  const key = pr.key;
  try {
    const messages = await helper.call('history', await prParams());
    if (pr?.key !== key) return;
    conversation = messages.map((m) =>
      m.role === 'user' ? { role: 'user', text: m.text, label: m.text.match(/## Question\s+([\s\S]*)$/)?.[1]?.trim() || m.text } : m
    );
    renderConversation();
  } catch (e) {
    console.warn('history failed', e);
  }
}

// --- Data ----------------------------------------------------------------------

async function loadPRMeta(p) {
  if (prMeta[p.key]?.data || prMeta[p.key]?.loading) return;
  prMeta[p.key] = { loading: true };
  renderPR();

  const token = await getToken();
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`https://api.github.com/repos/${p.owner}/${p.repo}/pulls/${p.number}`, { headers });
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? token
            ? `PR not accessible — is the Lesehilfe GitHub App installed on ${p.owner}?`
            : 'PR not found — private repo? Sign in with GitHub above.'
          : res.status === 403 || res.status === 429 ? 'GitHub API rate limit hit — sign in with GitHub above.'
          : res.status === 401 ? 'GitHub sign-in expired — sign in again.'
          : `GitHub API error ${res.status}`
      );
    }
    const d = await res.json();
    prMeta[p.key] = {
      data: {
        title: d.title,
        body: d.body || '',
        author: d.user?.login,
        base: d.base?.ref,
        head: d.head?.ref,
        additions: d.additions,
        deletions: d.deletions,
        changedFiles: d.changed_files,
        state: d.merged_at ? 'merged' : d.state,
      },
    };
  } catch (e) {
    prMeta[p.key] = { error: e.message };
  }
  if (pr?.key === p.key) renderPR();
}

async function loadSnippets() {
  const key = `snippets:${pr.key}`;
  const { [key]: stored = [] } = await chrome.storage.local.get(key);
  snippets = stored;
  renderSnippets();
}

function saveSnippets(next) {
  return chrome.storage.local.set({ [`snippets:${pr.key}`]: next });
}

async function refresh() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pr = tab?.url ? parsePR(tab.url) : null;
  selection = [];
  snippets = [];
  render();
  if (!pr) return;

  loadPRMeta(pr);
  loadSnippets();
  loadConversation();
  chrome.tabs
    .sendMessage(tab.id, { type: 'getSelection' })
    .then((res) => {
      selection = res?.snippets || [];
      renderSelection();
    })
    .catch(() => {}); // Content script not injected (tab opened before install) — reload the page.
}

// --- GitHub sign-in (device flow, via the "Inverter Lesehilfe" GitHub App) ---------

const GITHUB_CLIENT_ID = 'Iv23li3EYK3hBVmooozl';
let deviceFlow = null; // { userCode, verificationUri, cancelled } while signing in

async function getToken() {
  const { githubAuth, githubToken } = await chrome.storage.local.get(['githubAuth', 'githubToken']);
  return githubAuth?.token || githubToken || null;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  return res.json();
}

async function signIn() {
  let flow;
  try {
    const code = await postForm('https://github.com/login/device/code', { client_id: GITHUB_CLIENT_ID });
    if (code.error) throw new Error(code.error_description || code.error);
    flow = deviceFlow = { userCode: code.user_code, verificationUri: code.verification_uri, cancelled: false };
    renderAccount();

    let interval = code.interval * 1000;
    const deadline = Date.now() + code.expires_in * 1000;
    while (!flow.cancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (flow.cancelled) return;
      const res = await postForm('https://github.com/login/oauth/access_token', {
        client_id: GITHUB_CLIENT_ID,
        device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (res.access_token) {
        const user = await fetch('https://api.github.com/user', {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${res.access_token}` },
        }).then((r) => r.json());
        await chrome.storage.local.set({
          githubAuth: { token: res.access_token, login: user.login, avatar: user.avatar_url },
        });
        deviceFlow = null;
        onAuthChanged();
        return;
      }
      if (res.error === 'slow_down') interval += 5000;
      else if (res.error !== 'authorization_pending') throw new Error(res.error_description || res.error);
    }
    if (!flow.cancelled) throw new Error('Sign-in timed out.');
  } catch (e) {
    if (deviceFlow === flow) deviceFlow = { error: e.message };
    renderAccount();
  }
}

async function signOut() {
  await chrome.storage.local.remove('githubAuth');
  onAuthChanged();
}

function onAuthChanged() {
  for (const key of Object.keys(prMeta)) delete prMeta[key];
  renderAccount();
  renderSetup();
  if (pr) loadPRMeta(pr);
}

async function renderAccount() {
  const root = $('#account');
  root.replaceChildren();
  const { githubAuth } = await chrome.storage.local.get('githubAuth');

  if (githubAuth) {
    const out = el('button', { className: 'link', type: 'button', textContent: 'Sign out' });
    out.addEventListener('click', signOut);
    root.append(
      el('img', { src: githubAuth.avatar, alt: '' }),
      el('span', { className: 'grow', textContent: `@${githubAuth.login}` }),
      out
    );
    return;
  }

  if (deviceFlow?.userCode) {
    const open = el('button', { type: 'button', className: 'primary', textContent: 'Copy code & open GitHub' });
    open.addEventListener('click', async () => {
      await navigator.clipboard.writeText(deviceFlow.userCode);
      chrome.tabs.create({ url: deviceFlow.verificationUri });
    });
    const cancel = el('button', { className: 'link', type: 'button', textContent: 'Cancel' });
    cancel.addEventListener('click', () => {
      deviceFlow.cancelled = true;
      deviceFlow = null;
      renderAccount();
    });
    root.append(
      el(
        'div',
        { className: 'device-code' },
        el('div', { className: 'muted', textContent: 'Enter this code on GitHub:' }),
        el('div', { className: 'code', textContent: deviceFlow.userCode }),
        open,
        el('div', { className: 'row' }, el('span', { className: 'muted', textContent: 'Waiting for approval…' }), cancel)
      )
    );
    return;
  }

  const button = el('button', { type: 'button', textContent: 'Sign in with GitHub' });
  button.addEventListener('click', signIn);
  root.append(button);
  if (deviceFlow?.error) root.append(el('span', { className: 'error', textContent: deviceFlow.error }));
}

// --- Events ----------------------------------------------------------------------

chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === tab?.id && (change.url || change.status === 'complete')) refresh();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'selection' || sender.tab?.id !== tab?.id) return;
  selection = message.snippets || [];
  renderSelection();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !pr) return;
  const change = changes[`snippets:${pr.key}`];
  if (change) {
    snippets = change.newValue || [];
    renderSnippets();
  }
});

$('#clear').addEventListener('click', () => saveSnippets([]));

$('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(buildContext());
  $('#copy').textContent = 'Copied ✓';
  setTimeout(() => ($('#copy').textContent = 'Copy context for AI'), 1200);
});

$('#save-token').addEventListener('click', async () => {
  const value = $('#token').value.trim();
  await chrome.storage.local.set({ githubToken: value });
  $('#token').value = '';
  $('#token').placeholder = value ? 'Token saved' : 'ghp_… or github_pat_…';
  onAuthChanged();
});

chrome.storage.local.get('githubToken').then(({ githubToken }) => {
  if (githubToken) $('#token').placeholder = 'Token saved';
});

$('#explain').addEventListener('click', ask);
$('#stop').addEventListener('click', async () => helper.call('abort', await prParams()).catch(() => {}));
$('#question').addEventListener('input', renderAskControls);
$('#question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !$('#explain').disabled && !asking) ask();
});
$('#new-conversation').addEventListener('click', () => {
  freshNext = true;
  conversation = [];
  renderConversation();
});
$('#setup').addEventListener('toggle', () => ($('#setup').dataset.touched = '1'));

$('#model').addEventListener('change', () => chrome.storage.local.set({ model: $('#model').value }));

async function renderModelSelect() {
  const models = helper.status?.codex.models || [];
  const { model } = await chrome.storage.local.get('model');
  const current = model || helper.status?.codex.defaultModel;
  $('#model').replaceChildren(...models.map((m) => el('option', { value: m, textContent: m, selected: m === current })));
  $('#model').disabled = !models.length;
}

helper.onChange(() => {
  renderSetup();
  renderModelSelect();
  if (pr) loadConversation();
});

renderAccount();
renderSetup();
refresh();
helper.connect();
