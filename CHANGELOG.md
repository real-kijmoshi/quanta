# Changelog

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
