import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTarget } from './targets.mjs';

// Copy the built bundle - index.html, favicon.svg and the hashed assets - into the target backend's
// resources/public, replacing the previous bundle's assets so stale hashes do not pile up. Nothing else in the
// folder is touched.
const target = resolveTarget(process.argv);
const src = resolve(process.cwd(), 'dist');
if (!existsSync(resolve(src, 'index.html'))) {
  throw new Error(`No build output at ${src} - run 'npm run build' first (or 'npm run release')`);
}
mkdirSync(target.folder, { recursive: true });
rmSync(resolve(target.folder, 'assets'), { recursive: true, force: true });
for (const entry of readdirSync(src)) {
  cpSync(resolve(src, entry), resolve(target.folder, entry), { recursive: true });
}
console.log(`Deployed (${target.name}): ${src} → ${target.folder} (${readdirSync(resolve(target.folder, 'assets')).length} assets)`);
