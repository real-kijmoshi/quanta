// Notebook layout belongs to the opened file, never a device-wide mode.
import { state } from "./doc.js";
export const notesEnabled = () => state.board?.settings?.notesNotebook === true;
