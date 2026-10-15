// A small syntax highlighter for code cards (JavaScript and Python). It only
// has to colour tokens for a textarea overlay, so it never changes the text.
import { escapeHtml } from "./rich.js";

const KEYWORDS = {
  javascript: new Set(
    "async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield".split(" "),
  ),
  python: new Set(
    "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(" "),
  ),
};
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity", "True", "False", "None"]);
const BUILTINS = {
  javascript: new Set("console Math JSON Array Object String Number Promise Map Set Date BigInt Symbol RegExp Error parseInt parseFloat".split(" ")),
  python: new Set("print len range enumerate zip map filter sum min max abs int float str list dict set tuple sorted reversed round isinstance type open super np plt math".split(" ")),
};

const PATTERNS = {
  javascript: [
    ["comment", /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
    ["string", /`(?:\\[\s\S]|[^`\\])*`?|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y],
    ["number", /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?n?|\.\d+(?:[eE][+-]?\d+)?)\b/y],
    ["word", /[A-Za-z_$][\w$]*/y],
    ["punct", /[{}()[\];,.<>+\-*/%=&|^!~?:]+/y],
  ],
  python: [
    ["comment", /#[^\n]*/y],
    ["string", /[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/y],
    ["decorator", /@[\w.]+/y],
    ["number", /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?j?|\.\d+(?:[eE][+-]?\d+)?j?)\b/y],
    ["word", /[A-Za-z_]\w*/y],
    ["punct", /[{}()[\];,.<>+\-*/%=&|^!~?:@]+/y],
  ],
};

export function highlight(code, lang = "javascript") {
  const language = PATTERNS[lang] ? lang : "javascript";
  const patterns = PATTERNS[language];
  const out = [];
  let i = 0;
  let previousWord = "";
  while (i < code.length) {
    let matched = false;
    for (const [kind, regex] of patterns) {
      regex.lastIndex = i;
      const match = regex.exec(code);
      if (!match || !match[0]) continue;
      const text = match[0];
      let cls = kind;
      if (kind === "word") {
        const next = code.slice(i + text.length).match(/^\s*\(/);
        if (KEYWORDS[language].has(text)) cls = "keyword";
        else if (LITERALS.has(text)) cls = "literal";
        else if (previousWord === "def" || previousWord === "function" || previousWord === "class") cls = "def";
        else if (next) cls = "call";
        else if (BUILTINS[language].has(text)) cls = "builtin";
        else cls = "";
        previousWord = text;
      } else if (kind !== "punct") previousWord = "";
      out.push(cls ? `<span class="hl-${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));
      i += text.length;
      matched = true;
      break;
    }
    if (!matched) {
      out.push(escapeHtml(code[i]));
      i += 1;
    }
  }
  // A trailing newline needs a character after it to keep the overlay aligned.
  return `${out.join("")}\n`;
}
