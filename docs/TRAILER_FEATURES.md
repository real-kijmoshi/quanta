# Trailer feature checks

Source reviewed: `quanta-ad.mp4`, 32 seconds, dated 21 October 2026.
The opening three-board paywall belongs to the comparison sequence, not Quanta.
The scene headings and transition animations are video captions rather than app controls.

| Trailer scene | Working app behavior | Verification |
| --- | --- | --- |
| 7–11 s: sketch by hand; pause to straighten | Pressure ink, a ramp triangle, rotated rectangular block, force arrows and math labels. Hold for 500 ms to straighten a stroke. | `test:trailer` checks the actual geometry and hold timer at multiple zooms; `test:performance` checks input and painting. |
| 11–15 s: maths that solves itself | `θ = 30°`, `m = 2`, `F = m g sin(θ)`, `a = F / m` evaluate and typeset. The results are 9.80665 and 4.903325 (9.807 and 4.903 rounded as in the video). Unmarked trig arguments remain radians. | `test:trailer` runs the exact calculation and degree conversions. |
| 15–19 s: drag a slider | `y = A sin(k x)` with `A = 1.2` and `k = 2` gives two sliders. Changing `k` to 3.2 or 1.3 redraws the curve. | `test:trailer` verifies both parameters and distinct SVG curves; browser checks exercise the range controls. |
| 19–23 s: Python and JavaScript | Code cards run real code, preserve its output, and plot finite numeric vectors as a small inline graph. NumPy output from the trailer produces `[0, 0.61, 2.45, 5.52, 9.81]`. Explicit matplotlib figures take precedence over the preview. | `test:trailer` executes Python and the JS worker, checks graphs and invalid data, and exercises scientific-package fallback. |
| 23–26 s: study live with friends | Live named cursors, in-progress ink, committed ink, comment pins, on-board reply previews and threaded replies. | `test:collaboration` covers presence and connection isolation; `test:folders` covers actual API/SSE access and shared edits; two-browser checks cover visible ink and replies. |
| 26–28 s: no board limits | No artificial three-board quota. | `test:trailer` creates more than three boards in an isolated workspace. |
| 26–28 s: open source, MIT | The project retains its MIT license. | `LICENSE`. |
| 26–28 s: self-hosted in one command | The `quanta` CLI starts the local server and workspace. Installation is documented in the README. | `test:cli` checks real CLI startup, status, configuration and shutdown. |
| 26–28 s: plain JSON files | Documents and their object, ink, comment and output data persist in JSON under the data directory. | `test:storage` checks writes, recovery, backups and restart reconciliation. |
| 26–28 s: AI + MCP edits the board | Existing provider tool loops and MCP tools read and edit actual board objects. | `test:ai` checks six provider loops, tool validation and HTTP/MCP initialization with test providers; live external AI use still requires the chosen provider to be available/configured. |
| 26–28 s: offline edits merge on reconnect | Per-board cached edits/outboxes survive disconnection and merge with online changes. | `test:recovery`, `test:storage`, and two-browser disconnect/reconnect checks. |

## Copy the trailer examples

Math card:

```text
θ = 30°
m = 2
F = m g sin(θ)
a = F / m
```

Plot card:

```text
y = A sin(k x)
A = 1.2
k = 2
```

Python card:

```python
import numpy as np
t = np.linspace(0, 2, 5)
x = 0.5 * 4.903 * t**2
x.round(2)
```

Python uses the local interpreter when available. If a supported scientific
package is missing locally, Quanta uses Pyodide instead. The first browser run
loads Python and the imported packages automatically and needs network access;
later runs reuse the worker. There is no pip step in the board workflow.

Numeric previews are bounded to 256 samples and do not change the returned
text or the original values. Non-numeric, nested, or non-finite results stay as
text. Explicit figures render normally instead of adding a duplicate preview.
