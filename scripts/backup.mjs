import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join, relative, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.quanta.lock') continue; // A process lease is not portable data.
    if (entry.isSymbolicLink()) throw new Error('Backup does not follow symbolic links');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile() && !entry.name.endsWith('.tmp')) result.push(path);
  }
  return result;
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyBackup(directory) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid backup manifest');
  for (const entry of manifest.files) {
    const path = resolve(root, entry.path);
    if (!path.startsWith(root + sep)) throw new Error('Invalid backup path');
    const bytes = await readFile(path);
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Backup checksum mismatch: ${entry.path}`);
  }
  return manifest;
}

export async function createBackup(source, destination) {
  const root = resolve(source), target = resolve(destination);
  if (target === root || target.startsWith(root + sep) || root.startsWith(target + sep)) throw new Error('Backup destination must be separate from the data directory');
  try { await stat(target); throw new Error('Backup destination already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = await files(root);
  await mkdir(target, { recursive: true });
  const manifest = { format: 1, createdAt: new Date().toISOString(), files: [] };
  for (const path of entries) {
    const bytes = await readFile(path);
    if (path.endsWith('.json')) JSON.parse(bytes.toString('utf8'));
    const destination = join(target, 'data', relative(root, path));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o600 });
    manifest.files.push({ path: relative(target, destination).split(sep).join('/'), bytes: bytes.length, sha256: hash(bytes) });
  }
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await verifyBackup(target);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, path] = process.argv.slice(2);
  try {
    if (action === '--verify') {
      if (!path) throw new Error('Usage: npm run backup:verify -- <backup-directory>');
      const manifest = await verifyBackup(path);
      console.log(`Verified ${manifest.files.length} files`);
    } else {
      const destination = action ?? join('backups', new Date().toISOString().replace(/[:.]/g, '-'));
      const manifest = await createBackup(process.env.QUANTA_DATA ?? 'data', destination);
      console.log(`Saved and verified ${manifest.files.length} files in ${resolve(destination)}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
