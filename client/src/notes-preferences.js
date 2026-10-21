import { state } from "./doc.js";
import { isNotebook } from "../../shared/document-kind.js";

// Opening a notebook file determines the editor. Never apply notebook chrome
// to unrelated boards through a device-wide preference.
export const notesEnabled = () => isNotebook(state.board);
