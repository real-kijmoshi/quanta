import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { writeJson, readJson, drainWrites } from '../server/persistence.mjs';
import { validateOps } from '../server/validation.mjs';
import { createBackup, verifyBackup } from '../scripts/backup.mjs';
import { lockWorkspace } from '../server/workspace-lock.mjs';

const work = await mkdtemp(join(tmpdir(), 'quanta-storage-test-'));
process.env.QUANTA_DATA = join(work, 'data');
const store = await import('../server/store.mjs');
try {
  const file = join(work, 'serial.json');
  await Promise.all(Array.from({ length: 40 }, (_, revision) => writeJson(file, { revision })));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 39, 'serialized writes retain the newest revision');
  await writeFile(file, '{corrupt');
  assert.equal((await readJson(file)).revision, 38, 'corruption recovers the last valid backup');
  assert.ok((await readdir(work)).some(name => name.includes('.corrupt-')), 'corrupt bytes are preserved');
  const broken = join(work, 'broken.json');
  await writeFile(broken, '{bad');
  await assert.rejects(readJson(broken), /Unable to load/, 'unrecoverable data is never silently replaced');
  assert.equal(await readFile(broken, 'utf8'), '{bad');

  await store.init();
  await assert.rejects(lockWorkspace(join(work, 'data')), /already open/, 'a second process cannot open the same workspace');
  const board = await store.createBoard({ name: 'Durability and recovery' });
  const entity = i => ({ id: `n_${i}`, type: 'note', x: i, y: 0, w: 100, h: 80, text: String(i), updatedAt: Date.now() + i });
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.applyOps(board.id, { objects: { [`n_${i}`]: entity(i) } })));
  const boardFile = join(work, 'data', 'boards', `${board.id}.json`);
  const disk = JSON.parse(await readFile(boardFile, 'utf8'));
  assert.equal(Object.keys(disk.objects).length, 30, 'acknowledged concurrent writes already exist on disk');
  assert.equal(disk.rev, 31);
  assert.equal(Object.keys((await store.getBoard(board.id)).objects).length, 30);

  // Force the backup rotation to fail: failed mutations must not enter cache.
  await rm(`${boardFile}.bak`);
  await mkdir(`${boardFile}.bak`);
  await assert.rejects(store.applyOps(board.id, { objects: { n_fail: { ...entity(31), id: 'n_fail' } } }));
  assert.equal((await store.getBoard(board.id)).objects.n_fail, undefined, 'failed writes are not published in memory');
  await rm(`${boardFile}.bak`, { recursive: true });

  await store.deleteBoard(board.id);
  assert.ok((await store.deletedBoards()).some(b => b.id === board.id));
  assert.equal(await store.getBoard(board.id), null, 'deleted boards cannot resurrect from a backup');
  assert.ok(!(await store.listWorkspace()).boards.some(b => b.id === board.id));
  const recovered = await store.restoreBoard(board.id);
  assert.equal(Object.keys(recovered.objects).length, 30);
  assert.ok(!(await store.deletedBoards()).some(b => b.id === board.id));
  await assert.rejects(store.restoreBoard(board.id), error => error.status === 409);
  assert.throws(() => validateOps(JSON.parse('{"objects":{"__proto__":{}}}')), error => error.status === 400);
  assert.throws(() => validateOps({ objects: { wrong: entity(1) } }), /map key/);
  assert.throws(() => validateOps({ strokes: { s: { id: 's', updatedAt: 1, size: 1, points: [[Infinity, 0]] } } }), /finite/);

  await store.close();
  const indexFile = join(work, 'data', 'index.json');
  await writeFile(indexFile, JSON.stringify({ folders: [], boards: [] }));
  await store.init();
  assert.ok((await store.listWorkspace()).boards.some(b => b.id === board.id), 'startup reconciles orphaned board files into the index');
  await store.close();
  const backup = join(work, 'snapshot');
  await writeFile(join(work, 'data', '.quanta.lock'), 'nonportable test lease');
  const manifest = await createBackup(join(work, 'data'), backup);
  assert.ok(!manifest.files.some(file => file.path.endsWith('.quanta.lock')), 'backups exclude process ownership leases');
  assert.ok(manifest.files.some(file => file.path.includes(`${board.id}.json`)));
  await verifyBackup(backup);
  await writeFile(join(backup, manifest.files[0].path), 'tampered');
  await assert.rejects(verifyBackup(backup), /checksum mismatch/, 'backup verification detects damaged or changed files');
  console.log('PASS: ordered durable writes, corruption recovery, failed-write rollback, 30 concurrent edits, recoverable deletion, input validation, and startup reconciliation');
} finally {
  await store.close();
  await drainWrites();
  const target = resolve(work);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('quanta-storage-test-'));
  await rm(target, { recursive: true, force: true });
}
