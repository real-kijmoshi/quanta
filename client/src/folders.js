import { $, copyText, el, on, prefs, setPrefs, toast } from "./core.js";
import { api, createBoard, createFolder, deleteFolder, flushSave, loadWorkspace, moveBoard, openBoard, state } from "./doc.js";
import { restoreView } from "./view.js";
import { confirmSheet, openPanel } from "./ui.js";
import { account } from "./account.js";

const owner = () => state.workspace.access?.owner !== false;
const safe = (fn) => async (...args) => { try { await fn(...args); } catch (error) { toast(error.message, "bad"); } };
let healthInfo = null;
on("health", (info) => { healthInfo = info; });

export function folderPath(id) {
  const names = [], seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = state.workspace.folders.find((f) => f.id === id);
    if (!folder) break;
    names.unshift(folder.name);
    id = folder.parentId;
  }
  return names.join(" / ");
}

function inside(id, ancestor) {
  const seen = new Set();
  while (id && !seen.has(id)) {
    if (id === ancestor) return true;
    seen.add(id);
    id = state.workspace.folders.find((f) => f.id === id)?.parentId;
  }
  return false;
}

function dialog(title) {
  const previous = document.activeElement;
  const box = el("dialog", { class: "sheet-box folder-dialog", "aria-label": title });
  const close = () => box.close();
  box.append(el("header", {}, [el("h2", { text: title }), el("button", { class: "panel-close", type: "button", text: "×", "aria-label": "Close", onclick: close })]));
  box.addEventListener("close", () => { box.remove(); if (previous?.isConnected) previous.focus(); });
  box.addEventListener("click", (event) => { if (event.target === box && (event.clientX < box.getBoundingClientRect().left || event.clientX > box.getBoundingClientRect().right || event.clientY < box.getBoundingClientRect().top || event.clientY > box.getBoundingClientRect().bottom)) close(); });
  // Keep board shortcuts and editing tools out of native dialog inputs.
  box.addEventListener("keydown", (event) => { if (event.key !== "Escape") event.stopPropagation(); });
  document.body.append(box);
  box.showModal();
  return box;
}

async function go(id) {
  await flushSave();
  await openBoard(id);
  restoreView(id);
}

export function editFolder(folder = null, parentId = null) {
  if (state.serverless) return toast("Start the local server to organize folders.");
  const box = dialog(folder ? "Edit folder" : "New folder");
  const name = el("input", { class: "folder-input", value: folder?.name ?? "", placeholder: "e.g. Product design", maxlength: 80, required: true, "aria-label": "Folder name" });
  const parent = el("select", { class: "folder-input", "aria-label": "Parent folder" }, [
    el("option", { value: "", text: "Workspace · top level" }),
    ...state.workspace.folders.filter((f) => !folder || !inside(f.id, folder.id)).map((f) => el("option", { value: f.id, text: folderPath(f.id) })),
  ]);
  parent.value = folder?.parentId ?? parentId ?? "";
  const save = el("button", { class: "solid-btn", type: "submit", text: folder ? "Save folder" : "Create folder" });
  const form = el("form", { class: "folder-form" }, [el("label", { text: "Name" }), name, el("label", { text: "Location" }), parent,
    folder ? el("p", { class: "hint", text: "Members of the parent folder also get access to everything inside it." }) : null,
    save,
  ]);
  form.addEventListener("submit", safe(async (event) => {
    event.preventDefault();
    if (!name.value.trim()) return name.focus();
    save.disabled = true;
    try {
      if (folder) {
        await api(`/api/folders/${folder.id}`, { method: "PATCH", body: { name: name.value.trim(), parentId: parent.value || null } });
        await loadWorkspace();
      } else await createFolder(name.value.trim(), parent.value || null);
      box.close();
    } finally { save.disabled = false; }
  }));
  box.append(form);
  name.focus();
}

export async function shareFolder(folder) {
  if (!owner()) return toast("The workspace owner manages invitations.");
  const box = dialog(`Share “${folder.name}”`);
  box.append(el("div", { class: "share-folder-summary" }, [el("span", { class: "share-folder-icon", text: "↗", "aria-hidden": "true" }), el("div", {}, [el("strong", { text: folder.name }), el("p", { text: "Shared access to this folder and everything inside" })]), el("span", { class: "status-badge", text: "Can edit" })]));
  box.append(el("p", { text: account.enabled ? "Invite a teammate by email. Copy their invitation and send it to them to join with a personal account." : "Give each teammate their own invitation link. You can remove their access at any time." }));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const base = el("input", { class: "folder-input", "aria-label": "Server address", value: local && healthInfo?.lan?.length ? healthInfo.lan[0] : location.origin, type: "url", required: true });
  const connection = el("details", { class: "hosting-details" }, [el("summary", { text: "Connection settings" }), el("label", { class: "folder-label", text: "Server address" }), base]);
  if (!account.enabled) box.append(connection);
  else base.value = account.publicUrl;
  if (!account.enabled && local && !healthInfo?.shared) box.append(el("p", { class: "hint", text: "For other devices, start Quanta with quanta --share (network) or quanta --tunnel (internet), or enter your tunnel URL above." }));
  const name = el("input", { class: "folder-input", "aria-label": "Person's name", placeholder: "Person's name", maxlength: 80, required: true });
  if (account.enabled) {
    name.type = "email"; name.placeholder = "teammate@example.com"; name.maxLength = 254;
    name.setAttribute("aria-label", "Teammate's email address");
  }
  const invite = el("button", { class: "solid-btn", text: "Invite teammate", type: "submit" });
  const result = el("div", { class: "invite-result", "aria-live": "polite" });
  const list = el("div", { class: "folder-members", text: "Loading invitations…" });
  const refresh = async () => {
    const data = await api(`/api/folders/${folder.id}/invitations`);
    if (!box.isConnected) return;
    list.replaceChildren(...data.invitations.map((person) => el("div", { class: "folder-member" }, [
      el("span", { class: "member-initial", text: (person.member?.name || person.name)[0].toUpperCase() }),
      el("div", { class: "member-name" }, [el("strong", { text: person.member?.name || person.name }), el("small", { text: person.member ? `${person.member.email} · Member` : person.expiresAt && person.expiresAt < Date.now() ? "Invitation expired" : account.enabled ? `${person.email} · Pending invitation` : "Can edit · Invitation link" })]),
      el("button", { class: "ghost-btn small danger", text: person.member ? "Remove" : "Revoke", onclick: safe(async () => {
        await api(`/api/folders/${folder.id}/invitations/${person.id}`, { method: "DELETE" });
        result.replaceChildren();
        await refresh();
        await loadWorkspace();
      }) }),
    ])));
    if (!data.invitations.length) list.append(el("p", { class: "hint", text: "Only the workspace owner has access. Create an invitation to work together." }));
  };
  const form = el("form", { class: "invite-form" }, [name, invite]);
  form.addEventListener("submit", safe(async (event) => {
    event.preventDefault();
    const url = new URL(base.value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an http or https server address");
    if (!name.value.trim()) return name.focus();
    invite.disabled = true;
    try {
      const person = await api(`/api/folders/${folder.id}/invitations`, { method: "POST", body: { name: name.value.trim(), ...(account.enabled ? { email: name.value.trim() } : {}) } });
      url.pathname = "/"; url.search = ""; url.hash = new URLSearchParams({ invite: person.token }).toString();
      const link = url.href;
      result.replaceChildren(el("strong", { text: `Invitation for ${person.name}` }), el("div", { class: "share-link" }, [
        el("input", { value: link, readonly: true, "aria-label": "Invitation link", onclick: (event) => event.target.select() }),
        el("button", { class: "solid-btn", text: "Copy link", onclick: safe(async () => toast(await copyText(link) ? "Invitation copied" : "Select the link and copy it.")) }),
      ]), el("p", { class: "hint", text: account.enabled ? "Copy and send this link to your teammate. It expires in 7 days and can be accepted once, with their email address." : "Copy and send this link now. Anyone holding it can use it until you revoke the invitation." }));
      name.value = "";
      await refresh();
      await loadWorkspace();
    } finally { invite.disabled = false; }
  }));
  box.append(form, result, el("h3", { text: "People with access" }), list);
  const ancestors = state.workspace.folders.filter((f) => f.id !== folder.id && inside(folder.id, f.id) && f.sharedWith);
  if (ancestors.length) box.append(el("p", { class: "hint", text: `Also shared through: ${ancestors.map((f) => folderPath(f.id)).join(", ")}. Manage those invitations in the parent folder.` }));
  box.append(el("p", { class: "hint", text: account.enabled ? "Members can create and edit boards. Removing a member revokes this folder membership; access through other memberships continues." : "The owner manages folders and invitations. Guests can create and edit boards within their folder." }));
  await refresh().catch((error) => { list.textContent = error.message; });
  const stopRefresh = on("workspace", () => { refresh().catch(() => {}); });
  box.addEventListener("close", stopRefresh, { once: true });
}

export function folderActions(folder) {
  const box = dialog(folder.name);
  box.append(el("p", { class: "hint", text: folderPath(folder.id) }));
  const action = (text, fn, className = "") => el("button", { class: `folder-action ${className}`, text, onclick: safe(async () => { box.close(); await fn(); }) });
  box.append(action("+ New board in this folder", async () => {
    const board = await createBoard("Untitled board", folder.id);
    await go(board.id);
    $("#boardName").focus(); $("#boardName").select();
  }));
  if (owner()) box.append(
    action("+ New subfolder", () => editFolder(null, folder.id)),
    action("Share folder & manage access", () => shareFolder(folder)),
    action("Rename or move folder", () => editFolder(folder)),
    action("Delete folder", () => confirmSheet(`Delete “${folder.name}”?`, "Boards and subfolders move to the parent folder. Invitations to this folder are revoked.", async () => { await deleteFolder(folder.id); await loadWorkspace(); }), "danger"),
  );
}

export function folderTree(boards, boardRow, refresh, sharedOnly = false) {
  const folders = state.workspace.folders;
  const roots = folders.filter((f) => !f.parentId || !folders.some((p) => p.id === f.parentId));
  const render = (folder) => {
    const open = prefs(`folderOpen:${folder.id}`, true);
    const shared = folder.sharedWith > 0 || folders.some((f) => f.sharedWith > 0 && inside(folder.id, f.id)) || !owner();
    if (sharedOnly && !shared && !folders.some((f) => f.sharedWith > 0 && inside(f.id, folder.id))) return [];
    const count = boards.filter((b) => inside(b.folderId, folder.id)).length;
    const header = el("div", { class: `folder-row${shared ? " is-shared" : ""}`, dataset: { folder: folder.id }, draggable: owner() ? "true" : null }, [
      el("button", { class: "folder-open", "aria-expanded": String(open), title: folderPath(folder.id), onclick: () => { setPrefs(`folderOpen:${folder.id}`, !open); refresh(); } }, [
        el("span", { class: "folder-toggle", text: open ? "⌄" : "›" }),
        el("span", { class: "folder-symbol", text: shared ? "♧" : "▱", "aria-hidden": "true" }),
        el("strong", { text: folder.name }),
        el("span", { class: "folder-count", text: String(count) }),
      ]),
      el("button", { class: "folder-more", "aria-label": `Actions for ${folder.name}`, text: "⋯", onclick: () => folderActions(folder) }),
    ]);
    header.addEventListener("dragstart", (event) => { if (!owner()) return; event.dataTransfer.setData("text/quanta-folder", folder.id); event.stopPropagation(); });
    header.addEventListener("dragover", (event) => {
      if (event.dataTransfer.types.includes("text/quanta-board") || (owner() && event.dataTransfer.types.includes("text/quanta-folder"))) { event.preventDefault(); header.classList.add("drop"); }
    });
    header.addEventListener("dragleave", () => header.classList.remove("drop"));
    header.addEventListener("drop", safe(async (event) => {
      event.preventDefault(); event.stopPropagation(); header.classList.remove("drop");
      const boardId = event.dataTransfer.getData("text/quanta-board"), folderId = event.dataTransfer.getData("text/quanta-folder");
      if (boardId) await moveBoard(boardId, folder.id);
      else if (folderId) await api(`/api/folders/${folderId}`, { method: "PATCH", body: { parentId: folder.id } });
      setPrefs(`folderOpen:${folder.id}`, true);
      await loadWorkspace();
    }));
    const rows = [header];
    if (open) {
      const content = [...folders.filter((f) => f.parentId === folder.id).flatMap(render), ...boards.filter((b) => b.folderId === folder.id && (!sharedOnly || shared)).map(boardRow)];
      if (!content.length) content.push(el("button", { class: "folder-empty", text: "+ Add your first board", onclick: () => folderActions(folder) }));
      rows.push(el("div", { class: "folder-children" }, content));
    }
    return rows;
  };
  return roots.flatMap(render);
}

function renderLinks() {
  if (!state.board || $("#linksPanel").hidden) return;
  const id = state.board.id;
  const neighbors = (state.workspace.links ?? []).filter((pair) => pair.includes(id)).map((pair) => pair.find((other) => other !== id));
  const linked = state.workspace.boards.filter((b) => neighbors.includes(b.id));
  $("#boardLinksList").replaceChildren(...linked.map((board) => el("div", { class: "linked-board" }, [
    el("button", { class: "linked-board-open", onclick: safe(() => go(board.id)) }, [el("span", { class: "link-glyph", text: "↗" }), el("span", {}, [el("strong", { text: board.name }), el("small", { text: folderPath(board.folderId) || "Workspace" })])]),
    el("button", { class: "ghost-btn small", text: "×", "aria-label": `Unlink ${board.name}`, onclick: safe(async () => { await api(`/api/boards/${id}/links`, { method: "DELETE", body: { targetId: board.id } }); await loadWorkspace(); }) }),
  ])));
  if (!linked.length) $("#boardLinksList").append(el("p", { class: "panel-empty", text: "Connect related boards to move between ideas, plans, and notes. Connections appear on both boards." }));
  const query = $("#boardLinkSearch").value.trim().toLowerCase();
  const candidates = state.workspace.boards.filter((b) => b.id !== id && !neighbors.includes(b.id) && `${b.name} ${folderPath(b.folderId)}`.toLowerCase().includes(query));
  $("#boardLinkCandidates").replaceChildren(...candidates.slice(0, 50).map((board) => el("button", { class: "link-candidate", onclick: safe(async () => { await api(`/api/boards/${id}/links`, { method: "POST", body: { targetId: board.id } }); await loadWorkspace(); }) }, [el("span", {}, [el("strong", { text: board.name }), el("small", { text: folderPath(board.folderId) || "Workspace" })]), el("span", { text: "+" })])));
  if (!candidates.length) $("#boardLinkCandidates").append(el("p", { class: "hint", text: query ? "No matching boards." : "Create another board to add a connection." }));
}

export function mountFolders() {
  $("#boardLinksBtn").onclick = () => openPanel("linksPanel");
  $("#boardLinkSearch").oninput = renderLinks;
  on("panel:open", (id) => { if (id === "linksPanel") renderLinks(); });
  const update = () => {
    const current = state.workspace.boards.find((b) => b.id === state.board?.id);
    const folderId = current ? current.folderId : state.board?.folderId;
    const path = folderPath(folderId);
    const breadcrumb = $("#boardFolderLocation");
    breadcrumb.textContent = path || "Workspace";
    breadcrumb.title = path || "Workspace";
    const folder = state.workspace.folders.find((f) => f.id === folderId);
    breadcrumb.onclick = folder ? () => folderActions(folder) : null;
    const count = (state.workspace.links ?? []).filter((pair) => pair.includes(state.board?.id)).length;
    $("#boardLinksCount").textContent = count || "";
    $("#newFolderBtn").hidden = !owner();
    document.querySelectorAll('[data-command="delete-board"], [data-command="recover-board"]').forEach((button) => { button.hidden = !owner(); });
    renderLinks();
  };
  on("workspace", update); on("board:opened", update); on("board:renamed", renderLinks);
  on("folder:share", (folder) => safe(shareFolder)(folder));
}
