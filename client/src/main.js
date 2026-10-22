// Boot order: view and layers first, then chrome, then load the board.
import { demo, on, prefs, setPrefs, toast, setIdentity, el } from "./core.js";
import { api, createBoard, importBoard, loadWorkspace, openBoard, state } from "./doc.js";
import { fitRect, mountView, restoreView, shellRect } from "./view.js";
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
import { mountMobile } from "./mobile.js";
import { mountTheme } from "./theme.js";

// The website demo starts from showcase boards shipped next to the app. When
// a newer set ships (DEMO_VERSION in scripts/demo-boards.mjs), returning
// visitors get the boards they don't have yet; nothing of theirs is touched.
async function seedDemo() {
  const data = await fetch("demo/boards.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const boards = Array.isArray(data) ? data : data?.boards ?? [];
  const version = data?.version ?? 1;
  if (!boards.length || prefs("demo:seeded", 0) >= version) return null;
  const have = new Set(state.workspace.boards.map((b) => b.id));
  const now = Date.now();
  for (const board of [...boards].reverse()) {
    if (board.id && have.has(board.id)) continue;
    // Comment times ship as "minutes ago", so the threads read as recent.
    for (const obj of Object.values(board.objects ?? {})) {
      for (const message of obj.props?.thread ?? []) if (message.at <= 0) message.at = now + message.at;
    }
    // Fixed ids keep the hub's portals pointing at the right boards.
    if (board.id) await createBoard(board.name, null, { id: board.id, kind: board.kind, objects: board.objects ?? {}, strokes: board.strokes ?? {}, deleted: {}, settings: board.settings ?? { background: "dots" } });
    else await importBoard(board.name, board);
  }
  setPrefs("demo:seeded", version);
  return boards[0];
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
  mountTheme();
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
  mountMobile();

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
  const seeded = demo ? await seedDemo() : null;
  const requested = new URL(location.href).searchParams.get("board");
  const known = state.workspace.boards.some((b) => b.id === requested);
  const last = prefs("lastBoard");
  const target = (known && requested) || (state.workspace.boards.some((b) => b.id === last) && last) || state.workspace.boards[0]?.id;
  await openBoard(target);
  restoreView(state.board.id);
  // A phone opens the demo on the hub's `focus` area (its welcome column)
  // rather than a postage stamp of the whole board.
  if (seeded?.focus && seeded.id === state.board.id && shellRect().width < 700) fitRect(seeded.focus, 12);
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
