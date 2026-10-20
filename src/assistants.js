// "Your assistants" in Workspace settings (hosted accounts): bring your own provider
// key for the in-app assistant, or connect your own assistant to this workspace over MCP.
import { el, toast } from "./core.js";
import { api } from "./doc.js";

const PROVIDERS = {
  openai: { name: "OpenAI", placeholder: "sk-…", note: "An OpenAI API key. ChatGPT subscriptions do not include API access." },
  anthropic: { name: "Anthropic", placeholder: "sk-ant-…", note: "An Anthropic API key from console.anthropic.com." },
  openrouter: { name: "OpenRouter", placeholder: "sk-or-…", note: "One key for many models." },
};

const when = (time) => (time ? new Date(time).toLocaleDateString() : "never");

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied`); }
  catch { toast("Copy failed. Select the text and copy it manually.", "bad"); }
}

export function assistantSettings() {
  const root = el("section", { class: "assistant-settings" });
  let fresh = null;

  const changed = (data) => {
    render(data);
    // The assistant panel re-reads its provider list.
    document.dispatchEvent(new CustomEvent("quanta:assistants-changed"));
  };
  const run = async (button, work) => {
    button.disabled = true;
    try { await work(); }
    catch (issue) { toast(issue.message, "bad"); }
    finally { button.disabled = false; }
  };

  const providerRow = (data, provider) => {
    const meta = PROVIDERS[provider.id];
    const input = el("input", { class: "folder-input", type: "password", autocomplete: "off", placeholder: provider.connected ? `Connected ${provider.hint} · paste a new key to replace` : meta.placeholder, "aria-label": `${meta.name} API key`, maxlength: 400, spellcheck: "false" });
    const save = el("button", { class: "ghost-btn", type: "submit", text: provider.connected ? "Replace" : "Connect" });
    const form = el("form", { class: "folder-form assistant-key" }, [input, save]);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      run(save, async () => { changed(await api(`/api/connections/providers/${provider.id}`, { method: "PUT", body: { key: input.value } })); toast(`${meta.name} connected`); });
    };
    const remove = provider.connected ? el("button", { class: "folder-action danger", type: "button", text: "Disconnect", onclick: (event) => run(event.currentTarget, async () => changed(await api(`/api/connections/providers/${provider.id}`, { method: "DELETE" }))) }) : null;
    return el("div", { class: "assistant-row" }, [el("strong", { text: meta.name }), el("p", { class: "hint", text: meta.note }), form, remove]);
  };

  const tokenSection = (data) => {
    const name = el("input", { class: "folder-input", placeholder: "Name, for example ChatGPT", "aria-label": "Connection name", maxlength: 60, required: true });
    const create = el("button", { class: "ghost-btn", type: "submit", text: "Create connection" });
    const form = el("form", { class: "folder-form", onsubmit: (event) => {
      event.preventDefault();
      run(create, async () => { const result = await api("/api/connections/tokens", { method: "POST", body: { name: name.value } }); fresh = result.created; changed(result); });
    } }, [name, create]);
    const list = data.tokens.map((token) => el("div", { class: "assistant-token" }, [
      el("span", {}, [el("strong", { text: token.name }), el("small", { text: ` · last used ${when(token.lastUsedAt)}` })]),
      el("button", { class: "folder-action danger", type: "button", text: "Revoke", onclick: (event) => run(event.currentTarget, async () => { if (fresh?.id === token.id) fresh = null; changed(await api(`/api/connections/tokens/${token.id}`, { method: "DELETE" })); }) }),
    ]));
    const reveal = fresh ? el("div", { class: "assistant-reveal", role: "status" }, [
      el("strong", { text: `“${fresh.name}” is ready. Copy it now; it is shown only once.` }),
      el("p", { class: "hint", text: "Claude Code, Cursor, Codex and other clients that accept headers:" }),
      el("code", { text: data.mcpUrl }),
      el("button", { class: "ghost-btn small", type: "button", text: "Copy URL", onclick: () => copy(data.mcpUrl, "URL") }),
      el("code", { text: `Authorization: Bearer ${fresh.token}` }),
      el("button", { class: "ghost-btn small", type: "button", text: "Copy token", onclick: () => copy(fresh.token, "Token") }),
      el("p", { class: "hint", text: "ChatGPT and Claude custom connectors that cannot send headers: use this single URL. Anyone holding it can edit your boards, so treat it like a password." }),
      el("code", { text: `${data.mcpUrl}/${fresh.token}` }),
      el("button", { class: "ghost-btn small", type: "button", text: "Copy connector URL", onclick: () => copy(`${data.mcpUrl}/${fresh.token}`, "Connector URL") }),
    ]) : null;
    return [el("h3", { text: "Connect your own assistant" }),
      el("p", { class: "hint", text: "Let ChatGPT, Claude, Cursor or any MCP client read and edit the boards you can open, using your own subscription. It cannot see other people's folders." }),
      form, reveal, ...list];
  };

  function render(data) {
    root.replaceChildren(
      el("h3", { text: "Your assistants" }),
      el("p", { class: "hint", text: "Use your own API key for the assistant panel. Keys are encrypted on the server and only used for your requests." }),
      ...data.providers.map((provider) => providerRow(data, provider)),
      ...tokenSection(data),
    );
  }

  root.append(el("p", { class: "hint", text: "Loading…" }));
  api("/api/connections").then(render).catch((issue) => root.replaceChildren(el("p", { class: "form-error", text: issue.message })));
  return root;
}
