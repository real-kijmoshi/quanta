// Assemble the static website with the same pen geometry used by the board,
// plus the real app at app/ running as an in-browser demo (no server).
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { demoBoards } from './demo-boards.mjs';

const root = new URL('../', import.meta.url);
const output = new URL('dist/site/', root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('site/', root), output, { recursive: true });
// The app resolves ../../shared from app/src, which lands on the site's shared/.
await cp(new URL('shared/', root), new URL('shared/', output), { recursive: true });

const app = new URL('app/', output);
await cp(new URL('client/', root), app, { recursive: true, filter: (src) => !src.includes('/diagnostics') });
// Only the libraries the demo needs; handwriting recognition models stay out.
const vendor = {
  'katex/': 'node_modules/katex/dist/',
  'pdfjs/pdf.min.mjs': 'node_modules/pdfjs-dist/build/pdf.min.mjs',
  'pdfjs/pdf.worker.min.mjs': 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
};
for (const [to, from] of Object.entries(vendor)) {
  await cp(new URL(from, root), new URL(`vendor/${to}`, app), { recursive: true });
}
const html = await readFile(new URL('index.html', app), 'utf8');
await writeFile(new URL('index.html', app), html.replace('<head>', '<head>\n  <meta name="quanta-demo" content="1" />\n  <meta name="robots" content="noindex" />'));
await mkdir(new URL('demo/', app), { recursive: true });
await writeFile(new URL('demo/boards.json', app), JSON.stringify(demoBoards()));
console.log('Website built in dist/site (demo app in dist/site/app)');
