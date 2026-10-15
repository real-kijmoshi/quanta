// Rendering for note and text cards: a small, safe Markdown subset plus LaTeX
// math through KaTeX ($inline$, $$display$$). KaTeX is served locally from
// /vendor/katex and loaded on first use.
import { emit } from "./core.js";

let katexState = "idle"; // idle | loading | ready | failed

export function ensureKatex() {
  if (katexState !== "idle") return;
  katexState = "loading";
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/vendor/katex/katex.min.css?v=20261015";
  document.head.append(css);
  const script = document.createElement("script");
  script.src = "/vendor/katex/katex.min.js?v=20261015";
  script.onload = () => {
    katexState = "ready";
    emit("katex:ready");
  };
  script.onerror = () => {
    katexState = "failed";
  };
  document.head.append(script);
}

export const katexReady = () => katexState === "ready";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** LaTeX to HTML; falls back to the source while KaTeX loads or on error. */
export function tex(source, display = false) {
  if (katexState !== "ready") {
    ensureKatex();
    return `<span class="tex-pending">${escapeHtml(display ? source : source)}</span>`;
  }
  try {
    return window.katex.renderToString(source, { displayMode: display, throwOnError: false, strict: "ignore", output: "html", trust: false });
  } catch {
    return `<code>${escapeHtml(source)}</code>`;
  }
}

/** Inline Markdown: code, math, bold, italic, strike, links. */
function inline(text) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let out = text
    .replace(/`([^`]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`))
    .replace(/\$\$([^$]+)\$\$/g, (_, src) => keep(tex(src, true)))
    .replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\d)/g, (_, lead, src) => lead + keep(tex(src, false)))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`));
  out = escapeHtml(out)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\s][^_]*?)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(/\\\$/g, "$");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

/**
 * Render Markdown to HTML. Task items get `data-task="<line>"` so the card can
 * toggle the matching `[ ]` in the source when clicked.
 */
export function renderRich(source) {
  const lines = String(source ?? "").split("\n");
  const html = [];
  let list = null; // "ul" | "ol"
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      closeList();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (trimmed.startsWith("$$")) {
      flushParagraph();
      closeList();
      let body = trimmed.slice(2);
      if (body.endsWith("$$") && body.length >= 2) body = body.slice(0, -2);
      else {
        const rest = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().endsWith("$$")) rest.push(lines[i++]);
        if (i < lines.length) rest.push(lines[i].trim().slice(0, -2));
        body = [body, ...rest].join("\n");
      }
      html.push(`<div class="tex-block">${tex(body.trim(), true)}</div>`);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level + 2}>${inline(heading[2])}</h${level + 2}>`);
      continue;
    }
    const task = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(trimmed);
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (task || bullet || numbered) {
      flushParagraph();
      const kind = numbered ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        html.push(numbered ? `<ol start="${numbered[1]}">` : "<ul>");
        list = kind;
      }
      if (task) {
        const done = task[1] !== " ";
        html.push(`<li class="task${done ? " done" : ""}"><button type="button" class="task-box" data-task="${i}" aria-pressed="${done}"></button><span>${inline(task[2])}</span></li>`);
      } else html.push(`<li>${inline((bullet ?? numbered)[bullet ? 1 : 2])}</li>`);
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${inline(trimmed.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    closeList();
    paragraph.push(inline(line));
  }
  flushParagraph();
  closeList();
  return html.join("");
}

/** Flip `[ ]` / `[x]` on one source line. */
export function toggleTask(source, lineIndex) {
  const lines = String(source).split("\n");
  const line = lines[lineIndex] ?? "";
  lines[lineIndex] = /\[( )\]/.test(line) ? line.replace("[ ]", "[x]") : line.replace(/\[(x|X)\]/, "[ ]");
  return lines.join("\n");
}

export const looksRich = (text) => /[$*_`#>\[]|^\s*[-*]\s|^\s*\d+[.)]\s/m.test(String(text ?? ""));
