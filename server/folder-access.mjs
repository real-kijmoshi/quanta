import { createHash, timingSafeEqual } from "node:crypto";
import { folderWithin, invitationHash } from "./store.mjs";
import { hosted, accountAccess, cookie } from "./auth.mjs";

const forbidden = () => { throw Object.assign(new Error("Open a valid folder invitation to access this workspace"), { status: 403 }); };

// `npm run tunnel` prints a private owner link so the operator keeps owner access
// through a public tunnel while everyone else still needs a folder invitation.
const ownerDigest = process.env.QUANTA_OWNER_TOKEN ? createHash("sha256").update(process.env.QUANTA_OWNER_TOKEN).digest() : null;
export function ownerTokenMatches(value) {
  if (!ownerDigest || typeof value !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(value).digest(), ownerDigest);
}

export function accessFor(req, index) {
  if (hosted) return accountAccess(req, index);
  if (ownerTokenMatches(cookie(req, "quanta_owner"))) return { owner: true };
  const token = cookie(req, "quanta_folder");
  if (token) return invitationAccess(index, token);
  const address = req.socket.remoteAddress;
  let hostname = "";
  try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { /* denied below */ }
  if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return { owner: true };
  forbidden();
}

export function invitationAccess(index, token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) forbidden();
  const hash = invitationHash(token);
  for (const folder of index.folders) {
    const invite = folder.invitations?.find((item) => item.hash === hash);
    if (invite) return { owner: false, folderId: folder.id, invitationId: invite.id, name: invite.name };
  }
  forbidden();
}

export const canFolder = (index, access, id) => access.owner || (access.folderIds ?? [access.folderId]).some((root) => root && folderWithin(index, id, root));
export const canBoard = (index, access, id) => access.owner || index.boards.some((b) => b.id === id && canFolder(index, access, b.folderId));
export function requireOwner(access) {
  if (!access.owner) throw Object.assign(new Error("Only the workspace owner can manage folders and invitations"), { status: 403 });
}
export function requireBoard(index, access, id) {
  if (!canBoard(index, access, id)) throw Object.assign(new Error("Board access denied"), { status: 403 });
}
export function requireFolder(index, access, id) {
  if (!canFolder(index, access, id)) throw Object.assign(new Error("Folder access denied"), { status: 403 });
}

export function visibleWorkspace(index, access) {
  const boards = index.boards.filter((b) => canBoard(index, access, b.id));
  const ids = new Set(boards.map((b) => b.id));
  return {
    access,
    boards,
    folders: index.folders.filter((f) => canFolder(index, access, f.id)).map(({ invitations = [], ...folder }) => ({
      ...folder,
      parentId: !access.owner && !canFolder(index, access, folder.parentId) ? null : folder.parentId ?? null,
      sharedWith: invitations.length,
    })),
    links: (index.links ?? []).filter((pair) => pair.every((id) => ids.has(id))),
  };
}
