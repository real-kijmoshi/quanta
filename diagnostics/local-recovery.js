import { cacheBoard, readCachedBoard } from '../src/local-cache.js';
import { queueChanges, readOutbox, acknowledgeChanges } from '../src/outbox.js';
const output = document.querySelector('#result');
document.querySelector('#run').onclick = async () => {
  const id = `diagnostic_${crypto.randomUUID()}`;
  const lines = [];
  const check = (condition, label) => { if (!condition) throw Error(label); lines.push(`PASS ${label}`); output.textContent = lines.join('\n'); };
  try {
    const fixture = { id, objects: {}, strokes: {}, text: 'Local recovery roundtrip' };
    check(await cacheBoard(fixture), 'Browser snapshot write');
    check((await readCachedBoard(id))?.text === fixture.text, 'Browser snapshot read');
    check(!localStorage.getItem(`quanta:cache:board:${id}`), 'IndexedDB used without localStorage snapshot fallback');
    const ops = { objects: { test: { id: 'test', updatedAt: 1 } }, strokes: {}, deleted: {} };
    check(queueChanges(id, ops) && readOutbox(id)?.objects.test.updatedAt === 1, 'Pending edit journal');
    acknowledgeChanges(id, ops);
    check(readOutbox(id) === null, 'Acknowledged journal cleared');
    const pdf = await import('/vendor/pdfjs/pdf.min.mjs?v=20261015');
    pdf.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs?v=20261015';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
    let source = '%PDF-1.4\n', offsets = [0];
    objects.forEach((body, index) => { offsets.push(source.length); source += `${index + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = source.length;
    source += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const task = pdf.getDocument({ data: new TextEncoder().encode(source) });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    check(doc.numPages === 1, 'PDF worker parses and renders a page');
    await task.destroy();
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open('quanta-local', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const transaction = database.transaction('boards', 'readwrite'); transaction.objectStore('boards').delete(id); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    database.close();
    lines.push('Complete — diagnostic fixture removed.');
  } catch (error) { lines.push(`FAIL ${error.message}`); }
  output.textContent = lines.join('\n');
};
