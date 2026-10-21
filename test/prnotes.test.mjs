import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo } from "./fixture.mjs";
import { extractSymbols, diffSymbols, isCompatibleExtension } from "../lib/symbols.mjs";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/prnotes.mjs");
let repo;

const cli = (...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: "utf8", env: { ...process.env, PRNOTES_AI: "" } });
  assert.equal(r.status, 0, `prnotes ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
};
const section = (md, title) => {
  const start = md.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `missing section ${title}`);
  const next = md.indexOf("\n## ", start + 3);
  return md.slice(start, next === -1 ? undefined : next);
};

before(() => { repo = makeRepo(); });
after(() => repo.cleanup());

test("PR output has the four required buckets", () => {
  const md = cli();
  for (const t of ["⚠️ Breaking Changes", "✨ Features & Functional Updates", "🐛 Bug Fixes & Refactoring", "📦 Dependency Updates & Infrastructure Changes"]) {
    assert.ok(md.includes(`## ${t}`), t);
  }
});

test("breaking changes come from code, routes, schema and declared commits", () => {
  const b = section(cli(), "⚠️ Breaking Changes");
  assert.match(b, /Removed public function `legacyLogin`/);
  assert.match(b, /Renamed public function `hashToken` → `reverseToken`/);
  assert.match(b, /Removed endpoint `POST \/login`/);
  assert.match(b, /Destructive schema change.*DROP COLUMN legacy_token/);
  assert.match(b, /Major upgrade of runtime dependency `express`/);
  assert.match(b, /Public function `format_currency` moved to `src\/billing\/fmt.py` and modified/);
  assert.match(b, /POST \/login removed/);
  // Compatible extensions are not breaking.
  assert.doesNotMatch(b, /SessionManager\.create/);
  assert.doesNotMatch(b, /Invoice\.__init__/);
});

test("features and fixes are explained from the diff, not just commit messages", () => {
  const md = cli();
  const f = section(md, "✨ Features & Functional Updates");
  assert.match(f, /New method `SessionManager.refresh`/);
  assert.match(f, /New endpoint `POST \/sessions\/refresh`/);
  assert.match(f, /`SessionManager.create` gained optional parameter/);
  assert.doesNotMatch(md, /SessionManager\.constructor/, "one-line constructor body must not absorb the next method");
  const x = section(md, "🐛 Bug Fixes & Refactoring");
  assert.match(x, /Changed implementation of method `Store.Get`/);
  assert.match(x, /now calls `s.mu.RLock`.*adds concurrency control/);
  assert.match(x, /Related commits:.*make Store safe/);
});

test("infrastructure bucket covers deps, migrations, CI and config", () => {
  const i = section(cli(), "📦 Dependency Updates & Infrastructure Changes");
  assert.match(i, /`express` upgraded \(major\)/);
  assert.match(i, /`zod` added/);
  assert.match(i, /`lodash` removed/);
  assert.match(i, /Database migration `db\/migrations\/0002_sessions.sql`/);
  assert.match(i, /CI pipeline added/);
  assert.match(i, /environment variable `SESSION_TTL_MS`/);
});

test("architecture section reports coupling, new modules and API surface", () => {
  const a = section(cli(), "🏗️ Architecture impact");
  assert.match(a, /New dependency:\*\* `src\/auth` → `src\/util`/);
  assert.match(a, /New modules:\*\* `src\/util`/);
  assert.match(a, /Public API surface/);
});

test("staged mode only reports the index", () => {
  repo.write("src/util/ids.ts", "export function newId(): string {\n  return crypto.randomUUID();\n}\n\nexport function shortId(): string {\n  return newId().slice(0, 8);\n}\n");
  repo.write("src/auth/session.ts", readFileSync(path.join(repo.dir, "src/auth/session.ts"), "utf8") + "\n// unstaged edit\n");
  repo.run("add", "src/util/ids.ts");
  const md = cli("--staged");
  assert.match(md, /Staged changes vs `HEAD`/);
  assert.match(md, /New function `shortId`/);
  assert.doesNotMatch(md, /session\.ts/);
  repo.run("reset", "-q", "--hard");
});

test("--changelog inserts once and replaces on re-run", () => {
  const file = path.join(repo.dir, "CHANGELOG.md");
  writeFileSync(file, "# Changelog\n\nIntro text.\n\n## [1.0.0] - 2026-01-01\n\n- Old release\n");
  cli("--changelog", "--release", "1.1.0", "-q");
  cli("--changelog", "--release", "1.1.0", "-q");
  const text = readFileSync(file, "utf8");
  assert.equal(text.match(/## \[1\.1\.0\]/g).length, 1);
  assert.ok(text.indexOf("## [1.1.0]") < text.indexOf("## [1.0.0]"));
  assert.match(text, /Intro text\./);
  assert.match(text, /### ⚠️ Breaking Changes/);
  assert.match(text, /- Old release/);
});

test("jira format has no raw HTML; json is parseable", () => {
  assert.doesNotMatch(cli("-f", "jira"), /<details>/);
  const j = JSON.parse(cli("--json", "-q"));
  assert.ok(j.buckets.breaking.length > 0);
  assert.ok(!("patch" in j.files[0]));
});

test("pre-commit hook runs in staged mode and uninstalls cleanly", () => {
  cli("install-hook", "--hook", "pre-commit");
  const hook = readFileSync(path.join(repo.dir, ".git/hooks/pre-commit"), "utf8");
  assert.match(hook, /--staged/);
  assert.match(hook, /exit 0/);
  cli("uninstall-hook", "--hook", "pre-commit");
  assert.throws(() => readFileSync(path.join(repo.dir, ".git/hooks/pre-commit")));
});

test("AI entries render into the buckets with static evidence kept", async () => {
  const { analyze } = await import("../lib/analyze.mjs");
  const { renderPR, renderRelease } = await import("../lib/render.mjs");
  const cwd = process.cwd();
  process.chdir(repo.dir);
  try {
    const a = analyze({ head: "HEAD" });
    const entry = (summary) => ({ summary, impact: "Callers must migrate.", files: ["src/auth/session.ts"] });
    const ai = {
      overview: "Adds session refresh.", architecture: ["Auth now depends on util."],
      breaking: [entry("`legacyLogin` removed")], features: [entry("Session refresh")], fixes: [], infrastructure: [],
      reviewer_focus: ["Check the DROP COLUMN."],
    };
    const md = renderPR(a, ai);
    assert.match(md, /## Overview\n\nAdds session refresh\./);
    assert.match(md, /- \*\*`legacyLogin` removed\*\*: Callers must migrate\. \(`src\/auth\/session.ts`\)/);
    assert.match(md, /Static analysis evidence/);
    assert.match(md, /Where to focus/);
    assert.match(renderRelease(a, ai, "2.0.0"), /### ✨ Features & Functional Updates\n\n- \*\*Session refresh\*\*/);
  } finally {
    process.chdir(cwd);
  }
});

test("AI JSON parsing tolerates code fences and surrounding prose", async () => {
  const { parseModelJson } = await import("../lib/ai.mjs");
  const obj = { overview: "x", breaking: [] };
  assert.deepEqual(parseModelJson(JSON.stringify(obj)), obj);
  assert.deepEqual(parseModelJson("```json\n" + JSON.stringify(obj, null, 2) + "\n```"), obj);
  assert.deepEqual(parseModelJson("```\n" + JSON.stringify(obj) + "\n```\n"), obj);
  assert.deepEqual(parseModelJson("Here is the changelog:\n" + JSON.stringify(obj) + "\nDone."), obj);
  assert.throws(() => parseModelJson("```json\n{ not json\n```"), /wasn't valid JSON/);
});

test("symbol diff distinguishes compatible extensions from breaking changes", () => {
  assert.ok(isCompatibleExtension("f(a)", "f(a, b = 1)"));
  assert.ok(isCompatibleExtension("def f(self)", "def f(self, x=None)"));
  assert.ok(!isCompatibleExtension("f(a)", "f(a, b)"));
  assert.ok(!isCompatibleExtension("f(a): string", "f(a, b?: number): number"));
  const old = extractSymbols("pub fn a() {}\npub struct S {}\n", "rust");
  const neu = extractSymbols("pub fn a(x: u8) {}\n", "rust");
  const types = diffSymbols(old, neu).map((c) => c.type).sort();
  assert.deepEqual(types, ["removed", "signature"]);
});
