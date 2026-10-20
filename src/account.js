import { el, setIdentity, setPrefs, toast } from "./core.js";
import { api, flushSave, state } from "./doc.js";
import { notesSetting } from "./notes-preferences.js";

export let account = { enabled: false, user: null };

function clearInvitation() {
  history.replaceState({}, "", location.pathname + location.search);
  try { sessionStorage.removeItem("quanta:pending-invite"); } catch { /* storage can be disabled */ }
}

export async function ensureAccount(token) {
  try { account = await api("/api/auth/me"); }
  catch (error) {
    let wasHosted = false;
    try { wasHosted = localStorage.getItem("quanta:hosted") === "1"; } catch { wasHosted = true; }
    if (wasHosted || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) throw error;
    document.body.classList.remove("booting");
    return false;
  }
  try { localStorage.setItem("quanta:hosted", account.enabled ? "1" : "0"); } catch { /* accounts also work without localStorage */ }
  if (!account.enabled) { document.body.classList.remove("booting"); return false; }
  if (token) {
    try { sessionStorage.setItem("quanta:pending-invite", token); } catch { /* keep the token in memory */ }
    history.replaceState({}, "", location.pathname + location.search);
  }
  try { token ??= sessionStorage.getItem("quanta:pending-invite"); } catch { /* no saved invitation */ }
  if (!account.user) await signIn(token);
  else if (token) {
    try { await api("/api/auth/accept", { method: "POST", body: { token } }); clearInvitation(); }
    catch (error) { toast(error.message, "bad"); clearInvitation(); }
  }
  globalThis.quantaAccountId = account.user.id;
  setIdentity({ name: account.user.name });
  setPrefs("identity:named", true);
  document.body.classList.remove("booting");
  // Cookies are shared between tabs. Reload before a different account can reuse
  // this tab's in-memory board or queued changes.
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("quanta-account") : null;
  if (channel) channel.onmessage = () => location.reload();
  return true;
}

function signIn(token) {
  return new Promise((resolve) => {
    let register = !!token;
    const screen = el("main", { class: "account-screen" });
    const art = el("section", { class: "account-art", "aria-hidden": "true" }, [
      el("span", { class: "account-wordmark", text: "Quanta / a space to think" }),
      el("div", { class: "account-art-notes" }, [el("div", { text: "A little curiosity." }), el("div", { text: "A shared perspective." }), el("div", { text: "Something brilliant." })]),
      el("h2", { text: "Big ideas start\nwith a little space." }),
      el("p", { text: "Sketch, solve, and work things out together." }),
    ]);
    const card = el("section", { class: "account-card" });
    const render = () => {
      const name = el("input", { id: "accountName", class: "folder-input", autocomplete: "name", required: register, maxlength: 80 });
      const email = el("input", { id: "accountEmail", class: "folder-input", type: "email", autocomplete: "username", required: true, maxlength: 254 });
      const password = el("input", { id: "accountPassword", class: "folder-input", type: "password", autocomplete: register ? "new-password" : "current-password", required: true, minlength: 12, maxlength: 256 });
      const error = el("p", { class: "form-error", role: "alert" });
      const submit = el("button", { class: "solid-btn", type: "submit", text: register ? "Create account & join" : token ? "Sign in & join" : "Sign in" });
      const field = (label, id, input) => el("div", { class: "account-field" }, [el("label", { for: id, text: label }), input]);
      const form = el("form", {}, [register ? field("Your name", "accountName", name) : null, field("Email address", "accountEmail", email), field("Password", "accountPassword", password), register ? el("p", { class: "hint", text: "At least 12 characters. Your account works across devices." }) : null, error, submit]);
      form.onsubmit = async (event) => {
        event.preventDefault(); submit.disabled = true; error.textContent = "";
        try {
          const result = await api(`/api/auth/${register ? "register" : "login"}`, { method: "POST", body: { name: name.value, email: email.value, password: password.value, ...(token ? { token } : {}) } });
          account.user = result.user;
          clearInvitation();
          if (typeof BroadcastChannel === "function") { const signal = new BroadcastChannel("quanta-account"); signal.postMessage("signed-in"); signal.close(); }
          screen.remove(); resolve();
        } catch (issue) { error.textContent = issue.message; submit.disabled = false; }
      };
      card.replaceChildren(...[el("span", { class: "brand", text: "Quanta" }), el("span", { class: "eyebrow", text: token ? "YOU'RE INVITED" : "YOUR SHARED WORKSPACE" }), el("h1", { text: register ? "Make room for your ideas." : "Welcome back." }), el("p", { class: "account-intro", text: token ? "Join your team with a personal account. Your folders will be waiting here whenever you sign in." : "Pick up where you left off. Your boards and your people, all in one place." }), form,
        token ? el("button", { class: "account-switch", text: register ? "Already have an account? Sign in" : "New here? Create an account", onclick: () => { register = !register; render(); } }) : el("p", { class: "hint", text: "Joining a team? Open the invitation link from your workspace owner." }),
        token ? el("button", { class: "account-switch", text: "Continue without this invitation", onclick: () => { token = null; register = false; clearInvitation(); render(); } }) : null].filter(Boolean));
    };
    render(); screen.append(art, card); document.body.append(screen);
    card.querySelector("input")?.focus();
  });
}

async function signOut() {
  await flushSave();
  if (state.status === "offline" || state.status === "error") throw new Error("Your changes haven't reached the server yet. Reconnect before signing out.");
  await api("/api/auth/logout", { method: "POST" });
  if (typeof BroadcastChannel === "function") { const signal = new BroadcastChannel("quanta-account"); signal.postMessage("signed-out"); signal.close(); }
  location.reload();
}

export function workspaceSettings() {
  const previous = document.activeElement;
  const box = el("dialog", { class: "sheet-box folder-dialog settings-dialog", "aria-label": "Workspace settings" });
  box.append(el("header", {}, [el("h2", { text: "Your workspace" }), el("button", { class: "panel-close", text: "×", "aria-label": "Close", onclick: () => box.close() })]));
  const status = el("div", { class: "hosting-status" }, [el("span", { class: "hosting-icon", text: account.enabled ? "↗" : "⌂" }), el("div", {}, [el("strong", { text: account.enabled ? "Always here, wherever you are" : "On this computer" }), el("p", { text: account.enabled ? "Hosted workspace · account access" : "Local workspace · invitation links" })]), el("span", { class: "status-badge", text: account.enabled ? "Hosted" : "Local" })]);
  box.append(notesSetting(), status);
  if (account.enabled) {
    box.append(el("p", { class: "hint", text: account.publicUrl }), el("h3", { text: "Your account" }), el("div", { class: "settings-account" }, [el("strong", { text: account.user.name }), el("p", { text: account.user.email }), el("span", { class: "status-badge", text: account.user.role === "owner" ? "Workspace owner" : "Member" })]));
    const current = el("input", { class: "folder-input", type: "password", autocomplete: "current-password", placeholder: "Current password", "aria-label": "Current password", required: true, maxlength: 256 });
    const next = el("input", { class: "folder-input", type: "password", autocomplete: "new-password", placeholder: "New password (12+ characters)", "aria-label": "New password", required: true, minlength: 12, maxlength: 256 });
    const error = el("p", { class: "form-error", role: "alert" });
    const save = el("button", { class: "ghost-btn", type: "submit", text: "Update password" });
    const form = el("form", { class: "folder-form" }, [current, next, error, save]);
    form.onsubmit = async (event) => {
      event.preventDefault(); save.disabled = true;
      try { await flushSave(); if (["offline", "error"].includes(state.status)) throw new Error("Reconnect and save your changes first."); await api("/api/auth/password", { method: "POST", body: { currentPassword: current.value, password: next.value } }); location.reload(); }
      catch (issue) { error.textContent = issue.message; save.disabled = false; }
    };
    box.append(el("h3", { text: "Change password" }), form, el("button", { class: "folder-action danger", text: "Sign out", onclick: () => signOut().catch((issue) => toast(issue.message, "bad")) }));
  } else {
    box.append(el("h3", { text: "Give your team a permanent home" }), el("p", { text: "Run Quanta on your own server so your boards stay available when your computer is off. Everyone signs in to their own account." }), el("div", { class: "hosting-features" }, [el("span", { text: "✓ Personal accounts" }), el("span", { text: "✓ Private folders" }), el("span", { text: "✓ Live collaboration" }), el("span", { text: "✓ Persistent storage" })]));
    const details = el("details", { class: "hosting-details" }, [el("summary", { text: "Set up on a VPS" }), el("ol", {}, [el("li", { text: "Point a domain to your VPS and install Docker Compose." }), el("li", { text: "Copy this project to the server. Copy .env.example to .env and set your domain, owner email, and a strong password." }), el("li", { text: "Start the hosted service with the command below, then sign in at your domain." })]), el("pre", { class: "share-cmd", text: "docker compose up -d --build" }), el("p", { class: "hint", text: "Full instructions, backups, and account recovery: docs/SELF_HOSTING.md in the project. Your local boards can be migrated; keep a backup first." })]);
    box.append(details);
  }
  box.addEventListener("keydown", (event) => { if (event.key !== "Escape") event.stopPropagation(); });
  box.addEventListener("close", () => { box.remove(); if (previous?.isConnected) previous.focus(); });
  document.body.append(box); box.showModal();
}

export function mountAccount() {
  const button = document.querySelector("#workspaceSettingsBtn");
  button.onclick = workspaceSettings;
  document.querySelector("#sidebarInviteBtn").onclick = () => document.querySelector("#shareBtn").click();
  button.querySelector("small").textContent = account.enabled ? "Hosted · accounts enabled" : "Local · on this computer";
  document.querySelector("#workspaceLabel").textContent = account.enabled ? "Team workspace" : "My workspace";
}

export function showNoFolders() {
  document.querySelector("#app").hidden = true;
  document.body.append(el("section", { class: "access-screen" }, [el("span", { class: "brand", text: "Quanta" }), el("h1", { text: "You're signed in." }), el("p", { text: "You don't have access to a folder yet. Ask your workspace owner for a new invitation." }), el("button", { class: "solid-btn", text: "Account settings", onclick: workspaceSettings })]));
}
