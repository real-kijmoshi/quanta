# Changelog

## 0.12.0

- Checked the actual trailer examples and added `npm run test:trailer`. Maths now accepts degree notation such as `θ = 30°`, including correct trigonometric evaluation and typesetting.
- Numeric Python/NumPy and JavaScript results now keep their text and show an inline graph. Local Python missing a supported scientific package automatically uses the browser runtime.
- Comment pins show their latest reply directly on the board. Draw-and-hold snaps after 500 ms, handles wobbly lines and rotated rectangles more reliably, and uses consistent recognition thresholds across zoom levels.
- Added Paper, Studio and System themes, including dark cards, notes and plots.
- Notebooks are now a separate file type in the workspace, created through **+ New → Notebook** or directly inside a folder. Opening a notebook selects its page editor; regular boards no longer inherit a global Notes setting. Existing notebook files remain compatible.
- Added a shared **Write** desk for boards and notebooks: saved pens, pen stabilization, ruled/grid guides with adjustable spacing, writing zoom, left-margin and next-line controls, optional ink-follow panning, stylus-only input, shape hold, and focus mode.
- Notebook identity survives workspace listing, export/import, duplication, browser recovery, moves and trash restoration.

## 0.11.1

- Sharing over a tunnel works in one step: Share → Create invite link builds the link on the public tunnel address (not localhost), copies it, and opens the board directly for your guest. By default only that board is shared (it moves into its own subfolder); tick off "Only this board" to share the whole folder.
- The private "by invitation" page tells guests how to get an invite link, and the dashboard no longer copies the bare tunnel address on start.
- Auto-update: `quanta` installs a newer release before starting (checked at most every 6 hours, skipped while a workspace is running so nobody is disconnected). Turn it off with `quanta config autoupdate off` or in the dashboard settings.
- Website: large social preview image, clearer "open-source whiteboard" headline, canonical address, structured data, robots.txt and sitemap.

## 0.11.0

- Terminal dashboard: plain `quanta` opens an interactive screen with live status, uptime and connections, local/network/public links, one-key copy, mode switching (←→ restarts in local, share or tunnel), a live log, settings, backup, doctor and one-key updates. `quanta ui` opens it without starting; scripts and pipes keep the plain output.
- Portals land where you choose: after picking the destination, click a spot on a map of that board (the dashed frame is what you will see on arrival). Portals can also lead elsewhere on the same board.
- Windows: a see-through portal that shows a live view of where it leads; switch any portal between Ring and Window, and zoom the view with −/+.
- Customisable toolbar: show, hide and reorder tools in Settings (drag or arrows, or right-click the toolbar). Hidden tools live in a "More" menu and keep their shortcuts; Portal and Window start there.
- Pen options follow the toolbar: a vertical panel beside a left or right dock, and a new Top dock. Side docks go icon-only on short screens so every tool fits.
- Notebook mode (beta) is back as a Settings switch: the GoodNotes-style layout with page thumbnails, notebook ribbon and focus mode.
- Network links list your Wi-Fi address before virtual and link-local adapters.

## 0.10.1

- New `quanta update` command: checks GitHub for a newer release, installs it with the verified installer (or npm, depending on how Quanta was installed), keeps your boards, and restarts a running background workspace. `quanta update --check` only reports.

## 0.10.0

- `quanta` now starts in the background and opens your browser; `--tunnel` adds a public link and downloads cloudflared when missing. New `stop`, `restart`, `status`, `logs`, `open` and `config` commands (`quanta config mode tunnel` makes the tunnel the default).
- Ctrl+B board switcher: every board, most recent first, with a live preview.
- Portals: a card that teleports you to another board and lands you on the way back.
- One Settings dialog (Ctrl+,) replaces the workspace sheet; the pen and tools bar can dock on the left or right, with a compact mode. The separate Notes layout is retired.
- Faster, grouped command palette with shortcut hints.
- Templates are clean paper: ruled, graph, grid, dotted, Cornell, and a code scratchpad.
- Website: working copy buttons and an install tab picked for your device.

## 0.9.1

- Add an interactive server onboarding wizard and update team server setup instructions.
- Fix undo and redo history notification ordering.
- Fix a race when creating boards from the new-board modal and isolate its keyboard handling.
- Keep save and sync status visible on mobile.
- Polish plot, code and math cards.
- Redesign the website.

## 0.9.0

First public release (beta).

- Infinite whiteboard with handwriting, shape snapping, math, plot, and code cards.
- Notes beta: notebooks, PDF import, flashcards, audio notes.
- Folders, invitations, live collaboration, and optional hosted mode with accounts.
- AI assistant (Anthropic, OpenRouter, Ollama, Claude Code, Codex, compatible APIs) and MCP server.
- `quanta` command line, one-line installers for macOS, Linux, and Windows, and a Docker image.
