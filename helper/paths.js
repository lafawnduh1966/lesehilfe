import os from 'node:os';
import path from 'node:path';

export const LESEHILFE_DIR = process.env.LESEHILFE_HOME || path.join(os.homedir(), '.lesehilfe');
export const REPOS_DIR = path.join(LESEHILFE_DIR, 'repos');
export const WORKTREES_DIR = path.join(LESEHILFE_DIR, 'worktrees');
export const OVERVIEWS_DIR = path.join(LESEHILFE_DIR, 'overviews'); // user-flow overviews per PR
export const PI_DIR = path.join(LESEHILFE_DIR, 'pi'); // pi's agentDir: auth.json, sessions/
