import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mdiAtom } from '@mdi/js';

// The brand mark is the Material Design "atom" icon the engine docs use as their logo (Pictogrammers, Apache-2.0),
// written as the favicon before the build so the bundle carries it.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#673ab7" d="${mdiAtom}"/></svg>\n`;
mkdirSync(resolve(process.cwd(), 'public'), { recursive: true });
writeFileSync(resolve(process.cwd(), 'public/favicon.svg'), svg);
console.log('public/favicon.svg written from @mdi/js mdiAtom');
