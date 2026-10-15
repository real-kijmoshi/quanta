// Boot order: view and layers first, then chrome, then load the board.
import { on, prefs, toast } from "./core.js";
import { loadWorkspace, openBoard, state } from "./doc.js";
import { mountView, restoreView } from "./view.js";
import { mountInk } from "./ink.js";
import { mountObjects } from "./objects.js";
import { mountCanvas, setMode } from "./canvas.js";
import { mountUi } from "./ui.js";
import { mountPresent } from "./present.js";
import { mountAgent } from "./agent.js";
import { ensureKatex } from "./rich.js";

async function boot() {
  mountView();
  mountInk();
  mountObjects();
  mountCanvas();
  mountUi();
  mountPresent();

  on("board:opened", (doc) => {
    const url = new URL(location.href);
    url.searchParams.set("board", doc.id);
    history.replaceState({}, "", url);
  });

  await mountAgent();
  await loadWorkspace();
  const requested = new URL(location.href).searchParams.get("board");
  const known = state.workspace.boards.some((b) => b.id === requested);
  const target = (known && requested) || prefs("lastBoard") || state.workspace.boards[0]?.id;
  await openBoard(target);
  restoreView(state.board.id);
  setMode("select");

  if (state.serverless) {
    toast("Local-only mode: run `npm start` for board files, Python, and sharing", "warn");
  }
  // Warm up KaTeX so typeset math is ready by the time you look at it.
  ensureKatex();
  if (new URL(location.href).searchParams.has("measure")) {
    (await import("../diagnostics/live-app-profile.js")).mountMeasurement();
  }
}

boot().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<pre style="padding:20px;font:13px ui-monospace;color:#b4231f">Quanta failed to start: ${error.message}</pre>`,
  );
});
