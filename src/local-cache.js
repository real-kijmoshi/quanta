// IndexedDB avoids serializing the entire board into localStorage on the UI
// thread. Legacy snapshots remain readable, including private-mode fallback.
import { storageKey } from './core.js';
let database;
function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(globalThis.quantaAccountId ? `quanta-local-${globalThis.quantaAccountId}` : 'quanta-local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('boards');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

export async function readCachedBoard(id) {
  try {
    const db = await openDatabase();
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction('boards').objectStore('boards').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (value) return value;
  } catch { /* legacy/private-mode fallback */ }
  try { return JSON.parse(localStorage.getItem(storageKey(`cache:board:${id}`)) ?? 'null'); }
  catch { return null; }
}

export async function cacheBoard(doc) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('boards', 'readwrite');
      transaction.objectStore('boards').put(doc, doc.id);
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    return true;
  } catch {
    try { localStorage.setItem(storageKey(`cache:board:${doc.id}`), JSON.stringify(doc)); return true; }
    catch { return false; }
  }
}
