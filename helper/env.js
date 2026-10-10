// Environment for pi, set before any pi module loads (main.js imports this first).
//
// Chrome starts the helper without the user's shell environment, and macOS quarantines files
// that processes started by Chrome download. pi downloads ripgrep/fd itself when it can't find
// them; such a binary is then blocked by Gatekeeper ("rg" Not Opened) and the agent's search
// hangs. So: pi keeps its tools next to Lesehilfe's sign-in, the user's PATH is used (install.sh
// records it in the launcher), and pi never downloads anything from here — install.sh provides
// rg and fd from the terminal instead.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PI_DIR } from './paths.js';

process.env.PI_CODING_AGENT_DIR = PI_DIR;
process.env.PI_OFFLINE = '1';
const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(PI_DIR, 'bin')];
process.env.PATH = [...new Set([...(process.env.PATH || '').split(':'), ...extra])].filter(Boolean).join(':');

/** Where the agent's search tools come from, or null if missing (then install.sh needs to run again). */
export function searchTools() {
  const find = (name) => {
    const local = path.join(PI_DIR, 'bin', name);
    if (fs.existsSync(local)) return local;
    return spawnSync(name, ['--version'], { stdio: 'ignore' }).error ? null : name;
  };
  return { rg: find('rg'), fd: find('fd') };
}
