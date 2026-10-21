// File type travels with the document, including exports and browser recovery.
// Older notebooks used a settings flag; recognize them without rewriting content.
export const documentKind = (doc) => doc?.kind === "notebook" || doc?.settings?.notesNotebook === true ? "notebook" : "board";
export const isNotebook = (doc) => documentKind(doc) === "notebook";
