import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function lockWorkspace(directory) {
  const path = join(directory, '.quanta.lock');
  const lease = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(lease); await handle.sync(); }
      finally { await handle.close(); }
      return async () => {
        try { if (await readFile(path, 'utf8') === lease) await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const contents = await readFile(path, 'utf8').catch(() => null);
      let pid;
      try { pid = JSON.parse(contents).pid; } catch {}
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Workspace lock is incomplete. Check for another Quanta process before removing .quanta.lock.');
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH' && await readFile(path, 'utf8').catch(() => null) === contents) {
          await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
          continue;
        }
        if (error.code !== 'EPERM') throw error;
      }
      throw new Error(`This workspace is already open in Quanta process ${pid}. Use the existing server.`);
    }
  }
  throw new Error('Could not acquire workspace lock');
}
