# Quanta

A local whiteboard and notebook for maths, physics, and code. Boards are plain JSON files in `data/`; one Node process owns the workspace. See [local release and recovery](docs/LOCAL_RELEASE.md) for backup, restore, and operating limits.

## Run

```powershell
npm ci --ignore-scripts  # Node.js 22+
npm start          # just you:            http://localhost:4173
npm run share      # everyone on your LAN: prints http://<your-ip>:4173
```

Open the printed address in any modern browser (desktop, iPad, Android tablet). On first visit you pick a display name and colour.

## Handwriting

- **Pen** (`P`): smooth, even "Pen" line by default (like Miro), or **Fountain** (tapered, follows stylus pressure) and **Brush**. Mouse and touch jitter is filtered out; stylus pressure, coalesced and predicted pointer events are used when available.
- **Draw a shape and hold still** to snap it to a clean line, arrow, circle, ellipse, triangle, rectangle, or polygon.
- **Marker** (`M`): highlighter that multiplies under ink and text, like a real one.
- **Eraser** (`E`): whole-stroke or precise (cuts strokes). A stylus barrel button erases too.
- **Lasso** (`L`): circle ink *and* cards, then drag to move, drag the corner to scale, recolour, duplicate, or delete.
- **Palm rejection**: with a stylus, fingers pan and two fingers pinch-zoom. Turn on "Finger draws" for drawing with a finger.
- `[` / `]` change the size of the current tool.

## Notebooks and PDFs

- **Pages** (`Shift+G`): A4 pages with blank, ruled, grid, dots, or graph paper. Add pages from the Pages panel or the board menu.
- **Import PDF**: drop a PDF on the board (or use the menu). Each page becomes a locked page you can write on.
- **Print / save as PDF** (`Ctrl+P`): prints every page (or every frame) one per sheet, ink included.
- Board background: dots, grid, graph, lines, or blank (board menu).

## Maths, physics, and code

- **Notes and text** understand Markdown — headings, lists, `- [ ]` checkboxes you can tick, `code` — and LaTeX: `$e^{i\pi}+1=0$`, `$$\int_0^1 x^2\,dx$$`.
- **Math cards** (`F`) evaluate *and typeset* each line: variables, implicit multiplication (`2 pi r`), `f(x) = x^2` definitions, vectors (`[1,2,3]`, `cross`, `dot`, `norm`), `integrate(f, 0, 1)`, `deriv(f, 2)`, `solve(f, 1)`, and constants (`g`, `c`, `G`, `h`, `hbar`, `k_B`, `N_A`, `q_e`, `m_e`, …).
- **Plot cards** (`Y`): `f(x) = sin(a x)`, `y = x^2`, parametric `(cos(t), sin(2t))`, points `(1, 2)`, ranges `x: -5..5`. Number-only lines like `a = 2` get a slider.
- **Code cards** (`C`): JavaScript runs in a browser worker. Python runs on the host machine for the host, and in each guest's browser via Pyodide (numpy, sympy, matplotlib load on demand). The last expression's value is shown and matplotlib figures appear in the card. Syntax highlighting for both.
- **Connectors** (`A`): drag from one card to another; arrows stay attached as cards move.

## Working together

- Live sync of every card, stroke, and comment; collaborators' **cursors**, **ink while they write**, and **selections** ("Brewka is typing…") are shown in their colour.
- Click someone's avatar to **follow their view**.
- Undo only undoes *your* changes; concurrent edits merge per object (newest wins), deletes are kept as tombstones, and edits made offline sync when you reconnect.
- Comments (`K`), presentation mode from frames (`Shift+P`), folders, search, templates (Notebook, Math notebook, Physics problem, Coding session).

`npm run share` binds to all network interfaces, so anyone on your network can open and edit boards. LAN sharing has no user authentication or roles; use it only on a trusted network. Python execution on the host is limited to the host machine unless you set `QUANTA_REMOTE_RUN=1`.

## AI and agents

- **Assistant panel** (`Shift+A`): choose a provider and model, refresh available connections, and stop an in-progress reply. Provider/model choices are remembered in this browser. Every provider can read, add, update, and delete board cards using the same validated tools.
- **Ollama**: start Ollama and pull a model that supports tools. Refresh discovers installed models from `/api/tags`. Models run on your machine.
- **Claude Code / Codex terminal**: uses the installed CLI and its saved authentication. Run `claude auth login` or `codex login` first. Windows npm shims are resolved to their JavaScript entrypoints without a shell. Requests run in a temporary directory; Claude has built-in tools and inherited MCP servers disabled, while Codex uses a read-only sandbox and ignores user configuration. CLIs return structured board actions; Quanta validates and executes them. Installation is detected automatically; authentication is checked when you send a request. CLI inference may still use the provider's cloud service.
- **OpenRouter**: set `OPENROUTER_API_KEY` on the server and restart. Refresh lists models advertising tool support. You can also type a model ID directly.
- **Anthropic**: set `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` and restart. Enter any tool-capable model ID; `QUANTA_MODEL` controls the default.
- **Compatible API / LM Studio**: start LM Studio's local server, or configure `QUANTA_COMPATIBLE_URL` and optionally `QUANTA_COMPATIBLE_KEY` for another Chat Completions-compatible service. Refresh discovers `/models`.
- Local model servers and terminal providers are available only from localhost on the host machine. Cloud API providers can be used by LAN guests. Credentials stay in server environment variables and are never sent to the browser. Stop cancels the provider request; board edits already completed remain on the canvas.
- **MCP server** at `http://localhost:4173/mcp` (Streamable HTTP): list, read, create, and edit boards from any MCP client; changes appear live in open tabs.
- **WebMCP** registers 11 tools when the browser supports `document.modelContext` (with a legacy `navigator.modelContext` fallback): read/add/update/delete/search cards, read selection, run a specified code card, focus a card, fit the board, undo, and redo. Inputs are validated before changes, outputs are JSON strings, and registration success/failure appears in the Assistant panel. Card mutations use the document's undo and live-sync path. Unsupported browsers can use the HTTP MCP server; `window.Quanta` remains available for debugging. WebMCP is a board-control interface, not a web-search service.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4173` | HTTP port |
| `HOST` | `127.0.0.1` (`0.0.0.0` with `npm run share`) | Bind address |
| `QUANTA_DATA` | `./data` | Where boards and uploaded files are stored |
| `QUANTA_ALLOWED_HOSTS` | unset | Additional trusted Host header names, comma-separated |
| `QUANTA_REMOTE_RUN` | unset | `1` lets LAN guests run Python on the host |
| `QUANTA_RUN_TIMEOUT` | `20000` | Host code-run timeout in ms |
| `QUANTA_MODEL` | first discovered | Default Anthropic model (manual ID if catalog unavailable) |
| `QUANTA_AI_PROVIDER` | first available | Preferred provider: `anthropic`, `ollama`, `claude-code`, `codex`, `openrouter`, `compatible` |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server URL, including protocol |
| `QUANTA_OLLAMA_MODEL` | first installed | Default Ollama model |
| `OPENROUTER_API_KEY` | unset | OpenRouter credential, server only |
| `QUANTA_OPENROUTER_MODEL` | `openrouter/auto` | Default OpenRouter model |
| `QUANTA_COMPATIBLE_URL` | `http://127.0.0.1:1234/v1` | Compatible API base URL |
| `QUANTA_COMPATIBLE_KEY` | unset | Optional compatible API credential |
| `QUANTA_COMPATIBLE_MODEL` | first discovered | Default compatible model |
| `QUANTA_CLAUDE_BIN` / `QUANTA_CODEX_BIN` | auto-detected from PATH | Optional absolute CLI executable or npm shim path |
| `QUANTA_CLAUDE_CODE_MODEL` / `QUANTA_CODEX_MODEL` | CLI default | Optional terminal model override |
| `QUANTA_AI_TIMEOUT` | `180000` | Provider/terminal timeout in milliseconds |

`npm test` runs syntax, rendering, storage, recovery, and mocked provider checks.
`npm run check` syntax-checks every source file.
`npm run test:performance` checks retained ink, pan cache invalidation, pointer coalescing, connector updates, and low-zoom pen rendering.
For a browser workload, open `http://127.0.0.1:4173/diagnostics/canvas-profile.html` and click **Run profile**. Keep that tab in the foreground until it finishes. It uses an in-memory 2,000-stroke board and reports pan frame intervals, CPU submission times, and stroke submissions without changing saved boards. Frame intervals depend on browser scheduling and other activity; CPU timings exclude deferred GPU rasterization.
The same page has **Run live ink at 5% zoom**, which exercises the actual live preview with coalesced samples. It reports raster surface size, cleared area, idle frame intervals, and input-to-next-frame intervals. Runs flagged with scheduling interruptions are unsuitable for latency comparisons.
`npm run test:ai` exercises mock provider tool loops, CLI subprocesses, cancellation, access controls, model discovery, and WebMCP input validation without paid inference calls or changes to your boards.
