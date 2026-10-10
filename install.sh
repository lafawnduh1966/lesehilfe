#!/bin/sh
# Installs the Lesehilfe helper and registers it with Chromium-based browsers
# (Chrome, Chromium, Brave, Edge, Arc) for the current user. macOS and Linux.
# Safe to re-run, e.g. after `git pull`.
set -eu

HOST_NAME="com.lesehilfe.helper"
EXTENSION_ID="cebgjlcdanegjlhpflmbgcjemfkadlfh" # pinned by "key" in extension/manifest.json
REPO_DIR=$(cd "$(dirname "$0")" && pwd)
LESEHILFE_DIR="${LESEHILFE_HOME:-$HOME/.lesehilfe}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# --- Requirements ----------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required."
NODE=$(command -v node 2>/dev/null) || fail "Node.js 22.19+ is required (https://nodejs.org)."
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' \
  || fail "Node.js 22.19+ is required, found $("$NODE" --version)."
# Chrome starts the helper without your shell's PATH, so the launcher uses node's
# absolute path (the PATH entry, e.g. /opt/homebrew/bin/node, survives upgrades).

# --- Helper dependencies -----------------------------------------------------------
say "Installing helper dependencies…"
(cd "$REPO_DIR/helper" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# --- Launcher ----------------------------------------------------------------------------
mkdir -p "$LESEHILFE_DIR/bin"
LAUNCHER="$LESEHILFE_DIR/bin/lesehilfe-helper"
# Chrome starts the helper without your shell's PATH; keep this one so it finds rg, fd and git.
cat > "$LAUNCHER" <<EOF
#!/bin/sh
export PATH="$PATH"
exec "$NODE" "$REPO_DIR/helper/main.js" "\$@"
EOF
chmod +x "$LAUNCHER"

# --- Search tools for the agent (ripgrep, fd) ------------------------------------------
# Fetched here, from the terminal: when the helper downloads them from inside Chrome, macOS
# quarantines them and blocks them ("rg" Not Opened).
if ! command -v rg >/dev/null 2>&1 || ! command -v fd >/dev/null 2>&1; then
  say "Getting ripgrep/fd for the agent's code search…"
  PI_CODING_AGENT_DIR="$LESEHILFE_DIR/pi" "$NODE" --input-type=module -e "
    const m = await import('$REPO_DIR/helper/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js');
    for (const tool of ['rg', 'fd']) await m.ensureTool(tool, (s) => console.log('  ' + s.message));
  " || say "  (could not fetch them; install with: brew install ripgrep fd)"
fi

# --- Native messaging registration --------------------------------------------------
case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support"
    BROWSERS="Google/Chrome|Google/Chrome Beta|Google/Chrome Canary|Chromium|BraveSoftware/Brave-Browser|Microsoft Edge|Arc/User Data|Vivaldi"
    ;;
  Linux)
    BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
    BROWSERS="google-chrome|google-chrome-beta|chromium|BraveSoftware/Brave-Browser|microsoft-edge|vivaldi"
    ;;
  *) fail "Unsupported OS: $(uname -s). Lesehilfe supports macOS and Linux." ;;
esac

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Lesehilfe helper",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
)

registered=""
OLD_IFS=$IFS
IFS='|'
for browser in $BROWSERS; do
  dir="$BASE/$browser"
  # Register for installed browsers, and always for Chrome.
  case "$browser" in google-chrome|Google/Chrome) ;; *) [ -d "$dir" ] || continue ;; esac
  mkdir -p "$dir/NativeMessagingHosts"
  printf '%s\n' "$MANIFEST" > "$dir/NativeMessagingHosts/$HOST_NAME.json"
  registered="$registered
  - $browser"
done
IFS=$OLD_IFS

say ""
say "Lesehilfe helper installed."
say "Registered for:$registered"
say ""
say "Next steps:"
say "  1. Open chrome://extensions, enable Developer mode, click 'Load unpacked'"
say "     and select: $REPO_DIR/extension"
say "     (already loaded? click the reload icon on Lesehilfe instead)"
say "  2. Open a GitHub pull request, click the Lesehilfe icon, and follow the setup steps in the side panel."
