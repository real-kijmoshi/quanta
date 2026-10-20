// Small per-board change journal; unlike full snapshots, writing this before
// transmission also survives reloads and switching boards during a failure.
import { prefs, storageKey } from './core.js';
const key = id => storageKey(`outbox:${id}`);
export const readOutbox = id => prefs(`outbox:${id}`, null);
export function queueChanges(id, ops) {
  const queued = readOutbox(id) ?? { objects: {}, strokes: {}, deleted: {} };
  for (const kind of ['objects', 'strokes', 'deleted']) Object.assign(queued[kind], ops[kind]);
  if (ops.settings) queued.settings = ops.settings;
  try { localStorage.setItem(key(id), JSON.stringify(queued)); return true; }
  catch { return false; }
}
export function acknowledgeChanges(id, sent) {
  const queued = readOutbox(id);
  if (!queued) return;
  for (const kind of ['objects', 'strokes', 'deleted']) {
    for (const [id, value] of Object.entries(sent[kind] ?? {})) {
      if (JSON.stringify(queued[kind][id]) === JSON.stringify(value)) delete queued[kind][id];
    }
  }
  if (sent.settings && JSON.stringify(queued.settings) === JSON.stringify(sent.settings)) delete queued.settings;
  try {
    if (!queued.settings && ['objects', 'strokes', 'deleted'].every(kind => !Object.keys(queued[kind]).length)) localStorage.removeItem(key(id));
    else localStorage.setItem(key(id), JSON.stringify(queued));
    return true;
  } catch { return false; }
}
