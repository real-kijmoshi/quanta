// Assemble the static website with the same pen geometry used by the board.
import { cp, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('dist/site/', root);
await mkdir(output, { recursive: true });
await cp(new URL('site/', root), output, { recursive: true });
await mkdir(new URL('shared/', output), { recursive: true });
await cp(new URL('shared/pen-path.js', root), new URL('shared/pen-path.js', output));
console.log('Website built in dist/site');
