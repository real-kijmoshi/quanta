// Workspace chrome stays off the pointer hot path. Document summaries are
// coalesced; overview DOM is built only when its panel is visible.
import { $, $$, app, el, emit, identity, initials, on, prefs, setPrefs } from "./core.js";
import { objectList, state } from "./doc.js";
import { createObjectAt, select } from "./objects.js";
import { setMode } from "./canvas.js";
import { centerOn, fitBoard, screenToWorld, shellRect, view } from "./view.js";
import { runCommand, toggleFollow, togglePanel } from "./ui.js";
import { searchableObjectText } from "../../shared/content-search.js";

export function mountWorkspace() {
  $("#commandBtn").onclick = () => emit("palette:open");
  $("#mobileSidebarClose").onclick = $("#sidebarBackdrop").onclick = () => $("#sidebarToggle").click();
  $("#emptyTemplates").onclick = () => runCommand("new-board");
  $("#teamBtn").onclick = () => togglePanel("teamPanel");
  $("#overviewBtn").onclick = () => togglePanel("overviewPanel");
  $("#overviewFit").onclick = fitBoard;
  $("#teamInvite").onclick = () => runCommand("share");
  $("#overviewSearch").oninput = renderOverview;
  $("#favoriteBoardBtn").onclick = () => {
    if (!state.board) return;
    const ids = new Set(prefs("starredBoards", []));
    if (ids.has(state.board.id)) ids.delete(state.board.id);
    else ids.add(state.board.id);
    setPrefs("starredBoards", [...ids]);
    renderStar();
    emit("boards:starred");
  };
  $$("[data-board-filter]").forEach((button) => {
    button.onclick = () => {
      $$("[data-board-filter]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      $("#searchInput").value = "";
      emit("boards:filter", button.dataset.boardFilter);
    };
  });
  $("[data-quick-add]").onclick = (event) => {
    if (!state.board) return;
    const box = shellRect();
    const point = screenToWorld(box.left + box.width / 2, box.top + box.height / 2);
    setMode("select");
    createObjectAt(event.currentTarget.dataset.quickAdd, point);
  };
  // Keep canvas gestures from starting through the empty-state buttons.
  $("#emptyBoard").addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) event.stopPropagation();
  });

  let timer = null;
  on("doc:changed", () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; renderSummary(); }, 180);
  });
  on("board:opened", () => {
    $("#overviewSearch").value = "";
    renderStar();
    renderSummary();
  });
  on("workspace", () => { $("#workspaceBoardCount").textContent = state.workspace.boards.length; });
  on("peers", renderTeam);
  on("identity", renderTeam);
  on("follow", renderTeam);
  on("panel:open", (id) => {
    if (id === "teamPanel") renderTeam();
    if (id === "overviewPanel") { renderOverview(); $("#overviewSearch").focus(); }
  });
  for (const [buttonId, panelId] of [["boardLinksBtn", "linksPanel"], ["teamBtn", "teamPanel"], ["overviewBtn", "overviewPanel"], ["commentsBtn", "commentsPanel"], ["pagesBtn", "pagesPanel"], ["aiBtn", "aiPanel"]]) {
    const panel = $(`#${panelId}`);
    const button = $(`#${buttonId}`);
    button.setAttribute("aria-controls", panelId);
    button.setAttribute("aria-expanded", String(!panel.hidden));
    new MutationObserver(() => button.setAttribute("aria-expanded", String(!panel.hidden)))
      .observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  }
  renderTeam();
}

function renderStar() {
  const active = prefs("starredBoards", []).includes(state.board?.id);
  const button = $("#favoriteBoardBtn");
  button.textContent = active ? "★" : "☆";
  button.classList.toggle("starred", active);
  button.setAttribute("aria-pressed", String(active));
  button.setAttribute("aria-label", active ? "Unstar this board" : "Star this board");
  button.title = active ? "Unstar this board" : "Star this board";
}

function renderSummary() {
  const cards = Object.keys(state.board?.objects ?? {}).length;
  const strokes = Object.keys(state.board?.strokes ?? {}).length;
  $("#boardStats").textContent = `${cards.toLocaleString()} ${cards === 1 ? "card" : "cards"} · ${strokes.toLocaleString()} ${strokes === 1 ? "stroke" : "strokes"} · Infinite canvas`;
  $("#emptyBoard").hidden = !state.board || cards > 0 || strokes > 0;
  if (!$("#overviewPanel").hidden) renderOverview();
}

function renderTeam() {
  const peers = [...app.peers.values()];
  $("#teamBtn").hidden = !peers.length;
  $("#teamCount").textContent = peers.length ? `${peers.length + 1} online` : "Just you";
  if ($("#teamPanel").hidden) return;
  const person = (peer, self = false) => el("div", { class: "team-person" }, [
    el("span", { class: "team-avatar", style: `--peer:${peer.color}`, text: initials(peer.name) }),
    el("div", { class: "team-person-name" }, [el("strong", { text: `${peer.name}${self ? " (you)" : ""}` }), el("small", { text: self ? "You" : "Online" })]),
    self ? el("span", { class: "team-you", text: "You" }) : el("button", { class: `ghost-btn small${app.following === peer.id ? " is-following" : ""}`, text: app.following === peer.id ? "Following" : "Follow", "aria-label": `${app.following === peer.id ? "Stop following" : "Follow"} ${peer.name}`, onclick: () => toggleFollow(peer.id) }),
  ]);
  $("#teamList").replaceChildren(person(identity(), true), ...peers.map((peer) => person(peer)));
  if (!peers.length) $("#teamList").append(el("p", { class: "panel-empty", text: "No other collaborators on this board." }));
}

function renderOverview() {
  const query = $("#overviewSearch").value.trim().toLowerCase();
  const all = objectList().filter((obj) => obj.type !== "arrow");
  const matches = all.filter((obj) => `${obj.type} ${searchableObjectText(obj)}`.toLowerCase().includes(query));
  const rows = matches.slice(0, 150).map((obj) => el("button", { class: "overview-item", onclick: () => {
    setMode("select");
    centerOn(obj.x + obj.w / 2, obj.y + obj.h / 2, Math.min(1.2, Math.max(view.zoom, 0.7)));
    select([obj.id]);
  } }, [el("span", { class: `overview-kind kind-${obj.type}`, text: obj.type === "frame" ? "▧" : obj.type === "code" ? "</>" : "▤" }), el("span", {}, [el("strong", { text: obj.text?.replace(/[#*$`]/g, "").split("\n").find((line) => line.trim())?.slice(0, 90) || `Untitled ${obj.type}` }), el("small", { text: obj.type })])]));
  $("#overviewList").replaceChildren(...rows);
  if (!rows.length) $("#overviewList").append(el("p", { class: "panel-empty", text: query ? "No matching cards. Try a different search." : "Your cards and frames will appear here. Add something to your canvas to get started." }));
  if (matches.length > rows.length) $("#overviewList").append(el("p", { class: "hint", text: `Showing ${rows.length} of ${matches.length} cards. Search to narrow the list.` }));
}
