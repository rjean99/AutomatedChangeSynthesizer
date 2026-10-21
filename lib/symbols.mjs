// Heuristic, regex-driven symbol extraction. Each parser yields a flat list of
// symbols with a qualified name, kind, signature, visibility and a hash of the
// body, so the old and new versions of a file can be compared semantically.

import path from "node:path";
import { createHash } from "node:crypto";

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else",
  "throw", "do", "try", "await", "yield", "typeof", "delete", "super", "this", "elif", "with", "using", "lock",
  "foreach", "sizeof", "synchronized"]);

const JVM_MODS = "(?:public|private|protected|internal|static|final|abstract|sealed|partial|open|data|override|" +
  "virtual|async|synchronized|native|default|readonly|extern|unsafe|new|suspend|inline|operator|infix|tailrec|" +
  "const|annotation|inner|value|fileprivate|mutating|required|convenience|implicit|lazy)";

export const LANGS = {
  js: {
    exts: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
    style: "brace",
    top: [
      { re: /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", name: 5, container: true, pub: (m) => !!m[1] },
      { re: /^\s*(export\s+)?(default\s+)?(declare\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function", name: 5, pub: (m) => !!m[1] },
      { re: /^\s*(export\s+)?(declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", name: 3, pub: (m) => !!m[1] },
      { re: /^\s*(export\s+)?(declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(<.*>)?\s*=/, kind: "type", name: 3, pub: (m) => !!m[1] },
      { re: /^\s*(export\s+)?(declare\s+)?(const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum", name: 4, pub: (m) => !!m[1] },
      { re: /^\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(:[^=]+)?=\s*(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/, kind: "function", name: 3, pub: (m) => !!m[1], when: (l) => /=>|function\b/.test(l) },
      { re: /^\s*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "constant", name: 2, pub: () => true },
      { re: /^\s*(export\s+)?(declare\s+)?(namespace|module)\s+([\w.]+)\s*\{/, kind: "namespace", name: 4, container: true, report: false },
    ],
    member: [
      { re: /^\s*((?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*(:[^=]+)?=>/, kind: "method", name: 2, pub: (m) => !/private|protected/.test(m[1] || "") && !m[2].startsWith("#") },
      { re: /^\s*((?:public|private|protected|static|readonly|async|abstract|override|get|set|declare)\s+)*(\*\s*)?(#?[A-Za-z_$][\w$]*)\s*(<[^>(]*>)?\s*\(/, kind: "method", name: 3, pub: (m) => !/private|protected/.test(m[1] || "") && !m[3].startsWith("#") },
    ],
  },
  python: {
    exts: [".py", ".pyi"],
    style: "indent",
    rules: [
      { re: /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: "function", name: 3 },
      { re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: "class", name: 2, container: true },
    ],
    pub: (qname) => qname.split(".").every((part) => !part.startsWith("_") || /^__\w+__$/.test(part)),
  },
  ruby: {
    exts: [".rb", ".rake"],
    style: "indent",
    rules: [
      { re: /^(\s*)def\s+(self\.)?([\w?!=]+)/, kind: "function", name: 3 },
      { re: /^(\s*)(?:class|module)\s+([\w:]+)/, kind: "class", name: 2, container: true },
    ],
    pub: () => true,
  },
  go: {
    exts: [".go"],
    style: "brace",
    top: [
      { re: /^func\s+\(\s*(?:\w+\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)/, kind: "method", name: (m) => `${m[1]}.${m[2]}` },
      { re: /^func\s+([A-Za-z_]\w*)/, kind: "function", name: 1 },
      { re: /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/, kind: (m) => m[2], name: 1 },
      { re: /^type\s+([A-Za-z_]\w*)\s/, kind: "type", name: 1 },
    ],
    member: [],
    pubName: (qname) => /^[A-Z]/.test(qname.split(".").at(-1)),
  },
  rust: {
    exts: [".rs"],
    style: "brace",
    top: [
      { re: /^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:([\w:<>, ]+?)\s+for\s+)?([\w:]+)/, kind: "impl", container: true,
        name: (m) => m[2], label: (m) => (m[1] ? `${m[2]}: ${m[1].trim()}` : null), report: (m) => Boolean(m[1]), pub: () => true },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function", name: 2, pub: (m) => !!m[1] },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?(trait)\s+([A-Za-z_]\w*)/, kind: "trait", name: 3, container: true, pub: (m) => !!m[1] },
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?(struct|enum|type|union)\s+([A-Za-z_]\w*)/, kind: (m) => m[2], name: 3, pub: (m) => !!m[1] },
      { re: /^\s*(pub\s+)?mod\s+(\w+)\s*\{/, kind: "module", name: 2, container: true, report: false },
    ],
    member: [
      { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: "method", name: 2, pub: (m) => !!m[1] },
    ],
  },
  jvm: {
    exts: [".java", ".kt", ".kts", ".cs", ".scala", ".swift"],
    style: "brace",
    top: [
      { re: /^\s*namespace\s+([\w.]+)/, kind: "namespace", name: 1, container: true, report: false },
      { re: new RegExp(`^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*((?:${JVM_MODS}\\s+)*)(class|interface|enum|record|struct|object|trait|protocol|extension)\\s+([A-Za-z_]\\w*)`),
        kind: (m) => m[2], name: 3, container: true, pub: (m) => !/private|internal|fileprivate/.test(m[1]) },
      { re: new RegExp(`^\\s*((?:${JVM_MODS}\\s+)*)(?:fun|func|def)\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?([A-Za-z_]\\w*)`),
        kind: "function", name: 2, pub: (m) => !/private|internal|fileprivate/.test(m[1]) },
    ],
    member: [
      { re: new RegExp(`^\\s*((?:${JVM_MODS}\\s+)*)(?:fun|func|def)\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?([A-Za-z_]\\w*)`),
        kind: "method", name: 2, pub: (m) => !/private|internal|fileprivate/.test(m[1]) },
      { re: new RegExp(`^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*((?:${JVM_MODS}\\s+)+)(?:<[^>]+>\\s+)?[\\w<>\\[\\],.?]+(?:\\s*<[^>]*>)?\\s+([A-Za-z_]\\w*)\\s*\\(`),
        kind: "method", name: 2, pub: (m) => /public/.test(m[1]) },
      { re: new RegExp(`^\\s*((?:${JVM_MODS}\\s+)+)([A-Z]\\w*)\\s*\\(`), kind: "constructor", name: 2, pub: (m) => /public/.test(m[1]) },
    ],
  },
  php: {
    exts: [".php"],
    style: "brace",
    top: [
      { re: /^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)/, kind: (m) => m[1], name: 2, container: true, pub: () => true },
      { re: /^\s*function\s+&?\s*(\w+)\s*\(/, kind: "function", name: 1, pub: () => true },
    ],
    member: [
      { re: /^\s*((?:public|private|protected|static|abstract|final)\s+)*function\s+&?\s*(\w+)\s*\(/, kind: "method", name: 2, pub: (m) => !/private|protected/.test(m[1] || "") },
    ],
  },
};

export function langFor(p) {
  const ext = path.posix.extname(p.toLowerCase());
  for (const [id, lang] of Object.entries(LANGS)) if (lang.exts.includes(ext)) return id;
  return null;
}

const shortHash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const normalize = (lines) => lines.map((l) => l.trim()).filter(Boolean).join("\n");
export const collapse = (s) => s.replace(/\s+/g, " ").trim();

function applyRule(rule, m, line) {
  const pick = (v) => (typeof v === "function" ? v(m, line) : typeof v === "number" ? m[v] : v);
  return {
    kind: pick(rule.kind),
    name: pick(rule.name),
    label: rule.label ? rule.label(m) : null,
    container: Boolean(rule.container),
    report: rule.report === undefined ? true : typeof rule.report === "function" ? rule.report(m) : rule.report,
    pub: rule.pub ? rule.pub(m, line) : null,
  };
}

function signatureFrom(lines, i, stopRe) {
  let sig = "";
  for (let k = i; k < Math.min(lines.length, i + 8); k++) {
    sig += " " + lines[k];
    if (stopRe.test(lines[k])) break;
  }
  sig = collapse(sig);
  const arrow = sig.indexOf("=>");
  // The body brace is the first "{" after the closing paren (+ optional return type),
  // so defaults like `opts = {}` inside the parameter list survive.
  const bodyBrace = sig.match(/^(.*?\))(\s*:\s*[^{=]+?)?\s*\{/);
  if (arrow !== -1 && (sig.indexOf("{") === -1 || arrow < sig.indexOf("{"))) sig = sig.slice(0, arrow + 2);
  else if (bodyBrace) sig = bodyBrace[1] + (bodyBrace[2] || "");
  else if (sig.includes("{")) sig = sig.slice(0, sig.indexOf("{"));
  sig = sig.replace(/\s*[:;]$/, "").trim();
  return sig.length > 160 ? sig.slice(0, 157) + "..." : sig;
}

function braceDelta(line) {
  const s = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "\"\"").replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
  let d = 0;
  for (const ch of s) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

function extractBrace(text, lang) {
  const lines = text.split(/\r?\n/);
  const before = new Array(lines.length);
  const after = new Array(lines.length);
  const raw = [];
  const stack = [];
  let depth = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) { before[i] = after[i] = depth; continue; }
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const open = line.lastIndexOf("/*");
    if (open !== -1 && line.indexOf("*/", open) === -1) { inBlockComment = true; line = line.slice(0, open); }

    before[i] = depth;
    const parent = stack.at(-1);
    const inContainer = parent && depth === parent.depth + 1;
    const rules = depth === 0 ? lang.top
      : inContainer ? (parent.kind === "namespace" || parent.kind === "module" ? lang.top : [...lang.member, ...lang.top.filter((r) => r.container)])
      : [];
    for (const rule of rules) {
      const m = line.match(rule.re);
      if (!m || (rule.when && !rule.when(line))) continue;
      const sym = applyRule(rule, m, line);
      if (!sym.name || KEYWORDS.has(sym.name)) continue;
      const scope = stack.filter((c) => c.report !== false || c.kind === "impl").map((c) => c.name);
      sym.qname = [...scope, sym.name].join(".");
      if (inContainer && parent.kind !== "namespace" && parent.kind !== "module" && sym.kind === "function") sym.kind = "method";
      // Trait impl / interface members are public through the trait regardless of modifiers.
      if (inContainer && (parent.traitImpl || parent.kind === "interface" || parent.kind === "trait")) sym.pub = true;
      sym.start = i;
      raw.push(sym);
      if (sym.container) stack.push({ name: sym.name, kind: sym.kind, depth, opened: false, start: i, report: sym.report, traitImpl: sym.kind === "impl" && Boolean(sym.label) });
      break;
    }
    depth += braceDelta(line);
    after[i] = depth;
    for (const c of stack) if (depth > c.depth) c.opened = true;
    while (stack.length) {
      const top = stack.at(-1);
      if ((top.opened && depth <= top.depth) || (!top.opened && i - top.start > 4)) stack.pop();
      else break;
    }
  }

  return raw.map((sym, idx) => {
    const startDepth = before[sym.start];
    let end = lines.length - 1;
    let opened = false;
    for (let j = sym.start; j < lines.length; j++) {
      // `constructor(x) {}` opens and closes on one line.
      if (!opened && lines[j].includes("{") && after[j] <= startDepth) { end = j; break; }
      if (after[j] > startDepth) opened = true;
      if (opened && after[j] <= startDepth) { end = j; break; }
      if (!opened && /;\s*$/.test(lines[j])) { end = j; break; }
      if (!opened && j > sym.start + 8) { end = j; break; }
    }
    if (!opened && !sym.container) {
      const next = raw.slice(idx + 1).find((s) => s.start > sym.start);
      if (next && next.start - 1 < end) end = next.start - 1;
    }
    const body = lines.slice(sym.start + 1, end + 1);
    return finishSymbol(sym, lines, end, body, /[{;]|=>/);
  });
}

function extractIndent(text, lang) {
  const lines = text.split(/\r?\n/);
  const raw = [];
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of lang.rules) {
      const m = line.match(rule.re);
      if (!m) continue;
      const indent = m[1].length;
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const parent = stack.at(-1);
      // Skip functions nested inside functions: implementation detail, not API.
      if (parent && parent.kind !== "class") { stack.push({ indent, kind: "nested", name: "" }); break; }
      const sym = applyRule(rule, m, line);
      if (parent && sym.kind === "function") sym.kind = "method";
      sym.qname = [...stack.map((s) => s.name), sym.name].join(".");
      sym.start = i;
      sym.indent = indent;
      raw.push(sym);
      stack.push({ indent, kind: sym.kind === "class" ? "class" : "function", name: sym.name });
      break;
    }
  }
  return raw.map((sym) => {
    let end = lines.length - 1;
    for (let j = sym.start + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      const ind = l.match(/^\s*/)[0].length;
      if (ind <= sym.indent && !/^\s*[)\]]/.test(l)) {
        end = /^\s*end\b/.test(l) ? j : j - 1;
        break;
      }
    }
    while (end > sym.start && !lines[end].trim()) end--;
    sym.pub = lang.pub(sym.qname);
    return finishSymbol(sym, lines, end, lines.slice(sym.start + 1, end + 1), /:\s*(#.*)?$|\)\s*$/);
  });
}

function finishSymbol(sym, lines, end, body, stopRe) {
  return {
    qname: sym.qname,
    kind: sym.kind,
    label: sym.label,
    report: sym.report,
    pub: sym.pub,
    signature: signatureFrom(lines, sym.start, stopRe),
    line: sym.start + 1,
    lineCount: end - sym.start + 1,
    bodyHash: shortHash(normalize(body)),
    bodyLines: body.filter((l) => l.trim()).length,
  };
}

export function extractSymbols(text, langId) {
  if (text == null || !langId) return [];
  const lang = LANGS[langId];
  const syms = lang.style === "indent" ? extractIndent(text, lang) : extractBrace(text, lang);
  if (lang.pubName) for (const s of syms) s.pub = lang.pubName(s.qname);
  // Overloads share a name; disambiguate so they diff independently.
  const seen = new Map();
  for (const s of syms) {
    const n = (seen.get(s.qname) || 0) + 1;
    seen.set(s.qname, n);
    s.key = n === 1 ? s.qname : `${s.qname}#${n}`;
  }
  return syms;
}

function paramsOf(sig) {
  const open = sig.indexOf("(");
  if (open === -1) return null;
  const params = [];
  let depth = 0;
  let cur = "";
  for (const ch of sig.slice(open + 1)) {
    if ("([{<".includes(ch)) depth++;
    if (")]}>".includes(ch)) {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "," && depth === 0) { params.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) params.push(cur.trim());
  return params;
}

// Same leading params, extra ones all optional, same return type => callers keep working.
export function isCompatibleExtension(oldSig, newSig) {
  const o = paramsOf(oldSig);
  const n = paramsOf(newSig);
  if (!o || !n || n.length <= o.length) return false;
  if (o.some((p, i) => collapse(p) !== collapse(n[i]))) return false;
  const tail = (s) => s.slice(s.lastIndexOf(")") + 1).trim();
  if (tail(oldSig) !== tail(newSig)) return false;
  return n.slice(o.length).every((p) => /=|\?\s*:|^\*|^\.\.\./.test(p));
}

export function diffSymbols(oldSyms, newSyms) {
  const oldMap = new Map(oldSyms.map((s) => [s.key, s]));
  const newMap = new Map(newSyms.map((s) => [s.key, s]));
  let changes = [];
  for (const [key, n] of newMap) {
    const o = oldMap.get(key);
    if (!o) changes.push({ type: "added", sym: n });
    else if (collapse(o.signature) !== collapse(n.signature)) {
      changes.push({ type: "signature", sym: n, old: o, compatible: isCompatibleExtension(o.signature, n.signature) });
    } else if (o.bodyHash !== n.bodyHash) changes.push({ type: "modified", sym: n, old: o });
  }
  for (const [key, o] of oldMap) if (!newMap.has(key)) changes.push({ type: "removed", sym: o });

  // Same body, different name => rename.
  const removed = changes.filter((c) => c.type === "removed");
  for (const r of removed) {
    if (r.sym.bodyLines < 2) continue;
    const a = changes.find((c) => c.type === "added" && c.sym.kind === r.sym.kind && c.sym.bodyHash === r.sym.bodyHash);
    if (!a) continue;
    changes = changes.filter((c) => c !== r && c !== a);
    changes.push({ type: "renamed", sym: a.sym, old: r.sym });
  }

  // A class whose only change is inside a changed member is noise.
  const changedNames = changes.map((c) => c.sym.qname);
  changes = changes.filter((c) => !(c.type === "modified" && changedNames.some((q) => q.startsWith(c.sym.qname + "."))));

  // Containers that are pure scaffolding (namespaces, inherent impls) aren't reported.
  changes = changes.filter((c) => c.sym.report !== false);

  const order = { removed: 0, renamed: 1, signature: 2, added: 3, modified: 4 };
  return changes.sort((a, b) => order[a.type] - order[b.type] || a.sym.line - b.sym.line);
}
