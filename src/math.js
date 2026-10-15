// Math for math cards and plot cards: a real parser (no eval) that produces an
// AST, so each line can be evaluated *and* typeset as LaTeX.
//
// Supports: variables, user functions `f(x) = x^2`, implicit multiplication
// (`2x`, `3(a+b)`, `2pi r`), `^` and `**`, `!`, `|x|`, vectors `[1, 2, 3]`,
// tuples `(x, y)` for parametric plots, physical constants, and numeric
// integrate / deriv / solve over user functions.

const FUNCTIONS = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: (v) => (Array.isArray(v) ? Math.hypot(...v) : Math.abs(v)),
  exp: Math.exp,
  ln: Math.log,
  log: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)),
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sec: (x) => 1 / Math.cos(x),
  csc: (x) => 1 / Math.sin(x),
  cot: (x) => 1 / Math.tan(x),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  floor: Math.floor,
  ceil: Math.ceil,
  round: (x, digits = 0) => Math.round(x * 10 ** digits) / 10 ** digits,
  sign: Math.sign,
  min: (...a) => Math.min(...a.flat()),
  max: (...a) => Math.max(...a.flat()),
  hypot: Math.hypot,
  pow: Math.pow,
  mod: (a, b) => ((a % b) + b) % b,
  deg: (radians) => (radians * 180) / Math.PI,
  rad: (degrees) => (degrees * Math.PI) / 180,
  gamma: (x) => gamma(x),
  fact: (n) => gamma(n + 1),
  nCr: (n, k) => gamma(n + 1) / (gamma(k + 1) * gamma(n - k + 1)),
  nPr: (n, k) => gamma(n + 1) / gamma(n - k + 1),
  dot: (a, b) => vec(a).reduce((sum, v, i) => sum + v * vec(b)[i], 0),
  cross: (a, b) => {
    const [x1, y1, z1 = 0] = vec(a);
    const [x2, y2, z2 = 0] = vec(b);
    return [y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2];
  },
  norm: (a) => Math.hypot(...vec(a)),
  unit: (a) => {
    const n = Math.hypot(...vec(a));
    return vec(a).map((v) => v / n);
  },
  sum: (...a) => a.flat().reduce((s, v) => s + v, 0),
  mean: (...a) => a.flat().reduce((s, v) => s + v, 0) / a.flat().length,
};

/** Constants are shadowed by anything the card defines with the same name. */
export const CONSTANTS = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
  inf: Infinity,
  c: 299792458, // m/s
  G: 6.6743e-11, // m^3 kg^-1 s^-2
  g: 9.80665, // m/s^2
  h: 6.62607015e-34, // J s
  hbar: 1.054571817e-34,
  k_B: 1.380649e-23, // J/K
  N_A: 6.02214076e23,
  R: 8.314462618, // J/(mol K)
  q_e: 1.602176634e-19, // C
  m_e: 9.1093837015e-31, // kg
  m_p: 1.67262192369e-27, // kg
  eps0: 8.8541878128e-12,
  mu0: 1.25663706212e-6,
  sigma: 5.670374419e-8,
  au: 1.495978707e11, // m
};

const HIGHER_ORDER = new Set(["integrate", "deriv", "solve"]);

function gamma(x) {
  if (Number.isInteger(x) && x >= 1 && x < 171) {
    let r = 1;
    for (let i = 2; i < x; i += 1) r *= i;
    return r;
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i += 1) a += c[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * t ** (x + 0.5) * Math.exp(-t) * a;
}

const vec = (v) => (Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------- tokenizer

const OPERATORS = new Set(["+", "-", "*", "/", "^", "%", "(", ")", ",", "!", "|", "[", "]", "√"]);

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const match = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(input.slice(i));
      if (!match) throw new Error(`Bad number near "${input.slice(i, i + 8)}"`);
      tokens.push({ type: "number", value: Number(match[0]), raw: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[\p{L}_]/u.test(char)) {
      const match = /^[\p{L}_][\p{L}\p{N}_']*/u.exec(input.slice(i));
      tokens.push({ type: "name", value: match[0] });
      i += match[0].length;
      continue;
    }
    if (input.startsWith("**", i)) {
      tokens.push({ type: "^" });
      i += 2;
      continue;
    }
    const alias = { "·": "*", "×": "*", "÷": "/", "−": "-" }[char];
    if (alias || OPERATORS.has(char)) {
      tokens.push({ type: alias ?? char });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected "${char}"`);
  }
  return tokens;
}

// ------------------------------------------------------------------- parser

const STARTS_FACTOR = new Set(["number", "name", "(", "√", "["]);

export function parse(source) {
  const tokens = tokenize(source);
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset];
  const take = (type) => {
    if (!tokens[at] || tokens[at].type !== type) throw new Error(tokens[at] ? `Expected "${type}" but found "${tokens[at].value ?? tokens[at].type}"` : `Missing "${type}"`);
    return tokens[at++];
  };

  function list(close) {
    const items = [];
    if (peek()?.type !== close) {
      items.push(expression());
      while (peek()?.type === ",") {
        at += 1;
        items.push(expression());
      }
    }
    take(close);
    return items;
  }

  function primary() {
    const token = peek();
    if (!token) throw new Error("Expression ends too early");
    if (token.type === "number") {
      at += 1;
      return { t: "num", v: token.value, raw: token.raw };
    }
    if (token.type === "name") {
      at += 1;
      if (peek()?.type === "(") {
        at += 1;
        return { t: "call", name: token.value, args: list(")") };
      }
      // `sin x`: known functions also apply to a following factor.
      if (FUNCTIONS[token.value] && peek() && ["number", "name"].includes(peek().type)) {
        return { t: "call", name: token.value, args: [power()], bare: true };
      }
      return { t: "var", name: token.value };
    }
    if (token.type === "(") {
      at += 1;
      const items = list(")");
      if (items.length === 1) return { t: "paren", a: items[0] };
      return { t: "tuple", items };
    }
    if (token.type === "[") {
      at += 1;
      return { t: "vector", items: list("]") };
    }
    if (token.type === "|") {
      at += 1;
      const inner = expression();
      take("|");
      return { t: "call", name: "abs", args: [inner], bars: true };
    }
    if (token.type === "√") {
      at += 1;
      return { t: "call", name: "sqrt", args: [postfix()] };
    }
    throw new Error(`Unexpected "${token.value ?? token.type}"`);
  }

  function postfix() {
    let node = primary();
    while (peek()?.type === "!") {
      at += 1;
      node = { t: "fact", a: node };
    }
    return node;
  }

  function power() {
    const base = postfix();
    if (peek()?.type === "^") {
      at += 1;
      return { t: "bin", op: "^", a: base, b: unary() };
    }
    return base;
  }

  function unary() {
    if (peek()?.type === "-") {
      at += 1;
      return { t: "neg", a: unary() };
    }
    if (peek()?.type === "+") {
      at += 1;
      return unary();
    }
    return power();
  }

  function term() {
    let left = unary();
    for (;;) {
      const token = peek();
      if (token && ["*", "/", "%"].includes(token.type)) {
        at += 1;
        left = { t: "bin", op: token.type, a: left, b: unary() };
      } else if (token && STARTS_FACTOR.has(token.type)) {
        left = { t: "bin", op: "*", a: left, b: power(), implicit: true };
      } else break;
    }
    return left;
  }

  function expression() {
    let left = term();
    while (peek() && (peek().type === "+" || peek().type === "-")) {
      const op = tokens[at++].type;
      left = { t: "bin", op, a: left, b: term() };
    }
    return left;
  }

  const tree = expression();
  if (at < tokens.length) throw new Error(`Unexpected "${tokens[at].value ?? tokens[at].type}"`);
  return tree;
}

// ---------------------------------------------------------------- evaluation

function arith(op, a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (op === "*" && Array.isArray(a) && Array.isArray(b)) return FUNCTIONS.dot(a, b);
    const n = Math.max(vec(a).length, vec(b).length);
    const at = (v, i) => (Array.isArray(v) ? v[i] : v);
    if ((op === "+" || op === "-") && (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)) {
      throw new Error("Vectors must have the same length");
    }
    return Array.from({ length: n }, (_, i) => arith(op, at(a, i), at(b, i)));
  }
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "%":
      return a % b;
    case "^":
      return a ** b;
    default:
      throw new Error(`Unknown operator ${op}`);
  }
}

/** Scope: { vars: {}, fns: {name: {params, body}} } with an optional parent. */
export function makeScope(parent = null) {
  return { vars: Object.create(parent?.vars ?? null), fns: Object.create(parent?.fns ?? null) };
}

function lookup(name, scope) {
  if (name in scope.vars) return scope.vars[name];
  if (name in CONSTANTS) return CONSTANTS[name];
  throw new Error(`Unknown name "${name}"`);
}

function callable(node, scope) {
  // A function argument: `f`, or a builtin like `sin`.
  if (node.t !== "var") throw new Error("Pass a function name, like f");
  const fn = scope.fns[node.name];
  if (fn) return (...args) => applyUser(fn, args, scope);
  if (FUNCTIONS[node.name]) return FUNCTIONS[node.name];
  throw new Error(`"${node.name}" is not a function`);
}

function applyUser(fn, args, scope) {
  if (args.length !== fn.params.length) throw new Error(`Expected ${fn.params.length} argument(s)`);
  const inner = makeScope(scope);
  fn.params.forEach((param, i) => {
    inner.vars[param] = args[i];
  });
  return evaluate(fn.body, inner);
}

function higherOrder(name, args, scope) {
  const f = callable(args[0], scope);
  const nums = args.slice(1).map((arg) => evaluate(arg, scope));
  if (name === "integrate") {
    const [a, b, n0 = 1000] = nums;
    const n = Math.max(2, Math.round(n0 / 2) * 2);
    const step = (b - a) / n;
    let sum = f(a) + f(b);
    for (let i = 1; i < n; i += 1) sum += (i % 2 ? 4 : 2) * f(a + i * step);
    return (sum * step) / 3;
  }
  if (name === "deriv") {
    const [x] = nums;
    const h = 1e-5 * Math.max(1, Math.abs(x));
    return (f(x - 2 * h) - 8 * f(x - h) + 8 * f(x + h) - f(x + 2 * h)) / (12 * h);
  }
  if (name === "solve") {
    // Root of f near a guess (secant), or inside [a, b] (bisection).
    if (nums.length >= 2) {
      let [a, b] = nums;
      let fa = f(a);
      if (fa * f(b) > 0) throw new Error("f(a) and f(b) need opposite signs");
      for (let i = 0; i < 200; i += 1) {
        const m = (a + b) / 2;
        const fm = f(m);
        if (Math.abs(fm) < 1e-14 || (b - a) / 2 < 1e-14) return m;
        if (fa * fm < 0) b = m;
        else {
          a = m;
          fa = fm;
        }
      }
      return (a + b) / 2;
    }
    let x0 = nums[0] ?? 1;
    let x1 = x0 + 1e-3 * Math.max(1, Math.abs(x0));
    for (let i = 0; i < 100; i += 1) {
      const f0 = f(x0);
      const f1 = f(x1);
      if (f1 === f0) break;
      const x2 = x1 - (f1 * (x1 - x0)) / (f1 - f0);
      x0 = x1;
      x1 = x2;
      if (Math.abs(x1 - x0) < 1e-13 * Math.max(1, Math.abs(x1))) break;
    }
    if (!Number.isFinite(x1)) throw new Error("No root found");
    return x1;
  }
  throw new Error(`Unknown function ${name}`);
}

export function evaluate(node, scope) {
  switch (node.t) {
    case "num":
      return node.v;
    case "var":
      return lookup(node.name, scope);
    case "paren":
      return evaluate(node.a, scope);
    case "neg": {
      const v = evaluate(node.a, scope);
      return Array.isArray(v) ? v.map((x) => -x) : -v;
    }
    case "fact":
      return gamma(evaluate(node.a, scope) + 1);
    case "vector":
    case "tuple":
      return node.items.map((item) => {
        const v = evaluate(item, scope);
        if (Array.isArray(v)) throw new Error("Nested vectors are not supported");
        return v;
      });
    case "bin":
      return arith(node.op, evaluate(node.a, scope), evaluate(node.b, scope));
    case "call": {
      if (HIGHER_ORDER.has(node.name)) return higherOrder(node.name, node.args, scope);
      const user = scope.fns[node.name];
      if (user) return applyUser(user, node.args.map((a) => evaluate(a, scope)), scope);
      const builtin = FUNCTIONS[node.name];
      if (builtin) return builtin(...node.args.map((a) => evaluate(a, scope)));
      // `a(b + c)` where a is a variable means multiplication.
      if (node.args.length === 1 && (node.name in scope.vars || node.name in CONSTANTS)) {
        return arith("*", lookup(node.name, scope), evaluate(node.args[0], scope));
      }
      throw new Error(`Unknown function "${node.name}"`);
    }
    default:
      throw new Error("Cannot evaluate that");
  }
}

/** Names a node depends on (for plots: does this line mention x?). */
export function freeNames(node, out = new Set()) {
  if (!node) return out;
  if (node.t === "var") out.add(node.name);
  if (node.t === "call") {
    out.add(`${node.name}()`);
    node.args.forEach((a) => freeNames(a, out));
  }
  for (const key of ["a", "b"]) if (node[key]) freeNames(node[key], out);
  for (const item of node.items ?? []) freeNames(item, out);
  return out;
}

// -------------------------------------------------------------------- lines

const NAME = String.raw`[\p{L}_][\p{L}\p{N}_']*`;
const FN_DEF = new RegExp(String.raw`^(${NAME})\s*\(\s*(${NAME}(?:\s*,\s*${NAME})*)?\s*\)\s*=(?!=)\s*(.+)$`, "u");
const ASSIGN = new RegExp(String.raw`^(${NAME})\s*=(?!=)\s*(.+)$`, "u");

export function stripComment(raw) {
  const index = raw.search(/(^|\s)(#|\/\/)/);
  return index === -1 ? { code: raw.trim(), comment: "" } : { code: raw.slice(0, index).trim(), comment: raw.slice(index).trim().replace(/^(#|\/\/)\s*/, "") };
}

/** Classify one line without evaluating it. */
export function parseLine(raw) {
  const { code, comment } = stripComment(raw);
  if (!code) return { kind: comment ? "comment" : "blank", comment };
  const fn = FN_DEF.exec(code);
  if (fn) {
    const params = (fn[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return { kind: "function", name: fn[1], params, ast: parse(fn[3]), comment };
  }
  const assign = ASSIGN.exec(code);
  if (assign) return { kind: "assign", name: assign[1], ast: parse(assign[2]), comment };
  return { kind: "value", ast: parse(code), comment };
}

/**
 * Evaluate a math card. One entry per source line:
 * { kind: blank|comment|assign|function|value|error, name, value, tex, error }.
 */
export function evaluateCard(source) {
  const scope = makeScope();
  return String(source ?? "")
    .split("\n")
    .map((raw) => {
      let line;
      try {
        line = parseLine(raw);
      } catch (error) {
        return { kind: "error", error: error.message, text: raw };
      }
      if (line.kind === "blank" || line.kind === "comment") return { ...line, text: raw };
      try {
        if (line.kind === "function") {
          scope.fns[line.name] = { params: line.params, body: line.ast };
          return { ...line, text: raw, tex: lineTex(line) };
        }
        const value = evaluate(line.ast, scope);
        const bad = Array.isArray(value) ? value.some((v) => typeof v !== "number") : typeof value !== "number" || Number.isNaN(value);
        if (bad) throw new Error("Not a number");
        if (line.kind === "assign") scope.vars[line.name] = value;
        return { ...line, value, text: raw, tex: lineTex(line) };
      } catch (error) {
        let tex = null;
        try {
          tex = lineTex(line);
        } catch {
          /* untypesettable */
        }
        return { kind: "error", error: error.message, text: raw, tex };
      }
    });
}

// --------------------------------------------------------------- formatting

export function formatNumber(value) {
  if (Array.isArray(value)) return `[${value.map(formatNumber).join(", ")}]`;
  if (typeof value !== "number" || Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "-∞";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e7 || magnitude < 1e-4) {
    return value
      .toExponential(5)
      .replace(/\.?0+e/, "e")
      .replace("e+", "e");
  }
  return String(Number(value.toPrecision(10)));
}

export function numberTex(value) {
  if (Array.isArray(value)) return `\\begin{bmatrix}${value.map(numberTex).join(" \\\\ ")}\\end{bmatrix}`;
  const text = formatNumber(value);
  if (text === "∞") return "\\infty";
  if (text === "-∞") return "-\\infty";
  const sci = /^(-?[\d.]+)e(-?\d+)$/.exec(text);
  if (sci) return `${sci[1]} \\times 10^{${sci[2]}}`;
  return text;
}

const GREEK = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi",
  "pi", "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma",
  "Phi", "Psi", "Omega",
]);
const TEX_FUNCS = new Set(["sin", "cos", "tan", "sec", "csc", "cot", "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan", "ln", "exp", "min", "max", "det", "gcd"]);

function nameTex(name) {
  const special = { hbar: "\\hbar", inf: "\\infty", eps0: "\\varepsilon_0", mu0: "\\mu_0", k_B: "k_B", N_A: "N_A", q_e: "q_e", m_e: "m_e", m_p: "m_p" };
  if (special[name]) return special[name];
  const primes = (name.match(/'+$/) ?? [""])[0];
  const base = name.slice(0, name.length - primes.length);
  // `v0` and `x12` read as subscripted, like v_0.
  const digits = /^([A-Za-z]+?)(\d+)$/.exec(base);
  const [head, ...rest] = digits ? [digits[1], digits[2]] : base.split("_");
  const sub = rest.join("_");
  const headTex = GREEK.has(head) ? `\\${head}` : head.length === 1 ? head : `\\mathrm{${head}}`;
  const subTex = sub ? `_{${/^\d+$/.test(sub) || sub.length === 1 ? sub : GREEK.has(sub) ? `\\${sub}` : `\\mathrm{${sub.replace(/_/g, "\\_")}}`}}` : "";
  return `${headTex}${subTex}${primes}`;
}

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 4 };

function toTex(node) {
  switch (node.t) {
    case "num":
      return numberTex(node.v);
    case "var":
      return nameTex(node.name);
    case "paren":
      return `\\left(${toTex(node.a)}\\right)`;
    case "neg": {
      const inner = node.a.t === "bin" && PREC[node.a.op] === 1 ? `\\left(${toTex(node.a)}\\right)` : toTex(node.a);
      return `-${inner}`;
    }
    case "fact":
      return `${wrap(node.a, 5)}!`;
    case "vector":
      return `\\begin{bmatrix}${node.items.map(toTex).join(" \\\\ ")}\\end{bmatrix}`;
    case "tuple":
      return `\\left(${node.items.map(toTex).join(", ")}\\right)`;
    case "bin": {
      if (node.op === "/") return `\\frac{${toTex(unparen(node.a))}}{${toTex(unparen(node.b))}}`;
      if (node.op === "^") return `${wrap(node.a, 5)}^{${toTex(unparen(node.b))}}`;
      if (node.op === "*") {
        const left = wrap(node.a, 2);
        const right = wrap(node.b, 2);
        const needsDot = !node.implicit || startsWithDigit(node.b) || (node.b.t === "neg");
        return needsDot ? `${left} \\cdot ${right}` : `${left}\\,${right}`;
      }
      if (node.op === "%") return `${wrap(node.a, 2)} \\bmod ${wrap(node.b, 3)}`;
      const right = node.op === "-" ? wrap(node.b, 2) : toTex(node.b);
      return `${toTex(node.a)} ${node.op} ${right}`;
    }
    case "call": {
      const args = node.args.map((a) => toTex(unparen(a)));
      if (node.name === "sqrt") return `\\sqrt{${args[0]}}`;
      if (node.name === "cbrt") return `\\sqrt[3]{${args[0]}}`;
      if (node.name === "abs" || node.name === "norm") return node.name === "norm" ? `\\left\\lVert ${args[0]}\\right\\rVert` : `\\left|${args[0]}\\right|`;
      if (node.name === "log" && args.length === 1) return `\\log_{10}\\left(${args[0]}\\right)`;
      if (node.name === "log" && args.length === 2) return `\\log_{${args[1]}}\\left(${args[0]}\\right)`;
      if (node.name === "exp" && args.length === 1) return `e^{${args[0]}}`;
      if (node.name === "integrate" && node.args.length >= 3) {
        const f = node.args[0].t === "var" ? nameTex(node.args[0].name) : "f";
        return `\\int_{${args[1]}}^{${args[2]}} ${f}(x)\\,dx`;
      }
      if (node.name === "deriv" && node.args.length >= 2) {
        const f = node.args[0].t === "var" ? nameTex(node.args[0].name) : "f";
        return `${f}'\\left(${args[1]}\\right)`;
      }
      if (node.name === "dot" && args.length === 2) return `${args[0]} \\cdot ${args[1]}`;
      if (node.name === "cross" && args.length === 2) return `${args[0]} \\times ${args[1]}`;
      if (node.name === "floor") return `\\lfloor ${args[0]} \\rfloor`;
      if (node.name === "ceil") return `\\lceil ${args[0]} \\rceil`;
      const head = TEX_FUNCS.has(node.name) ? `\\${node.name}` : FUNCTIONS[node.name] || HIGHER_ORDER.has(node.name) ? `\\operatorname{${node.name}}` : nameTex(node.name);
      return `${head}\\left(${args.join(", ")}\\right)`;
    }
    default:
      return "?";
  }
}

const unparen = (node) => (node.t === "paren" ? node.a : node);
const startsWithDigit = (node) => node.t === "num" || (node.t === "bin" && startsWithDigit(node.a)) || (node.t === "fact" && startsWithDigit(node.a));

function wrap(node, precedence) {
  const tex = toTex(node);
  const own = node.t === "bin" ? PREC[node.op] : node.t === "neg" ? 1.5 : 10;
  if (node.t === "bin" && node.op === "/" && precedence < 5) return tex;
  return own < precedence ? `\\left(${tex}\\right)` : tex;
}

export function lineTex(line) {
  if (line.kind === "function") return `${nameTex(line.name)}\\left(${line.params.map(nameTex).join(", ")}\\right) = ${toTex(line.ast)}`;
  if (line.kind === "assign") return `${nameTex(line.name)} = ${toTex(line.ast)}`;
  return toTex(line.ast);
}

export const expressionTex = (ast) => toTex(ast);

export const mathHelp =
  "One expression per line · `a = 3` · `f(x) = x^2` · implicit `2pi r` · `[1,2,3]` vectors · integrate(f, a, b) · deriv(f, x) · solve(f, guess) · constants c, G, g, h, k_B, …";
