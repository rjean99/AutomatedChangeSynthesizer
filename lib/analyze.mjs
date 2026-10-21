// Turns a git comparison into a structured analysis: per-file symbol changes,
// architectural signals (imports, coupling, routes, config), dependency
// changes, review flags, and the four changelog buckets.

import path from "node:path";
import {
  git, resolveSource, listChanges, listOld, filePatch, parsePatch, listCommits, commitsByFile, readBlob, grepRefs,
} from "./git.mjs";
import { extractSymbols, diffSymbols, langFor, collapse } from "./symbols.mjs";

export const VERSION = "2.0.0";

// ───────────────────────── file classification ─────────────────────────

const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "cargo.lock",
  "poetry.lock", "gemfile.lock", "composer.lock", "uv.lock", "pipfile.lock", "bun.lockb"]);
const MANIFESTS = new Set(["package.json", "go.mod", "cargo.toml", "pyproject.toml", "gemfile", "composer.json",
  "pom.xml", "build.gradle", "build.gradle.kts", "pipfile", "setup.py", "setup.cfg"]);

export function classify(p) {
  const lower = p.toLowerCase();
  const base = path.posix.basename(lower);
  if (/(^|\/)(\.github\/workflows|\.circleci|\.buildkite)\//.test(lower) ||
      ["jenkinsfile", ".gitlab-ci.yml", "azure-pipelines.yml"].includes(base)) return "ci";
  if (/(^|\/)(__tests__|tests?|spec|specs|testdata)\//.test(lower) || /[._-](test|spec)\.[a-z0-9]+$/.test(base) ||
      /^test_.*\.py$/.test(base) || /_test\.go$/.test(base) || /tests?\.(cs|java|kt)$/.test(base)) return "test";
  if (LOCKFILES.has(base)) return "lockfile";
  if (MANIFESTS.has(base) || /^requirements.*\.txt$/.test(base)) return "deps";
  if (/(^|\/)migrations?\//.test(lower) || /\.sql$/.test(base)) return "migration";
  if (/\.(md|mdx|rst|adoc)$/.test(base) || /(^|\/)docs?\//.test(lower) || base === "license") return "docs";
  if (/(^|\/)(dockerfile[^/]*|docker-compose[^/]*|\.env[^/]*)$/.test(lower) || /(^|\/)(terraform|helm|k8s|kubernetes|deploy|infra)\//.test(lower) ||
      /\.(tf|tfvars)$/.test(base)) return "infra";
  if (/\.(ya?ml|toml|ini|cfg|conf|properties|xml|env)$/.test(base) || base === "makefile" ||
      /^\.[\w-]+rc(\.\w+)?$/.test(base) || /\.config\.[cm]?[jt]s$/.test(base) || /^tsconfig.*\.json$/.test(base)) return "config";
  if (langFor(p)) return "source";
  if (/\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|mp3|pdf)$/.test(base)) return "asset";
  if (/\.json$/.test(base)) return "config";
  return "other";
}

export function areaOf(p) {
  const parts = p.split("/");
  if (parts.length === 1) return "(root)";
  const containers = ["src", "lib", "packages", "apps", "services", "libs", "internal", "pkg", "cmd", "modules"];
  if (containers.includes(parts[0]) && parts.length > 2) return parts.slice(0, 2).join("/");
  return parts[0];
}

// ───────────────────────── dependency manifests ─────────────────────────

function parseManifest(base, content) {
  if (content == null) return null;
  const out = {};
  try {
    if (base === "package.json" || base === "composer.json") {
      const j = JSON.parse(content);
      const sections = base === "package.json"
        ? ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
        : ["require", "require-dev"];
      for (const sec of sections) for (const [k, v] of Object.entries(j[sec] || {})) out[k] = { version: String(v), scope: sec };
      return out;
    }
    if (/^requirements.*\.txt$/.test(base)) {
      for (const line of content.split(/\r?\n/)) {
        const m = line.replace(/#.*/, "").trim().match(/^([A-Za-z0-9_.\-]+)(\[[^\]]*\])?\s*([<>=!~].*)?$/);
        if (m) out[m[1].toLowerCase()] = { version: (m[3] || "*").trim(), scope: base };
      }
      return out;
    }
    if (base === "go.mod") {
      let inBlock = false;
      for (const line of content.split(/\r?\n/)) {
        if (/^require\s*\(/.test(line)) { inBlock = true; continue; }
        if (inBlock && /^\)/.test(line)) { inBlock = false; continue; }
        const m = inBlock ? line.match(/^\s*([\w.\-\/~]+)\s+(v\S+)/) : line.match(/^require\s+([\w.\-\/~]+)\s+(v\S+)/);
        if (m) out[m[1]] = { version: m[2], scope: /indirect/.test(line) ? "indirect" : "require" };
      }
      return out;
    }
    if (base === "cargo.toml") {
      let section = null;
      for (const line of content.split(/\r?\n/)) {
        const s = line.match(/^\s*\[([^\]]+)\]/);
        if (s) { section = /(^|\.)(dev-|build-)?dependencies$/.test(s[1]) ? s[1] : null; continue; }
        if (!section) continue;
        const m = line.match(/^\s*([\w\-]+)\s*=\s*(?:"([^"]+)"|\{.*?version\s*=\s*"([^"]+)")/);
        if (m) out[m[1]] = { version: m[2] || m[3], scope: section };
      }
      return out;
    }
    if (base === "pyproject.toml") {
      let inDeps = false;
      for (const line of content.split(/\r?\n/)) {
        if (/^\s*[\w-]+\s*=\s*\[/.test(line)) inDeps = /dependencies|^\s*[\w-]+\s*=\s*\[\s*"/.test(line);
        if (inDeps) {
          for (const q of line.matchAll(/"([A-Za-z0-9_.\-]+)(\[[^\]]*\])?\s*([^";]*)/g)) out[q[1].toLowerCase()] = { version: q[3].trim() || "*", scope: "pyproject" };
          if (/\]/.test(line)) inDeps = false;
        }
      }
      return out;
    }
  } catch {
    return null;
  }
  return null;
}

function diffDeps(file, oldText, newText) {
  const base = path.posix.basename(file.path.toLowerCase());
  if (!parseManifest(base, newText ?? oldText)) return null;
  const o = parseManifest(base, oldText) || {};
  const n = parseManifest(base, newText) || {};
  const rows = [];
  for (const [name, info] of Object.entries(n)) {
    if (!o[name]) rows.push({ name, change: "added", from: null, to: info.version, scope: info.scope });
    else if (o[name].version !== info.version) rows.push({ name, change: bumpKind(o[name].version, info.version), from: o[name].version, to: info.version, scope: info.scope });
    else if (o[name].scope !== info.scope) rows.push({ name, change: "moved", from: o[name].scope, to: info.scope, scope: info.scope });
  }
  for (const [name, info] of Object.entries(o)) if (!n[name]) rows.push({ name, change: "removed", from: info.version, to: null, scope: info.scope });
  return rows.map((r) => ({ ...r, manifest: file.path }));
}

function bumpKind(from, to) {
  const v = (s) => (String(s).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/) || []).slice(1).map((x) => Number(x || 0));
  const a = v(from), b = v(to);
  if (a.length !== 3 || b.length !== 3) return "changed";
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return `${b[i] > a[i] ? "upgraded" : "downgraded"} (${["major", "minor", "patch"][i]})`;
  }
  return "changed";
}

const isRuntimeScope = (scope) => !/dev|peer|optional|indirect|build/i.test(scope);

// ───────────────────────── review flags ─────────────────────────

const LINE_FLAGS = [
  { id: "secret", label: "Possible hard-coded secret", re: /(api[_-]?key|secret|passw(?:or)?d|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'][^"'\s]{8,}["']|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i, redact: true },
  { id: "debug", label: "Debug statement", re: /\bconsole\.(log|debug)\(|^\s*debugger;?\s*$|\bpdb\.set_trace\(|\bbreakpoint\(\)|binding\.pry|\bvar_dump\(|\bdd\(/, classes: ["source"] },
  { id: "focus", label: "Focused test (.only)", re: /\b(it|describe|test)\.only\(|\bfit\(|\bfdescribe\(/, classes: ["test"] },
  { id: "skip", label: "Skipped test", re: /\b(it|describe|test)\.skip\(|@pytest\.mark\.skip|@Disabled\b|@Ignore\b|\bt\.Skip\(|\bxit\(/, classes: ["test"] },
  { id: "suppress", label: "Lint / type check suppression", re: /eslint-disable|@ts-ignore|@ts-expect-error|#\s*type:\s*ignore|#\s*noqa|\/\/\s*nolint|#\[allow\(|@SuppressWarnings/ },
  { id: "todo", label: "New TODO / FIXME", re: /\b(TODO|FIXME|XXX|HACK)\b[:\s]*(.*)/ },
];
const SENSITIVE_PATH = /(^|[\/_.-])(auth|security|crypto|password|permissions?|acl|oauth|jwt|sessions?|secrets?|tokens?)([\/_.-]|$)/i;

function lineFlags(file, added) {
  const flags = [];
  for (const { line, text } of added) {
    for (const f of LINE_FLAGS) {
      if (f.classes && !f.classes.includes(file.cls)) continue;
      const m = text.match(f.re);
      if (!m) continue;
      const detail = f.redact ? "(value redacted)" : f.id === "todo" ? collapse(m[0]).slice(0, 90) : collapse(text).slice(0, 90);
      flags.push({ id: f.id, label: f.label, path: file.path, line, detail });
    }
  }
  return flags;
}

function fileFlags(files) {
  const flags = [];
  const testPaths = files.filter((f) => f.cls === "test").map((f) => f.path.toLowerCase());
  for (const f of files) {
    if (f.cls === "migration") flags.push({ id: "migration", label: "Database migration", path: f.path, detail: f.status === "A" ? "added" : "modified" });
    if (f.cls === "ci") flags.push({ id: "ci", label: "CI pipeline change", path: f.path });
    if (f.cls === "infra") flags.push({ id: "infra", label: "Runtime environment / deployment change", path: f.path });
    if (f.cls === "source" && SENSITIVE_PATH.test(f.path)) flags.push({ id: "sensitive", label: "Touches security-sensitive code", path: f.path, detail: `+${f.insertions} −${f.deletions}` });
    if (f.insertions + f.deletions > 400 && f.cls !== "lockfile") flags.push({ id: "large", label: "Large change - consider reviewing in passes", path: f.path, detail: `+${f.insertions} −${f.deletions}` });
    if (f.cls === "source" && f.status !== "D" && f.symbols.some((c) => ["added", "signature", "modified", "renamed"].includes(c.type))) {
      const stem = path.posix.basename(f.path).replace(/\.[^.]+$/, "").toLowerCase();
      if (!testPaths.some((t) => t.includes(stem))) flags.push({ id: "untested", label: "Logic changed with no matching test change", path: f.path, detail: `no test file mentioning "${stem}" changed` });
    }
  }
  return flags;
}

// ───────────────────────── content signals ─────────────────────────

function testCasesFrom(added) {
  const names = [];
  for (const { text } of added) {
    for (const m of text.matchAll(/\b(?:it|test|describe)(?:\.\w+)?\(\s*(["'`])(.+?)\1/g)) names.push(m[2]);
    const py = text.match(/^\s*(?:async\s+)?def\s+(test_\w+)/);
    const go = text.match(/^func\s+(Test\w+)\s*\(/);
    const jvm = text.match(/^\s*(?:public\s+)?(?:void|fun)\s+(\w+)\s*\(/);
    if (py) names.push(py[1]);
    if (go) names.push(go[1]);
    if (jvm && /test/i.test(jvm[1])) names.push(jvm[1]);
  }
  return [...new Set(names)];
}

const SQL_RE = /^(CREATE|ALTER|DROP|RENAME|TRUNCATE|INSERT|UPDATE|DELETE)\b/i;
const DESTRUCTIVE_SQL = /\bDROP\s+(TABLE|COLUMN|INDEX|SCHEMA|VIEW)\b|\bRENAME\s+(COLUMN|TO)\b|\bALTER\s+COLUMN\b.*\b(TYPE|SET\s+NOT\s+NULL)\b|\bTRUNCATE\b/i;

const ROUTE_RES = [
  { re: /\b(?:app|router|server|api|routes?|r)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/i, m: 1, p: 2 },
  { re: /@\w+\.(get|post|put|patch|delete|route)\(\s*["']([^"']+)["']/, m: 1, p: 2 },
  { re: /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']/, m: 1, p: 2 },
  { re: /\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/, m: 1, p: 2 },
  { re: /\[Http(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"\s*\)\]/, m: 1, p: 2 },
];

function routesIn(lines) {
  const out = [];
  for (const { text } of lines) {
    for (const r of ROUTE_RES) {
      const m = text.match(r.re);
      if (!m) continue;
      let method = m[r.m].toUpperCase();
      if (["ROUTE", "REQUEST", "HANDLEFUNC", "HANDLE", "ALL"].includes(method)) method = "ANY";
      out.push(`${method} ${m[r.p]}`);
      break;
    }
  }
  return out;
}

const ENV_RE = /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]|os\.environ(?:\.get)?[\[(]\s*["']([A-Z_][A-Z0-9_]*)["']|os\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']|os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"|System\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"|Environment\.GetEnvironmentVariable\(\s*"([A-Z_]\w*)"|env::var\(\s*"([A-Z_]\w*)"|ENV\[\s*["']([A-Z_]\w*)["']\s*\]|import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;

function envVarsIn(lines, file) {
  const out = new Set();
  const isEnvTemplate = /(^|\/)\.env(\.[\w-]+)?$/.test(file.path) || /\.env\.(example|sample|template)$/.test(file.path);
  for (const { text } of lines) {
    for (const m of text.matchAll(ENV_RE)) out.add(m.slice(1).find(Boolean));
    if (isEnvTemplate) {
      const kv = text.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
      if (kv) out.add(kv[1]);
    }
  }
  return out;
}

// ───────────────────────── imports & coupling ─────────────────────────

const PY_STDLIB = new Set(("abc argparse array ast asyncio base64 bisect builtins calendar collections concurrent contextlib copy csv " +
  "ctypes dataclasses datetime decimal difflib email enum errno fnmatch fractions functools gc getpass glob gzip hashlib heapq " +
  "hmac html http importlib inspect io ipaddress itertools json logging math mimetypes multiprocessing numbers operator os " +
  "pathlib pickle platform pprint queue random re secrets select shlex shutil signal socket sqlite3 ssl stat statistics string " +
  "struct subprocess sys tarfile tempfile textwrap threading time timeit tomllib traceback types typing unicodedata unittest " +
  "urllib uuid warnings weakref xml zipfile zlib zoneinfo __future__").split(" "));
const NODE_BUILTINS = new Set(("assert async_hooks buffer child_process cluster console crypto dgram dns events fs http http2 https " +
  "module net os path perf_hooks process querystring readline stream string_decoder timers tls tty url util v8 vm " +
  "worker_threads zlib").split(" "));

const IMPORT_RES = {
  js: [/^\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/, /^\s*\}\s*from\s+["']([^"']+)["']/,
    /^\s*export\s+[\w*{}\s,$]+\s+from\s+["']([^"']+)["']/, /\brequire\(\s*["']([^"']+)["']\s*\)/, /\bimport\(\s*["']([^"']+)["']\s*\)/],
  python: [/^\s*from\s+(\.*[\w.]*)\s+import\b/, /^\s*import\s+([\w.]+)/],
  rust: [/^\s*(?:pub\s+)?use\s+([\w:]+)/, /^\s*extern\s+crate\s+(\w+)/],
  jvm: [/^\s*import\s+(?:static\s+)?([\w.]+)/, /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/],
  php: [/^\s*use\s+([\w\\]+)/, /\b(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/],
  ruby: [/^\s*require(?:_relative)?\s+["']([^"']+)["']/],
};

function importSpecs(text, lang) {
  const specs = new Set();
  if (text == null) return specs;
  if (lang === "go") {
    let inBlock = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^import\s*\(/.test(line)) { inBlock = true; continue; }
      if (inBlock && /^\)/.test(line)) { inBlock = false; continue; }
      const m = inBlock ? line.match(/^\s*(?:[\w.]+\s+)?"([^"]+)"/) : line.match(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/);
      if (m) specs.add(m[1]);
    }
    return specs;
  }
  const res = IMPORT_RES[lang] || [];
  for (const line of text.split(/\r?\n/)) {
    for (const re of res) {
      const m = line.match(re);
      if (m) { specs.add(lang === "ruby" && /require_relative/.test(line) ? `./${m[1]}` : m[1]); break; }
    }
  }
  return specs;
}

// Resolve an import specifier to { kind: internal|external|stdlib, target }.
// For internal imports `target` is the module (area) being depended on.
function resolveImport(spec, file, lang, ctx) {
  const findFile = (base, exts) => {
    for (const e of exts) if (ctx.files.has(base + e)) return base + e;
    return null;
  };
  const internalArea = (p) => ({ kind: "internal", target: areaOf(p) });
  const dir = path.posix.dirname(file.path);

  if (lang === "js") {
    let rel = null;
    if (spec.startsWith(".")) rel = path.posix.normalize(path.posix.join(dir, spec));
    else if (/^[@~]\//.test(spec)) rel = path.posix.normalize(`src/${spec.slice(2)}`);
    if (rel) {
      const hit = findFile(rel, ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js", "/index.tsx"]);
      return internalArea(hit || `${rel}/index`);
    }
    if (spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0])) return { kind: "stdlib", target: spec };
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    return { kind: "external", target: pkg };
  }
  if (lang === "python") {
    if (spec.startsWith(".")) {
      const dots = spec.match(/^\.+/)[0].length;
      let base = dir;
      for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
      const rest = spec.slice(dots).replace(/\./g, "/");
      const p = rest ? `${base}/${rest}` : base;
      return internalArea(findFile(p, [".py", "/__init__.py"]) || `${p}/__init__.py`);
    }
    const top = spec.split(".")[0];
    if (PY_STDLIB.has(top)) return { kind: "stdlib", target: top };
    const asPath = spec.replace(/\./g, "/");
    for (const prefix of ["", "src/"]) {
      const hit = findFile(prefix + asPath, [".py", "/__init__.py"]) || findFile(prefix + top, [".py", "/__init__.py"]);
      if (hit) return internalArea(hit);
    }
    return { kind: "external", target: top };
  }
  if (lang === "go") {
    if (ctx.goModule && spec.startsWith(ctx.goModule + "/")) return internalArea(`${spec.slice(ctx.goModule.length + 1)}/x.go`);
    if (!spec.split("/")[0].includes(".")) return { kind: "stdlib", target: spec };
    return { kind: "external", target: spec.split("/").slice(0, 3).join("/") };
  }
  if (lang === "rust") {
    const [head, second] = spec.split("::");
    if (head === "crate") return internalArea(findFile(`src/${second}`, [".rs", "/mod.rs"]) || `src/${second}/mod.rs`);
    if (head === "super" || head === "self") return { kind: "internal", target: file.area };
    if (["std", "core", "alloc"].includes(head)) return { kind: "stdlib", target: head };
    return { kind: "external", target: head };
  }
  if (lang === "jvm") {
    if (/^(java|javax|kotlin|scala|System|Microsoft|android)\b/.test(spec)) return { kind: "stdlib", target: spec.split(".")[0] };
    if (ctx.ownPackage && spec.startsWith(ctx.ownPackage)) {
      const tail = spec.replace(/\./g, "/");
      const hit = [...ctx.files].find((f) => /\.(java|kt|cs|scala)$/.test(f) && f.replace(/\.[^.]+$/, "").endsWith(tail));
      return hit ? internalArea(hit) : { kind: "internal", target: spec.split(".").slice(0, 3).join(".") };
    }
    return { kind: "external", target: spec.split(".").slice(0, 2).join(".") };
  }
  if (spec.startsWith(".")) return internalArea(path.posix.normalize(path.posix.join(dir, spec)));
  return { kind: "external", target: lang === "php" ? spec.split("\\").slice(0, 2).join("\\") : spec.split("/")[0] };
}

function fileImports(file, oldText, newText, ctx) {
  const lang = file.lang;
  if (!IMPORT_RES[lang] && lang !== "go") return { added: [], removed: [] };
  const fileCtx = { ...ctx, ownPackage: ((newText || oldText || "").match(/^\s*(?:package|namespace)\s+([\w.]+)/m) || [])[1]?.split(".").slice(0, 2).join(".") };
  const o = importSpecs(oldText, lang);
  const n = importSpecs(newText, lang);
  const resolve = (spec) => ({ spec, ...resolveImport(spec, file, lang, fileCtx) });
  return {
    added: [...n].filter((s) => !o.has(s)).map(resolve),
    removed: [...o].filter((s) => !n.has(s)).map(resolve),
  };
}

// ───────────────────────── body-level change hints ─────────────────────────

const NOT_CALLS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "def", "fn", "func", "elif",
  "match", "with", "sizeof", "typeof", "super", "await", "yield", "assert", "print", "lambda", "not", "and", "or", "in", "foreach", "using", "lock"]);
const GUARD_RE = /^\s*(if|unless|guard)\b.*\b(return|throw|raise|panic!?|continue|break)\b|^\s*(return|raise|throw)\b.*\bif\b/;
const ERR_RE = /\b(try|catch|except|rescue|throw|raise|panic!?|errors\.New|fmt\.Errorf|reject)\b|\bif\s+err\s*!=\s*nil|\bErr\(/;
const CONC_RE = /\b(Mutex|RWMutex|RLock|RUnlock|Lock|Unlock|synchronized|Semaphore|Atomic\w*|asyncio\.Lock|Promise\.all|WaitGroup|chan)\b|\bgo\s+\w+\(/;

function callsIn(lines, selfName, hashComments) {
  const out = new Set();
  for (const raw of lines) {
    let code = raw.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "\"\"").replace(/\/\/.*$/, "");
    if (hashComments) code = code.replace(/#.*$/, "");
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*)\s*\(/g)) {
      const name = m[1];
      const leaf = name.split(/\.|::|->/).at(-1);
      if (NOT_CALLS.has(leaf) || leaf === selfName) continue;
      if (/(function|def|fn|func|class|new)\s+$/.test(code.slice(Math.max(0, m.index - 10), m.index))) continue;
      out.add(name);
    }
  }
  return out;
}

function describeBodyChange(change, oldLines, newLines, parsed, lang) {
  const sym = change.sym;
  const old = change.old;
  const inRange = (l, s) => l.line >= s.line && l.line < s.line + s.lineCount;
  const hash = lang === "python" || lang === "ruby";
  const leaf = sym.qname.split(".").at(-1);
  const addedIn = parsed.added.filter((l) => inRange(l, sym)).map((l) => l.text);
  const removedIn = old ? parsed.removed.filter((l) => inRange(l, old)).map((l) => l.text) : [];
  const newBody = newLines.slice(sym.line, sym.line - 1 + sym.lineCount);
  const oldBody = old ? oldLines.slice(old.line, old.line - 1 + old.lineCount) : [];
  const oldCalls = callsIn(oldBody, leaf, hash);
  const newCalls = callsIn(newBody, leaf, hash);
  const gained = [...callsIn(addedIn, leaf, hash)].filter((c) => !oldCalls.has(c));
  const lost = [...callsIn(removedIn, leaf, hash)].filter((c) => !newCalls.has(c));
  const traits = [];
  const pyGuard = addedIn.some((l, i) => /^\s*if\b.*:\s*$/.test(l) && /^\s*(return|raise)\b/.test(addedIn[i + 1] || ""));
  if (old && (addedIn.some((l) => GUARD_RE.test(l)) || pyGuard)) traits.push("adds guard clause");
  if (addedIn.some((l) => ERR_RE.test(l)) && !removedIn.some((l) => ERR_RE.test(l))) traits.push(old ? "adds error handling" : "handles errors");
  if (addedIn.some((l) => CONC_RE.test(l)) && !removedIn.some((l) => CONC_RE.test(l))) traits.push(old ? "adds concurrency control" : "uses concurrency primitives");
  const parts = [];
  if (gained.length) parts.push(`${old ? "now calls" : "uses"} ${gained.slice(0, 5).map((c) => `\`${c}\``).join(", ")}${gained.length > 5 ? " ..." : ""}`);
  if (lost.length) parts.push(`no longer calls ${lost.slice(0, 5).map((c) => `\`${c}\``).join(", ")}${lost.length > 5 ? " ..." : ""}`);
  parts.push(...traits);
  return parts.join("; ") || null;
}

// ───────────────────────── cross-file relationships ─────────────────────────

// A symbol removed from one file and added to another under the same name is a
// move; prefer an identical body, otherwise report it as moved-and-modified.
function linkCrossFileMoves(files) {
  const removed = files.flatMap((f) => f.symbols.filter((c) => c.type === "removed").map((c) => ({ f, c })));
  const leaf = (q) => q.split(".").at(-1);
  for (const { f: rf, c: rc } of removed) {
    const candidates = files.filter((af) => af !== rf).flatMap((af) => af.symbols
      .filter((c) => c.type === "added" && leaf(c.sym.qname) === leaf(rc.sym.qname) && c.sym.kind === rc.sym.kind)
      .map((c) => ({ af, ac: c })));
    const match = candidates.find(({ ac }) => ac.sym.bodyHash === rc.sym.bodyHash) || (candidates.length === 1 ? candidates[0] : null);
    if (!match) continue;
    const { af, ac } = match;
    ac.type = "moved";
    ac.from = rf.path;
    ac.old = rc.sym;
    ac.edited = ac.sym.bodyHash !== rc.sym.bodyHash || collapse(ac.sym.signature) !== collapse(rc.sym.signature);
    rc.type = "moved-out";
    rc.to = af.path;
    rc.edited = ac.edited;
  }
}

const NOISY_NAMES = new Set(["get", "set", "run", "new", "init", "main", "call", "apply", "len", "map", "add", "put", "default", "toString"]);

// For API-breaking symbol changes, find what in the new tree still refers to the old shape.
function referencesFor(source, c, filePath) {
  const name = c.type === "renamed" ? c.old.qname.split(".").at(-1) : c.sym.qname.split(".").at(-1);
  if (name.length < 3 || NOISY_NAMES.has(name) || /^__\w+__$/.test(name)) return null;
  const isMember = /\./.test(c.sym.qname) && c.sym.kind !== "class";
  const hits = (isMember ? grepRefs(source, `.${name}(`, { word: false }) : grepRefs(source, name))
    .filter((h) => !(c.type !== "renamed" && c.type !== "removed" && h.path === (c.type === "moved-out" ? c.to : filePath) && h.line === c.sym.line));
  const defLine = (h) => new RegExp(`(function|def|fn|func|class|const|let|var)\\s+${name}\\b`).test(h.text);
  const uses = hits.filter((h) => !defLine(h));
  return { name, member: isMember, count: uses.length, files: [...new Set(uses.map((h) => h.path))], sample: uses.slice(0, 5).map((h) => `${h.path}:${h.line}`) };
}

// ───────────────────────── architecture summary ─────────────────────────

function architecture(files, oldList, newList, totals) {
  const oldAreas = new Set(oldList.map(areaOf));
  const newAreas = new Set(newList.map(areaOf));
  const touched = [...new Set(files.map((f) => f.area))];
  const codeAreas = [...new Set(files.filter((f) => f.cls === "source").map((f) => f.area))];
  const coupling = new Map();
  const externals = new Map();
  for (const f of files) {
    for (const [dir, list] of [["added", f.imports.added], ["removed", f.imports.removed]]) {
      for (const imp of list) {
        if (imp.kind === "internal" && imp.target !== f.area) {
          const key = `${dir}|${f.area}|${imp.target}`;
          if (!coupling.has(key)) coupling.set(key, { change: dir, from: f.area, to: imp.target, files: new Set() });
          coupling.get(key).files.add(f.path);
        }
        if (imp.kind === "external") {
          const key = `${dir}|${imp.target}`;
          if (!externals.has(key)) externals.set(key, { change: dir, pkg: imp.target, files: new Set() });
          externals.get(key).files.add(f.path);
        }
      }
    }
  }
  const api = new Map();
  for (const f of files) {
    if (f.cls !== "source") continue;
    for (const c of f.symbols) {
      const pub = c.old ? c.old.pub : c.sym.pub;
      if (!pub) continue;
      const entry = api.get(f.area) || { added: 0, removed: 0, changed: 0 };
      if (c.type === "added") entry.added++;
      else if (c.type === "removed") entry.removed++;
      else if (["signature", "renamed"].includes(c.type)) entry.changed++;
      else continue;
      api.set(f.area, entry);
    }
  }
  const churn = new Map();
  for (const f of files) if (f.cls !== "lockfile") churn.set(f.area, (churn.get(f.area) || 0) + f.insertions + f.deletions);
  const churnTotal = [...churn.values()].reduce((a, b) => a + b, 0) || 1;
  const listify = (m) => [...m.values()].map((v) => ({ ...v, files: [...v.files] }));
  // An edge that appears as both added and removed (e.g. a moved import) is noise.
  const edges = listify(coupling).filter((e) => !coupling.has(`${e.change === "added" ? "removed" : "added"}|${e.from}|${e.to}`));
  const ext = listify(externals).filter((e) => !externals.has(`${e.change === "added" ? "removed" : "added"}|${e.pkg}`));
  return {
    modulesTouched: touched.length,
    // Only code areas count as modules; a first CI file or migration isn't architecture.
    newModules: codeAreas.filter((a) => !oldAreas.has(a) && newAreas.has(a) && a !== "(root)"),
    removedModules: codeAreas.filter((a) => oldAreas.has(a) && !newAreas.has(a)),
    coupling: edges,
    externals: ext,
    publicApi: [...api].map(([area, v]) => ({ area, ...v })),
    hotspots: [...churn].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([area, n]) => ({ area, lines: n, share: Math.round((n / churnTotal) * 100) })),
  };
}

// ───────────────────────── buckets ─────────────────────────

const COMMIT_BUCKET = { feat: "features", fix: "fixes", perf: "fixes", refactor: "fixes", revert: "fixes", style: "fixes",
  build: "infra", ci: "infra", chore: "infra", deps: "infra", docs: "quality", test: "quality" };

const ref = (s) => (String(s).includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``);

function attribution(file, commitsByShort) {
  const types = new Set((file.commits || []).map((h) => commitsByShort.get(h)?.type).filter(Boolean));
  if (types.has("feat") && !types.has("fix")) return "feat";
  if ((types.has("fix") || types.has("refactor") || types.has("perf")) && !types.has("feat")) return "fix";
  return null;
}

function buildBuckets(a, source) {
  const buckets = { breaking: [], features: [], fixes: [], infra: [], quality: [] };
  const push = (bucket, item) => buckets[bucket].push({ area: item.path ? areaOf(item.path) : null, ...item });
  const commitsByShort = new Map(a.commits.map((c) => [c.short, c]));

  for (const f of a.files) {
    const attr = attribution(f, commitsByShort);
    if (f.cls === "source") {
      if (f.status === "D") push("breaking", { text: `Removed source file ${ref(f.path)}`, path: f.path, kind: "architectural" });
      for (const c of f.symbols) {
        const pub = c.old ? c.old.pub : c.sym.pub;
        const k = c.sym.kind;
        const name = ref(c.sym.label || c.sym.qname);
        const base = { path: f.path, hint: c.hint || null };
        switch (c.type) {
          case "removed":
            if (f.status === "D") break;
            push(pub ? "breaking" : "fixes", { ...base, text: `Removed ${pub ? "public" : "internal"} ${k} ${name}`, refs: c.refs, kind: "api" });
            break;
          case "moved-out":
            push(pub ? "breaking" : "fixes", { ...base, text: `${pub ? "Public" : "Internal"} ${k} ${name} moved to ${ref(c.to)}${c.edited ? " and modified" : ""}`, refs: c.refs, kind: "architectural" });
            break;
          case "renamed":
            push(pub ? "breaking" : "fixes", { ...base, text: `Renamed ${pub ? "public" : "internal"} ${k} ${ref(c.old.qname)} → ${name}`, refs: c.refs, kind: "api" });
            break;
          case "signature":
            if (c.compatible) push(attr === "fix" ? "fixes" : "features", { ...base, text: `${name} gained optional parameter(s): ${ref(c.sym.signature)}` });
            else push(pub ? "breaking" : "fixes", { ...base, text: `Signature of ${pub ? "public" : "internal"} ${k} ${name} changed: ${ref(c.old.signature)} → ${ref(c.sym.signature)}`, refs: c.refs, kind: "api" });
            break;
          case "added":
            if (pub) push(attr === "fix" ? "fixes" : "features", { ...base, text: `New ${k} ${name}: ${ref(c.sym.signature)}` });
            else push(attr === "feat" ? "features" : "fixes", { ...base, text: `New internal ${k} ${name}` });
            break;
          case "modified": {
            const what = ["class", "interface", "type", "struct", "enum", "trait", "record", "object"].includes(k) ? "definition" : attr === "feat" ? "behavior" : "implementation";
            push(attr === "feat" ? "features" : "fixes", { ...base, text: `${attr === "feat" ? "Updated" : "Changed"} ${what} of ${k} ${name}` });
            break;
          }
          default:
            break; // incoming side of a move is described on the moved-out item
        }
      }
      if (f.status === "A" && !f.symbols.length) push(attr === "fix" ? "fixes" : "features", { text: `New file ${ref(f.path)}`, path: f.path });
      if (f.status === "M" && !f.symbols.length && f.insertions + f.deletions > 0) {
        push(attr === "feat" ? "features" : "fixes", { text: `Edited ${ref(f.path)}${f.hunkContexts.length ? ` in ${f.hunkContexts.slice(0, 3).map(ref).join(", ")}` : ""}`, path: f.path });
      }
    } else if (f.cls === "test") {
      const what = f.testCases.length ? `: ${f.testCases.slice(0, 6).map(ref).join(", ")}${f.testCases.length > 6 ? " ..." : ""}` : "";
      push("quality", { text: `${f.status === "A" ? "New tests" : f.status === "D" ? "Removed tests" : "Updated tests"} in ${ref(f.path)}${what}`, path: f.path });
    } else if (f.cls === "docs") {
      push("quality", { text: `Documentation ${f.status === "A" ? "added" : f.status === "D" ? "removed" : "updated"}: ${ref(f.path)}`, path: f.path });
    } else if (f.cls === "migration") {
      const destructive = f.sqlStatements.filter((s) => DESTRUCTIVE_SQL.test(s));
      for (const s of destructive) push("breaking", { text: `Destructive schema change in ${ref(f.path)}: ${ref(s)}`, path: f.path, kind: "data" });
      push("infra", { text: `Database migration ${ref(f.path)}${f.sqlStatements.length ? `: ${f.sqlStatements.slice(0, 3).map(ref).join("; ")}` : ""}`, path: f.path });
    } else if (f.cls === "ci") {
      push("infra", { text: `CI pipeline ${f.status === "A" ? "added" : f.status === "D" ? "removed" : "changed"}: ${ref(f.path)}`, path: f.path });
    } else if (f.cls === "infra") {
      push("infra", { text: `Deployment / runtime environment ${f.status === "A" ? "added" : f.status === "D" ? "removed" : "changed"}: ${ref(f.path)}`, path: f.path });
    } else if (f.cls === "config") {
      push("infra", { text: `Configuration ${f.status === "A" ? "added" : f.status === "D" ? "removed" : "changed"}: ${ref(f.path)}`, path: f.path });
    } else if (f.cls === "deps" && !a.deps.some((d) => d.manifest === f.path)) {
      push("infra", { text: `Build / dependency manifest changed: ${ref(f.path)}`, path: f.path });
    } else if (f.cls === "other" || f.cls === "asset") {
      push("infra", { text: `${f.cls === "asset" ? "Asset" : "File"} ${f.status === "A" ? "added" : f.status === "D" ? "removed" : "changed"}: ${ref(f.path)}`, path: f.path });
    }
  }

  for (const d of a.deps) {
    const range = d.from && d.to ? `${ref(d.from)} → ${ref(d.to)}` : ref(d.to || d.from);
    push("infra", { text: `Dependency ${ref(d.name)} ${d.change} ${range} (${d.scope})`, path: d.manifest });
    if (/major/.test(d.change) && /upgraded/.test(d.change) && isRuntimeScope(d.scope)) {
      push("breaking", { text: `Major upgrade of runtime dependency ${ref(d.name)} ${range}; review its migration notes`, path: d.manifest, kind: "dependency" });
    }
  }
  const locks = a.files.filter((f) => f.cls === "lockfile");
  if (locks.length) push("infra", { text: `Lockfiles regenerated: ${locks.map((f) => ref(f.path)).join(", ")}` });

  for (const r of a.routes.added) push("features", { text: `New endpoint ${ref(r.route)}`, path: r.path });
  for (const r of a.routes.removed) push("breaking", { text: `Removed endpoint ${ref(r.route)}`, path: r.path, kind: "api" });
  for (const e of a.envVars.added) push("infra", { text: `New configuration read: environment variable ${ref(e.name)}`, path: e.path });
  for (const e of a.envVars.removed) push("infra", { text: `Environment variable ${ref(e.name)} no longer read`, path: e.path });

  for (const m of a.architecture.removedModules) push("breaking", { text: `Module ${ref(m)} removed entirely`, kind: "architectural" });
  for (const c of a.commits) if (c.breaking) push("breaking", { text: `${c.breakingNote || c.description} (declared in ${ref(c.short)})`, kind: "declared" });

  // Commits back up the code-derived entries as "related commits" per bucket.
  const related = { breaking: [], features: [], fixes: [], infra: [], quality: [] };
  for (const c of a.commits) {
    const bucket = COMMIT_BUCKET[c.type] || null;
    if (bucket) related[bucket].push(c);
  }
  return { ...buckets, related };
}

// ───────────────────────── main entry ─────────────────────────

export function analyze(opts) {
  const repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
  process.chdir(repoRoot);
  const source = resolveSource(opts);
  const commits = listCommits(source.commitRange);
  const touchedBy = commitsByFile(source.commitRange);
  const changes = listChanges(source);
  const newList = source.listNew();
  const oldList = listOld(source);
  const goMod = source.readNew("go.mod");
  const ctx = { files: new Set(newList), goModule: goMod ? (goMod.match(/^module\s+(\S+)/m) || [])[1] : null };

  const files = [];
  const deps = [];
  const flags = [];
  const routeAdds = [];
  const routeRemoves = [];
  const envAdds = [];
  const envRemoves = [];
  for (const f of changes) {
    const file = { ...f, cls: classify(f.path), area: areaOf(f.path), lang: langFor(f.path), commits: touchedBy.get(f.path) || [] };
    const { patch, binary } = filePatch(f, source);
    file.binary = binary;
    file.patch = patch;
    const parsed = binary ? { added: [], removed: [], hunkContexts: [] } : parsePatch(patch);
    file.insertions = parsed.added.length;
    file.deletions = parsed.removed.length;
    file.hunkContexts = parsed.hunkContexts;

    const oldText = f.oldPath && !binary ? readBlob(source.oldRef, f.oldPath) : null;
    const newText = f.status === "D" || binary ? null : source.readNew(f.path);
    const analyzable = file.lang && (file.cls === "source" || file.cls === "test");

    file.symbols = analyzable ? diffSymbols(extractSymbols(oldText, file.lang), extractSymbols(newText, file.lang)) : [];
    if (file.symbols.length) {
      const oldLines = (oldText || "").split(/\r?\n/);
      const newLines = (newText || "").split(/\r?\n/);
      for (const c of file.symbols) {
        if (["modified", "signature", "added", "renamed"].includes(c.type)) c.hint = describeBodyChange(c, oldLines, newLines, parsed, file.lang);
      }
    }
    file.imports = analyzable ? fileImports(file, oldText, newText, ctx) : { added: [], removed: [] };
    file.testCases = file.cls === "test" ? testCasesFrom(parsed.added) : [];
    file.sqlStatements = file.cls === "migration"
      ? parsed.added.map((l) => collapse(l.text)).filter((t) => SQL_RE.test(t)).map((t) => (t.length > 120 ? t.slice(0, 117) + "..." : t))
      : [];
    if (file.cls === "deps") {
      const rows = diffDeps(f, oldText, newText);
      if (rows) deps.push(...rows);
    }
    if (file.cls === "source") {
      routeAdds.push(...routesIn(parsed.added).map((route) => ({ route, path: f.path })));
      routeRemoves.push(...routesIn(parsed.removed).map((route) => ({ route, path: f.path })));
    }
    if (file.cls !== "test" && file.cls !== "docs") {
      envAdds.push(...[...envVarsIn(parsed.added, file)].map((name) => ({ name, path: f.path })));
      envRemoves.push(...[...envVarsIn(parsed.removed, file)].map((name) => ({ name, path: f.path })));
    }
    if (!binary) flags.push(...lineFlags(file, parsed.added));
    files.push(file);
  }

  linkCrossFileMoves(files);
  for (const f of files) {
    if (f.cls !== "source") continue;
    for (const c of f.symbols) {
      const pub = c.old ? c.old.pub : c.sym.pub;
      const apiBreak = c.type === "removed" || c.type === "renamed" || c.type === "moved-out" || (c.type === "signature" && !c.compatible);
      if (pub && apiBreak && f.status !== "D") c.refs = referencesFor(source, c, f.path);
    }
  }
  flags.push(...fileFlags(files));

  // Reconcile across files so a route or env var that merely moved doesn't count.
  const keyed = (list, key) => new Set(list.map((x) => x[key]));
  const uniq = (list, key) => [...new Map(list.map((x) => [x[key], x])).values()];
  const routes = {
    added: uniq(routeAdds.filter((r) => !keyed(routeRemoves, "route").has(r.route)), "route"),
    removed: uniq(routeRemoves.filter((r) => !keyed(routeAdds, "route").has(r.route)), "route"),
  };
  const envVars = {
    added: uniq(envAdds.filter((e) => !keyed(envRemoves, "name").has(e.name)), "name"),
    removed: uniq(envRemoves.filter((e) => !keyed(envAdds, "name").has(e.name)), "name"),
  };

  const totals = {
    files: files.length,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    byClass: files.reduce((acc, f) => ({ ...acc, [f.cls]: (acc[f.cls] || 0) + 1 }), {}),
  };
  const analysis = {
    tool: { name: "prnotes", version: VERSION },
    generatedAt: new Date().toISOString(),
    repo: path.basename(repoRoot),
    mode: source.mode, base: source.base, branch: source.headLabel,
    head: source.mode === "committed" ? git(["rev-parse", "--short", opts.head]).trim() : null,
    mergeBase: source.oldRef.slice(0, 10),
    commits, files, deps, flags, routes, envVars, totals,
  };
  analysis.architecture = architecture(files, oldList, newList, totals);
  analysis.buckets = buildBuckets(analysis, source);
  return analysis;
}
