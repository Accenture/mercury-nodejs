import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// One front-end, two backends. The bundle is built once and deployed into the agent-question app's resources/public
// of each pack - this repo's (node) and the Python pack's (python), expected beside this repo under the same parent
// folder (…/mercury-nodejs and …/mercury-python); set MERCURY_PYTHON_REPO to point elsewhere. The hosts serve the
// folder's index.html at / and the hashed assets under /assets, from the backend's own origin.
const here = process.cwd();
const PYTHON_REPO = process.env.MERCURY_PYTHON_REPO ?? resolve(here, '../../../mercury-python');

export const TARGETS = {
  node: { name: 'node', folder: resolve(here, '../agent-question/resources/public') },
  python: { name: 'python', folder: resolve(PYTHON_REPO, 'extensions/agent-question/resources/public') }
};

/** The target named by the script's first argument ('node' when absent); throws when unknown or its app is absent. */
export function resolveTarget(argv) {
  const name = argv[2] ?? 'node';
  const target = TARGETS[name];
  if (!target) throw new Error(`Unknown deploy target '${name}' - use 'node' (the default) or 'python'`);
  const app = resolve(target.folder, '..');
  if (!existsSync(app)) {
    const hint = name === 'python'
      ? '\nThe Python pack is expected at ../../../mercury-python relative to this folder; set MERCURY_PYTHON_REPO to override.'
      : '';
    throw new Error(`The agent-question app of target '${name}' was not found: ${app}${hint}`);
  }
  return target;
}
