import { el, emit, prefs, setPrefs } from "./core.js";

export const notesEnabled = () => prefs("notesBeta", false) === true;

export function setNotesEnabled(enabled) {
  setPrefs("notesBeta", Boolean(enabled));
  emit("notes:enabled", Boolean(enabled));
}

export function notesSetting() {
  const input = el("input", { type: "checkbox", role: "switch", id: "notesBetaToggle", "aria-describedby": "notesBetaDescription" });
  input.checked = notesEnabled();
  input.onchange = () => setNotesEnabled(input.checked);
  return el("section", { class: "notes-setting" }, [
    el("label", { for: "notesBetaToggle", class: "notes-setting-heading" }, [el("strong", { text: "Notes" }), el("span", { class: "notes-beta", text: "BETA" }), input]),
    el("p", { id: "notesBetaDescription", text: "An optional notebook layout for PC and iPad. All Notes tools are also available from the Notes button on regular boards. This layout setting is saved on this device." }),
    el("p", { class: "hint", text: "Turn the layout off anytime. Audio, recognition, flashcards, and saved content remain available on your whiteboard." }),
  ]);
}
