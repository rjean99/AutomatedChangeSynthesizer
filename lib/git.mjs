// Thin wrappers around the git CLI: deciding what to compare (branch, working
// tree or staging area), listing changed files and reading both sides of each.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const MAX_ANALYZE_BYTES = 1_000_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class PrnotesError extends Error {}

export function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (allowFail) return null;
    throw new PrnotesError(`git ${args.join(" ")} failed:\n${String(err.stderr || err.message).trim()}`);
  }
}

const verify = (ref) => Boolean(git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }));

export function resolveBase(explicit) {
  const candidates = explicit ? [explicit] : ["main", "master", "origin/main", "origin/master", "origin/HEAD"];
  for (const ref of candidates) if (verify(ref)) return ref;
  throw new PrnotesError(explicit ? `base ref "${explicit}" not found` : "could not find main or master; pass --base <ref>");
}

// A "source" describes one comparison: which tree is old, how to read the new
// side, which commits belong to it and how to search the new tree.
export function resolveSource(opts) {
  if (opts.staged && opts.working) throw new PrnotesError("--staged and --working can't be combined");
  if (opts.staged) {
    const oldRef = verify("HEAD") ? "HEAD" : EMPTY_TREE;
    return {
      mode: "staged", base: "HEAD", headLabel: "staged changes", oldRef, diffArgs: ["--cached", oldRef],
      readNew: (p) => readBlob("", p), commitRange: null,
      listNew: () => splitZ(git(["ls-files", "-z", "--cached"])),
      grep: { args: ["--cached"], prefix: "" },
    };
  }
  const base = resolveBase(opts.base);
  if (!verify(opts.head)) throw new PrnotesError(`head ref "${opts.head}" not found`);
  const mergeBase = git(["merge-base", base, opts.head], { allowFail: true })?.trim();
  if (!mergeBase) throw new PrnotesError(`${base} and ${opts.head} share no history`);
  const branch = git(["rev-parse", "--abbrev-ref", opts.head]).trim();
  if (opts.working) {
    return {
      mode: "working", base, headLabel: `${branch} + working tree`, oldRef: mergeBase, diffArgs: [mergeBase],
      readNew: readWorking, commitRange: `${mergeBase}..HEAD`, untracked: true,
      listNew: () => splitZ(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])),
      grep: { args: ["--untracked"], prefix: "" },
    };
  }
  return {
    mode: "committed", base, headLabel: branch, oldRef: mergeBase, diffArgs: [mergeBase, opts.head],
    readNew: (p) => readBlob(opts.head, p), commitRange: `${mergeBase}..${opts.head}`,
    listNew: () => splitZ(git(["ls-tree", "-r", "-z", "--name-only", opts.head])),
    grep: { args: [opts.head], prefix: `${opts.head}:` },
  };
}

const splitZ = (s) => s.split("\0").filter(Boolean);

export function listOld(source) {
  return splitZ(git(["ls-tree", "-r", "-z", "--name-only", source.oldRef]));
}

export function listChanges(source) {
  const parts = splitZ(git(["diff", "-z", "-M", "--name-status", ...source.diffArgs]));
  const files = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    const code = status[0];
    if (code === "R" || code === "C") {
      files.push({ status: code, similarity: parseInt(status.slice(1), 10), oldPath: parts[i++], path: parts[i++] });
    } else {
      const p = parts[i++];
      files.push({ status: code, oldPath: code === "A" ? null : p, path: p });
    }
  }
  if (source.untracked) {
    for (const p of splitZ(git(["ls-files", "-z", "--others", "--exclude-standard"]))) {
      files.push({ status: "A", oldPath: null, path: p, untracked: true });
    }
  }
  return files;
}

export function readBlob(ref, p) {
  const out = git(["show", `${ref}:${p}`], { allowFail: true });
  if (out == null || out.length > MAX_ANALYZE_BYTES || out.includes("\0")) return null;
  return out;
}

export function readWorking(p) {
  try {
    const buf = readFileSync(p);
    if (buf.length > MAX_ANALYZE_BYTES || buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export function filePatch(f, source) {
  if (f.untracked) {
    const content = readWorking(f.path);
    if (content == null) return { patch: "", binary: true };
    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const patch = `diff --git a/${f.path} b/${f.path}\nnew file (untracked)\n--- /dev/null\n+++ b/${f.path}\n` +
      `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}\n`;
    return { patch, binary: false };
  }
  const paths = f.oldPath && f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path];
  const patch = git(["diff", "-M", "--no-color", "--no-ext-diff", "-U3", ...source.diffArgs, "--", ...paths]);
  return { patch, binary: /^Binary files /m.test(patch) || /^GIT binary patch/m.test(patch) };
}

// Added lines carry new-file line numbers, removed lines old-file line numbers,
// so changes can be mapped onto the symbols of either version.
export function parsePatch(patch) {
  const added = [];
  const removed = [];
  const hunkContexts = new Set();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      inHunk = true;
      if (h[3].trim()) hunkContexts.add(h[3].trim());
      continue;
    }
    if (!inHunk) continue;
    const text = line.slice(1).replace(/\r$/, "");
    if (line.startsWith("+")) added.push({ line: newLine++, text });
    else if (line.startsWith("-")) removed.push({ line: oldLine++, text });
    else if (line.startsWith(" ")) { oldLine++; newLine++; }
  }
  return { added, removed, hunkContexts: [...hunkContexts] };
}

export function listCommits(range) {
  if (!range) return [];
  const out = git(["log", "--no-merges", "--format=%H%x1f%h%x1f%an%x1f%s%x1f%b%x1e", range]);
  return out.split("\x1e").map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [hash, short, author, subject, body = ""] = rec.split("\x1f");
    const cc = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
    return {
      hash, short, author, subject, body: body.trim(),
      type: cc ? cc[1].toLowerCase() : null,
      scope: cc ? cc[2] || null : null,
      description: cc ? cc[4] : subject,
      breaking: Boolean(cc && cc[3]) || /^BREAKING[ -]CHANGE:/m.test(body),
      breakingNote: (body.match(/^BREAKING[ -]CHANGE:\s*(.+)$/m) || [])[1] || null,
    };
  });
}

// path -> short hashes of the commits in range that touched it.
export function commitsByFile(range) {
  const map = new Map();
  if (!range) return map;
  const out = git(["log", "--no-merges", "-M", "--format=%x1e%h", "--name-only", range]);
  for (const rec of out.split("\x1e").filter((s) => s.trim())) {
    const [short, ...paths] = rec.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const p of paths) {
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(short);
    }
  }
  return map;
}

// Literal search of the new tree; returns [{ path, line, text }].
export function grepRefs(source, literal, { word = true } = {}) {
  const args = ["grep", "-n", "-I", "-F", ...(word ? ["-w"] : []), "-e", literal, ...source.grep.args, "--"];
  const out = git(args, { allowFail: true });
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((l) => {
    const s = source.grep.prefix && l.startsWith(source.grep.prefix) ? l.slice(source.grep.prefix.length) : l;
    const m = s.match(/^(.*?):(\d+):(.*)$/);
    return m ? { path: m[1], line: Number(m[2]), text: m[3] } : null;
  }).filter(Boolean);
}
