// pi's file tools accept any path. A PR is untrusted, so everything that reads files
// on its behalf is confined to the PR checkout (after resolving symlinks a PR could
// add, e.g. to ~/.ssh).
import fs from 'node:fs';
import path from 'node:path';

function realpathOrParent(target) {
  let current = target;
  const rest = [];
  while (!fs.existsSync(current)) {
    rest.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) return target;
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...rest);
}

/** Returns why `input` (tool arguments with path/glob/pattern) leaves `root`, or null. */
export function outsideCheckout(root, input = {}) {
  const realRoot = fs.realpathSync(root);
  const target = realpathOrParent(path.resolve(root, input.path || '.'));
  if (target !== realRoot && !target.startsWith(realRoot + path.sep)) return `path ${input.path}`;
  for (const glob of [input.glob, input.pattern]) {
    if (typeof glob === 'string' && (path.isAbsolute(glob) || glob.startsWith('~') || glob.split(/[\\/]/).includes('..'))) {
      return `pattern ${glob}`;
    }
  }
  return null;
}

