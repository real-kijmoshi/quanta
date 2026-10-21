// Phone layout: panels, the board menu and the More tools open as bottom
// sheets over a scrim. Tapping the scrim or swiping a sheet down closes it.
import { $, $$, el } from "./core.js";

const phone = globalThis.matchMedia?.("(max-width: 760px)");
const SHEETS = ".panel:not([hidden]), #moreMenu:not([hidden]), #toolsMore:not([hidden])";
let scrim;

function closeSheet(node) {
  node.hidden = true;
  node.classList.remove("open");
  if (node.id === "toolsMore") $("#moreToolsBtn")?.setAttribute("aria-expanded", "false");
}

function sync() {
  const open = phone.matches && Boolean(document.querySelector(SHEETS));
  // Rewriting the same value would wake the observer that calls this again.
  if (scrim.hidden === open) scrim.hidden = !open;
  document.body.classList.toggle("sheet-open", open);
}

// The board menu lives in the header, which is its own stacking context;
// on phones it moves to the body so it can sit above the scrim.
function placeMenu() {
  const menu = $("#moreMenu");
  if (phone.matches) document.body.append(menu);
  else $(".menu-wrap").append(menu);
  sync();
}

function syncStar() {
  const star = $("#favoriteBoardBtn");
  const tile = $('[data-proxy="favoriteBoardBtn"]');
  const on = star.getAttribute("aria-pressed") === "true";
  tile.classList.toggle("on", on);
  tile.lastChild.textContent = on ? "Starred" : "Star";
}

// Drag a sheet down by its top edge to dismiss it.
function swipeToClose(event) {
  if (!phone.matches || event.button > 0) return;
  const sheet = event.target.closest(".panel, #moreMenu, #toolsMore");
  if (!sheet || event.target.closest("input, textarea, select")) return;
  const grip = event.clientY - sheet.getBoundingClientRect().top < 56;
  if (!grip) return;
  const startY = event.clientY;
  let dy = 0;
  const move = (e) => {
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
    sheet.style.transition = "none";
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (dy > 70) closeSheet(sheet);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}

export function mountMobile() {
  if (!phone) return;
  scrim = el("div", { class: "sheet-scrim", id: "sheetScrim", hidden: true, "aria-hidden": "true" });
  document.body.append(scrim);
  scrim.addEventListener("click", () => $$(SHEETS).forEach(closeSheet));
  new MutationObserver(sync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(syncStar).observe($("#favoriteBoardBtn"), { attributes: true, attributeFilter: ["aria-pressed"] });
  document.addEventListener("pointerdown", swipeToClose, true);
  phone.addEventListener("change", placeMenu);
  placeMenu();
  syncStar();
}
