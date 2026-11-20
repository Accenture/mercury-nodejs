import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTarget } from './targets.mjs';

// Removes exactly what deploy.mjs writes for the target: the bundle's assets, index.html and favicon.svg.
const target = resolveTarget(process.argv);
for (const entry of ['assets', 'index.html', 'favicon.svg']) {
  const path = resolve(target.folder, entry);
  console.log(`Cleaning (${target.name}): ${path}`);
  rmSync(path, { recursive: true, force: true });
}
