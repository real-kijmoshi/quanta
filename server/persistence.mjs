import { open, readFile, rename, copyFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Serialize writes per file, so an older async rename can never replace a
// newer revision. Each acknowledged write is synced before atomic replacement.
const writes = new Map();
export function writeJson(file, value, { backup = true } = {}) {
  const snapshot = JSON.stringify(value);
  const next = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const previous = `${temporary}.bak`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(snapshot, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      if (backup) {
        try { await copyFile(file, previous); await rename(previous, `${file}.bak`); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await rename(temporary, file);
    } finally {
      await Promise.allSettled([unlink(temporary), unlink(previous)]);
    }
  });
  writes.set(file, next);
  next.finally(() => { if (writes.get(file) === next) writes.delete(file); }).catch(() => {});
  return next;
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (primaryError) {
    try {
      const recovered = JSON.parse(await readFile(`${file}.bak`, "utf8"));
      // Preserve corrupt bytes for inspection; do not rotate them over backup.
      if (primaryError.code !== "ENOENT") await copyFile(file, `${file}.corrupt-${Date.now()}`);
      await writeJson(file, recovered, { backup: false });
      console.warn(`Recovered JSON from backup: ${file}`);
      return recovered;
    } catch (backupError) {
      if (primaryError.code === "ENOENT" && backupError.code === "ENOENT") return fallback;
      throw new Error(`Unable to load data file: ${file}`, { cause: primaryError });
    }
  }
}

export async function drainWrites() {
  while (writes.size) await Promise.all([...writes.values()]);
}
