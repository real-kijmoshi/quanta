# Notebook files and writing tools

Choose **+ New → Notebook** in the sidebar, **New notebook file** in Commands,
or **New notebook in this folder** from a folder's menu. Notebooks are separate
files alongside boards: their title, folder, pages, paper, ink, attachments and
history save together. Opening a board restores the board interface; opening a
notebook restores its page interface. The old device-wide Notes beta switch is
no longer used. Existing notebooks created with that switch retain their type
and content. Ordinary boards keep their content without being converted.

## Writing on any board

Open **Write** on any board or notebook for saved pens, ruled/grid guides,
adjustable line spacing, **Stabilize** (Off, Light, Strong), **Stylus only**,
and **Shape hold**. Stabilization reduces small hand movements while preserving
pressure and affects only new strokes. Turn Stylus only on to pan with fingers.

**Writing zoom** enlarges the writing area and restores your previous camera
when turned off. **Next line** (Alt+Enter) returns to the left margin and moves
down by the selected spacing in board units. In notebooks, reaching the bottom
continues onto the next page or adds a new page. **Set margin** starts a line
at your current view. The line origin resets when you open another file.
**Follow ink** optionally pans when a finished stroke reaches the right edge.
**Focus** hides distractions; toggle it again or close the desk to return.
On phones, controls scroll horizontally and the page rail starts collapsed.
**More** opens recognition, audio, study and favorite-pen tools on any canvas.

## Available workflows

- **Library:** find notebook files or create a notebook in a folder.
- **Stationery:** blank, ruled, grid, dots, graph, Cornell, and music paper;
  A4, US Letter, and square pages in portrait or landscape. Page size and
  orientation settings apply to newly created pages.
- **Page navigation:** thumbnails with ink and typed notes, previous/next
  buttons, Page Up/Page Down, page titles, and bookmarks. The page list displays
  up to 100 matches; search or page navigation reaches the remaining pages.
- **Page editing:** rename, change paper, duplicate, move earlier/later, or
  delete. Content and handwriting move with a page; each action is one undo
  step. Duplication remaps connectors between copied cards. Audio recordings
  stay on the original page.
- **Writing:** the existing pressure pen, fountain pen, brush, highlighter,
  stroke/precise erasers, lasso, shape snapping, typed text, images, math,
  undo/redo, and collaboration. Save up to five favorite pen combinations.
- **PDFs:** import up to 200 pages, annotate them, and search extracted PDF text.
  Search also matches page titles and typed cards. Ctrl/Command+F focuses the
  notebook search. PDFs imported before this feature need reimporting to gain
  searchable text.
- **Audio:** microphone recording with page/time bookmarks, playback, and
  deletion with undo. Browser-supported formats are negotiated, including MP4
  for Safari and WebM for Chromium. Clips stop after 30 minutes or approximately
  30 MB. The microphone requires browser permission and HTTPS or localhost;
  ordinary HTTP over a LAN is insufficient. Recording never starts automatically.
  If its starting page is no longer available, the clip downloads instead.
- **Study sets:** create question/answer flashcards on a page, reveal answers,
  and review due cards or practice all cards. Again schedules one minute,
  Hard grows the interval slowly, and Got it grows it by 2.5×. Schedules stay
  on this device; cards use the notebook's usual save and sync path. To edit a
  card, edit its text: the first line is the question, remaining lines the answer.
- **Export:** browser printing / Save as PDF, plus an editable JSON backup that
  embeds attached images and audio. Import that backup through Export or the
  existing board import action. PDF printing fits each page onto an A4 sheet.
- **PC and iPad layouts:** scrollable notebook controls, collapsible page list,
  tablet sidebar overlay, touch-sized controls on touch devices, and Focus mode.
  Stylus pressure/palm rejection and finger pan/pinch use the existing input
  engine. Turn off Finger draws when using a stylus.

## Current limits

This is a Goodnotes-inspired browser beta, not full Goodnotes feature parity.
It does not implement handwriting OCR or conversion, handwriting spellcheck,
scanned-document OCR, audio transcription, time-synchronized ink replay,
native Apple Pencil gestures, native iCloud integration, or Goodnotes file
import. The existing assistant remains available through the Assistant panel;
Notes does not add or configure an AI recognition service.

Use normal, non-overlapping page layouts for page management. Cards belong to
a page by their center; handwriting that intersects a page is included in that
page's duplicate/delete operation. Ink spanning two pages can therefore be
affected by either page's operation. Shared edits retain the existing
per-object conflict handling; concurrent moves of the same page are not locked.

Notebook content and attachments use existing storage, recovery, invitations,
and sync. Audio and portable backups can be large. Offline audio above 4 MB
downloads instead of being embedded in the recovery document. Browser storage
alone is not a replacement for an exported backup or the server's backup tools.

## Validation

`npm run test:notes` checks page ownership, duplication, connector remapping,
movement across different page sizes, grouped deletion, text/PDF search,
flashcard scheduling and editing, negotiated recording formats, recording
cleanup and board-switch fallback, audio asset types, and notebook metadata
persistence. It uses a simulated microphone and an isolated temporary store.
The complete regression suite is `npm test`.

Browser QA covers opt-in settings, notebook creation, Cornell and dotted paper,
page renaming/reordering/duplication, flashcard review, text search, and tablet
viewport layouts. Actual Apple Pencil hardware behavior and real microphone
capture on an iPad require device testing.
