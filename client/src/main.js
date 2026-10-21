// Boot order: view and layers first, then chrome, then load the board.
import { demo, on, prefs, toast, setIdentity, el } from "./core.js";
import { api, importBoard, loadWorkspace, openBoard, state } from "./doc.js";
import { mountView, restoreView } from "./view.js";
import { mountInk } from "./ink.js";
import { mountObjects } from "./objects.js";
import { mountCanvas, setMode } from "./canvas.js";
import { mountUi } from "./ui.js";
import { mountPresent } from "./present.js";
import { mountAgent } from "./agent.js";
import { ensureKatex } from "./rich.js";
import { mountWorkspace } from "./workspace.js";
import { mountFolders } from "./folders.js";
import { ensureAccount, mountAccount, showNoFolders } from "./account.js";
import { mountNotes } from "./notes.js";
import { mountSettings } from "./settings.js";
import { mountSwitcher } from "./switcher.js";
import { mountToolbar } from "./toolbar.js";

// The website demo starts from showcase boards shipped next to the app.
async function seedDemo() {
  const boards = await fetch("demo/boards.json").then((r) => (r.ok ? r.json() : [])).catch(() => []);
  for (const board of [...boards].reverse()) await importBoard(board.name, board);
}

async function boot() {
  const params = new URLSearchParams(location.hash.slice(1));
  const invitation = params.get("invite");
  const ownerLink = params.get("owner");
  const hosted = await ensureAccount(invitation);
  if (ownerLink && !hosted) {
    history.replaceState({}, "", location.pathname + location.search);
    await api("/api/access", { method: "POST", body: { owner: ownerLink } });
  } else if (invitation && !hosted) {
    history.replaceState({}, "", location.pathname + location.search);
    await api("/api/access", { method: "POST", body: { token: invitation } });
  }
  mountView();
  mountInk();
  mountObjects();
  mountCanvas();
  mountUi();
  mountToolbar();
  mountWorkspace();
  mountFolders();
  mountAccount();
  mountNotes();
  mountSettings();
  mountSwitcher();
  mountPresent();

  on("board:opened", (doc) => {
    const url = new URL(location.href);
    url.searchParams.set("board", doc.id);
    history.replaceState({}, "", url);
  });

  // Provider discovery must not hold up the canvas or first board request.
  const agentReady = mountAgent().catch((error) => console.warn("Assistant unavailable", error));
  await loadWorkspace();
  if (hosted && !state.workspace.access.owner && !state.workspace.access.folderIds.length) {
    showNoFolders();
    return;
  }
  if (state.workspace.access?.name) setIdentity({ name: state.workspace.access.name });
  if (demo && !state.workspace.boards.length) await seedDemo();
  const requested = new URL(location.href).searchParams.get("board");
  const known = state.workspace.boards.some((b) => b.id === requested);
  const last = prefs("lastBoard");
  const target = (known && requested) || (state.workspace.boards.some((b) => b.id === last) && last) || state.workspace.boards[0]?.id;
  await openBoard(target);
  restoreView(state.board.id);
  setMode("select");

  if (demo) {
    toast("You're trying Quanta in your browser. Boards stay on this device; install it for files, sharing, and AI");
  } else if (state.serverless) {
    toast("Local-only mode: run `quanta` in a terminal for board files, Python, and sharing", "warn");
  }
  // Warm up KaTeX so typeset math is ready by the time you look at it.
  ensureKatex();
  await agentReady;
  if (new URL(location.href).searchParams.has("measure")) {
    (await import("../diagnostics/live-app-profile.js")).mountMeasurement();
  }
}

boot().catch((error) => {
  document.body.classList.remove("booting");
  console.error(error);
  if (error.status === 401) { location.reload(); return; }
  if (error.status === 403) {
    document.querySelector("#app").hidden = true;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    document.body.append(el("section", { class: "access-screen" }, [
      el("span", { class: "brand-mark", text: "q" }),
      el("h1", { text: "A space by invitation" }),
      el("p", { text: "This Quanta is private. Ask the person who sent you this address for an invite link: in Quanta they open the board and choose Share → Create invite link. If you used an invite link, it may have been revoked." }),
      local ? el("button", { class: "solid-btn", text: "Return to my workspace", onclick: async () => { await api("/api/access", { method: "DELETE" }); location.reload(); } }) : null,
    ]));
    return;
  }
  const message = document.createElement("pre");
  message.className = "boot-error";
  message.textContent = `Quanta failed to start: ${error.message}`;
  document.body.prepend(message);
});
