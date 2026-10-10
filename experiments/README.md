# Experiments

## tour-overlay.js — hand-drawn tour on the GitHub page

A hard-coded tour stop for `InverterNetwork/emusd-monorepo#102` (`IssuerCoordinator._settle`,
leveraged mint): sticky margin notes, sketchy circles/underlines/boxes/brackets, curved arrows,
a spotlight on the stop, a staged draw-on animation and a remote control bar.

Try it: open the PR in single-file mode on that file and paste the script into the DevTools console:

    https://github.com/InverterNetwork/emusd-monorepo/pull/102/changes?mode=single#diff-0134ce90acde16a972de3d11694f24d62fa4a1e0d7515bb8b5a6a7a5544dfe14

Findings so far:
- GitHub's new diff view virtualizes large PRs (only files near the viewport exist in the DOM;
  anchor and file-tree jumps are imprecise). `?mode=single#diff-0134ce90acde16a972de3d11694f24d62fa4a1e0d7515bb8b5a6a7a5544dfe14<sha256(path)>` renders exactly
  one file and is a reliable way for a tour to move between files.
- Narrowing the diff column (padding on the PageLayout content) creates a margin for notes.
- Connectors never cross code: they run from the note through a lane beside the code column
  into the empty tail of their line (measured from text nodes; GitHub wraps lines in inline
  elements spanning the full column). No room → only the numbered badge links note and code.
  Connectors of finished beats fade; hovering a note shows its connector again.
