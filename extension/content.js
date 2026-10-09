// Runs on github.com. Maps text selections in PR diffs to structured snippets
// (file, old/new line numbers, added/removed/context) and stores them per PR.
(() => {
  const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

  function currentPR() {
    const m = location.pathname.match(PR_PATH);
    return m ? { owner: m[1], repo: m[2], number: Number(m[3]), key: `${m[1]}/${m[2]}#${m[3]}` } : null;
  }

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  // --- Diff views ------------------------------------------------------------
  // GitHub serves two PR diff UIs: the new React view (/pull/N/changes) and the
  // classic one (/pull/N/files, e.g. when logged out). Each adapter maps a row to
  // { type: 'add'|'del'|'ctx', old, new, text } for one side ('left'/'right').

  const lineType = (el, add, del) => (el.classList.contains(add) ? 'add' : el.classList.contains(del) ? 'del' : 'ctx');

  const VIEWS = [
    {
      files: 'table[aria-label^="Diff for"]',
      filePath: (table) => table.getAttribute('aria-label').replace(/^Diff for:\s*/, ''),
      rows: 'tr.diff-line-row',
      sideOf: (el) => el.closest('td.diff-text-cell')?.dataset.diffSide,
      line(row, side) {
        const cells = [...row.querySelectorAll('td.diff-text-cell')];
        const cell = cells.find((c) => c.dataset.diffSide === side) || cells[0];
        const code = cell?.querySelector('code');
        if (!code) return null;
        const type = lineType(code, 'addition', 'deletion');
        let text = code.textContent;
        if (type !== 'ctx' && /^[+-]/.test(text)) text = text.slice(1);
        // Key looks like "b:130-l:129-r:130": l = old line, r = new line.
        const key = cell.dataset.diffLineKey || '';
        const oldLine = key.match(/l:(\d+)/);
        const newLine = key.match(/r:(\d+)/);
        return {
          type,
          old: type === 'add' || !oldLine ? null : Number(oldLine[1]),
          new: type === 'del' || !newLine ? null : Number(newLine[1]),
          text,
        };
      },
    },
    {
      files: '.file[data-tagsearch-path]',
      filePath: (file) => file.dataset.tagsearchPath,
      rows: 'tr',
      sideOf: (el) => el.closest('td.blob-code')?.dataset.splitSide,
      line(row, side) {
        const cells = [...row.querySelectorAll('td.blob-code')];
        const cell = cells.find((c) => c.dataset.splitSide === side) || cells[0];
        const inner = cell?.querySelector('.blob-code-inner');
        if (!inner || cell.classList.contains('blob-code-empty') || cell.classList.contains('blob-code-hunk')) return null;
        const type = lineType(cell, 'blob-code-addition', 'blob-code-deletion');
        // Unified and split both have two number cells per row: old, then new.
        const [oldNum, newNum] = [...row.querySelectorAll('td.blob-num')].map((td) => Number(td.dataset.lineNumber) || null);
        return { type, old: type === 'add' ? null : oldNum, new: type === 'del' ? null : newNum, text: inner.textContent };
      },
    },
  ];

  const allFiles = () =>
    VIEWS.flatMap((view) => [...document.querySelectorAll(view.files)].map((el) => ({ view, el })));

  // --- Selection → snippets -------------------------------------------------

  function snippetsFromSelection() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
    const range = selection.getRangeAt(0);
    const anchor = selection.anchorNode;
    const anchorEl = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;

    return allFiles()
      .filter(({ el }) => range.intersectsNode(el))
      .map(({ view, el }) => {
        // In split view, stick to the side (old/new) where the selection started.
        const side = anchorEl && view.sideOf(anchorEl);
        const lines = [...el.querySelectorAll(view.rows)]
          .filter((row) => range.intersectsNode(row))
          .map((row) => view.line(row, side))
          .filter(Boolean);
        return lines.length ? { file: view.filePath(el), lines } : null;
      })
      .filter(Boolean);
  }

  async function addSnippets(pr, snippets) {
    if (!pr || !snippets.length) return;
    const key = `snippets:${pr.key}`;
    const { [key]: existing = [] } = await chrome.storage.local.get(key);
    const now = Date.now();
    const added = snippets.map((s, i) => ({ ...s, id: `${now}-${i}`, addedAt: now }));
    await chrome.storage.local.set({ [key]: [...existing, ...added] });
  }

  // --- Floating "+ Add" button ---------------------------------------------

  const button = document.createElement('button');
  button.className = 'lesehilfe-add';
  button.type = 'button';
  button.textContent = '+ Add to Lesehilfe';
  button.hidden = true;
  // Keep the page selection intact when clicking the button.
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', async () => {
    if (!extensionAlive()) return;
    await addSnippets(currentPR(), lastSnippets);
    button.textContent = 'Added ✓';
    setTimeout(() => {
      button.hidden = true;
      button.textContent = '+ Add to Lesehilfe';
    }, 700);
  });
  document.documentElement.appendChild(button);

  function updateButton() {
    if (!lastSnippets.length) {
      button.hidden = true;
      return;
    }
    const rect = getSelection().getRangeAt(0).getBoundingClientRect();
    button.style.top = `${rect.bottom + window.scrollY + 6}px`;
    button.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
    button.hidden = false;
  }

  // --- Wiring -----------------------------------------------------------------

  let lastSnippets = [];
  let debounce;

  function notifyPanel() {
    if (!extensionAlive()) return;
    chrome.runtime
      .sendMessage({ type: 'selection', pr: currentPR(), snippets: lastSnippets })
      .catch(() => {}); // No side panel open.
  }

  document.addEventListener('selectionchange', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      lastSnippets = currentPR() ? snippetsFromSelection() : [];
      updateButton();
      notifyPanel();
    }, 150);
  });

  function reveal({ file, line, side }) {
    const match = allFiles().find(({ view, el }) => view.filePath(el) === file);
    if (!match) return false;
    const { view, el } = match;
    const key = side === 'old' ? 'old' : 'new';
    const row = [...el.querySelectorAll(view.rows)].find((r) =>
      ['right', 'left'].some((s) => view.line(r, s)?.[key] === line)
    );
    const target = row || el;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('lesehilfe-flash');
    setTimeout(() => target.classList.remove('lesehilfe-flash'), 1200);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'getSelection') {
      sendResponse({ pr: currentPR(), snippets: lastSnippets });
    } else if (message.type === 'addSelection') {
      addSnippets(currentPR(), lastSnippets).then(() => sendResponse({ ok: true }));
      return true;
    } else if (message.type === 'reveal') {
      sendResponse({ ok: reveal(message) });
    }
  });
})();
