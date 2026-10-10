# Lesehilfe

A Chrome extension that helps you review GitHub pull requests: select code in a PR's diff, collect snippets across files, and have an AI agent explain them — with the PR's description as context and the full repository checked out locally so it can look up definitions, call sites, tests and docs.

The agent is [pi](https://pi.dev), running locally with GPT-6.1 Sol (selectable) and paid for by **your ChatGPT Plus/Pro subscription** (no API key needed). It only gets read-only tools (`read`, `grep`, `find`, `ls`) on a local checkout of the PR.

## Install

Requirements: macOS or Linux, a Chromium browser (Chrome, Brave, Edge, Arc, Chromium, Vivaldi), **Node.js 22.19+**, **git**, and a ChatGPT Plus or Pro subscription.

```sh
git clone https://github.com/lafawnduh1966/lesehilfe.git ~/lesehilfe
~/lesehilfe/install.sh
```

Then load the extension:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `~/lesehilfe/extension`.
3. Pin the Lesehilfe icon, open a pull request on GitHub, click the icon.
4. Follow the **Setup** checklist in the side panel:
   - **Helper** — should show ✓ after `install.sh`.
   - **GitHub** — sign in (needed for private repos). The "Inverter Lesehilfe" GitHub App must be installed on the org.
   - **ChatGPT** — sign in with your ChatGPT account.

### Update

```sh
cd ~/lesehilfe && git pull && ./install.sh
```

Then click the reload icon on Lesehilfe in `chrome://extensions`.

## Use

**Familiarize** (Overview section): Lesehilfe studies the PR — its description, changed docs, journey/e2e tests and entry points — and maps the **user flows** it introduces or changes, grouped by actor (users, operators, admins, system). Each flow lists its steps through the code with file and line references; click one to jump to it in the diff (or on GitHub). Takes a few minutes for large PRs; the result is saved per PR and also given to the agent as context for your questions.

**Take the tour** (on any flow): step through the flow one stop at a time. The diff scrolls to and highlights each stop's lines; the panel shows the explanation and a code excerpt with the PR's changed lines marked (also for code outside the diff). Per stop:
- **Go deeper** — the agent splits the stop into sub-stops that follow the code further in (cached; the breadcrumb takes you back up, and *Continue* on the last sub-stop moves on in the flow).
- **What changed here?** — the PR's diff for those lines.

Use ← / → to move between stops.

Then, for detail:

1. On a PR's **Files changed** tab, select code and click **+ Add to Lesehilfe** (or **+ Add to snippets** in the panel). Collect as many snippets as you like, across files.
2. Click **Explain**, or type a question first. Follow-up questions keep the conversation going; **New conversation** starts fresh.
3. Click a snippet's file name to jump back to it in the diff.

The first question in a repo clones it (a few seconds). Conversations are saved per PR and come back when you reopen the panel.

## How it works

```
Side panel ──native messaging──▶ helper (Node, ~/lesehilfe/helper)
                                   ├─ git: partial clone + worktree per PR
                                   └─ pi SDK: read-only agent session per PR
```

- **Extension** (`extension/`): content script maps diff selections to `{file, old/new line numbers, +/-}`; side panel shows PR context (GitHub API), snippets, and the conversation.
- **Helper** (`helper/`): started by the browser when the panel opens ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)), stops when it closes. No open network ports.
- **Local data** in `~/.lesehilfe/`:
  - `repos/<owner>/<repo>.git` — partial bare clones (file contents only for checked-out commits; typically tens of MB). Dependencies are never installed.
  - `worktrees/<owner>/<repo>/pr-<n>` — the PR's code, removed after 14 days unused.
  - `overviews/<owner>/<repo>/pr-<n>.json` — user-flow overviews from Familiarize (`.tours.json`: sub-stops from *Go deeper*).
  - `pi/` — ChatGPT sign-in and conversation history (separate from your own pi setup).
  - `helper.log`
- **The PR's diff** is computed locally against the merge base with the PR's base commit (so it stays correct after merging) (GitHub's API refuses diffs over 20,000 lines); the agent reads it through two read-only tools, `pr_changed_files` and `pr_diff`.
- **Cloning** uses your GitHub sign-in from the extension, falling back to your git credentials or SSH. Your own clones are never touched.

### Safety

PR code is untrusted. The agent has no shell, can't write files, and has no network tools. Every tool call is confined to the PR checkout — paths outside it (including through symlinks a PR might add) are blocked, so files like `~/.ssh` or your credentials can't end up in the conversation. The repository's own pi extensions, skills, prompts and settings are ignored (only `AGENTS.md`/`CLAUDE.md` are read as context). The worst a malicious PR can do is make the explanation wrong.

## Uninstall

```sh
rm -rf ~/.lesehilfe
rm -f ~/Library/Application\ Support/*/NativeMessagingHosts/com.lesehilfe.helper.json \
      ~/Library/Application\ Support/*/*/NativeMessagingHosts/com.lesehilfe.helper.json  # macOS
rm -f ~/.config/*/NativeMessagingHosts/com.lesehilfe.helper.json \
      ~/.config/*/*/NativeMessagingHosts/com.lesehilfe.helper.json                        # Linux
```

and remove the extension in `chrome://extensions`.

## Repository layout

| Path | |
|---|---|
| `extension/` | Chrome extension (Manifest V3). The `key` in `manifest.json` pins the extension ID to `cebgjlcdanegjlhpflmbgcjemfkadlfh`. |
| `helper/` | Native messaging host: `main.js` (protocol), `repo.js` (git), `agent.js` (pi). |
| `install.sh` | Installs helper dependencies and registers the native messaging host. |
| `prototypes/macos-selection-mirror/` | First prototype: a floating macOS window mirroring the selected text in any app (Swift, `swift run`). |
