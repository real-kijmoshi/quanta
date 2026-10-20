import { emit, prefs, setPrefs } from "./core.js";

// Notebook mode (beta): a GoodNotes-style layout with a page rail, a notebook
// ribbon and focus mode. Saved on this device; toggled in Settings.
export const notesEnabled = () => prefs("notesBeta", false) === true;

export function setNotesEnabled(enabled) {
  setPrefs("notesBeta", Boolean(enabled));
  emit("notes:enabled", Boolean(enabled));
}
