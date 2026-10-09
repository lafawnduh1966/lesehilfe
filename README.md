# Lesehilfe

A Chrome extension that helps you review GitHub pull requests: select code in a PR's diff, collect snippets across files, and have an AI agent explain them — with the PR's description as context and the full repository checked out locally so it can look up definitions, call sites, tests and docs.

The agent is [pi](https://pi.dev), running locally and paid for by **your ChatGPT Plus/Pro subscription** (no API key needed). It only gets read-only tools (`read`, `grep`, `find`, `ls`) on a local checkout of the PR.

## Install

Requirements: macOS or Linux, a Chromium browser (Chrome, Brave, Edge, Arc, Chromium, Vivaldi), **Node.js 20+**, **git**, and a ChatGPT Plus or Pro subscription.

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
  - `pi/` — ChatGPT sign-in and conversation history (separate from your own pi setup).
  - `helper.log`
- **Cloning** uses your GitHub sign-in from the extension, falling back to your git credentials or SSH. Your own clones are never touched.

### Safety

PR code is untrusted. The agent has no shell, can't write files, and has no network tools; the repository's own pi extensions, skills, prompts and settings are ignored (only `AGENTS.md`/`CLAUDE.md` are read as context). The worst a malicious PR can do is make the explanation wrong.

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
