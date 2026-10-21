#!/usr/bin/env node
// prnotes: synthesize a categorized, technical Markdown changelog from git.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, PrnotesError } from "../lib/git.mjs";
import { analyze, VERSION } from "../lib/analyze.mjs";
import { renderPR, renderJira, renderRelease, updateChangelog } from "../lib/render.mjs";
import { synthesize } from "../lib/ai.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HOOK_MARKER = "# prnotes-hook";

const HELP = `prnotes ${VERSION} - automated PR / release note synthesizer

Usage:
  prnotes [generate] [options]     Changelog for the current branch vs main
  prnotes install-hook [--hook <name>]
  prnotes uninstall-hook [--hook <name>]

What to compare:
  -b, --base <ref>        Target branch (default: main, master, origin/main, origin/master)
      --head <ref>        Head ref (default: HEAD)
  -w, --working           Branch + uncommitted + untracked changes
  -s, --staged            Only what's staged in the index, vs HEAD

Output:
  -f, --format <fmt>      pr      full PR description (default)
                          jira    same content without HTML, for Jira tickets
                          release a CHANGELOG-style release entry
  -o, --out <file>        Write to a file instead of stdout
      --changelog [file]  Insert/replace a release entry in CHANGELOG.md
                          (default file: CHANGELOG.md at the repo root)
      --release <label>   Release label for --changelog / release format
                          (default: Unreleased)
      --json              Raw analysis as JSON

AI explanations (optional, needs @anthropic-ai/sdk):
      --ai                Have Claude explain each change and its impact
                          (also enabled by PRNOTES_AI=1; --no-ai overrides)
      --model <id>        Default: claude-opus-5-5
      --effort <level>    low | medium | high | xhigh | max (default: medium)
      --max-ai-diff <n>   Max bytes of diff sent to Claude (default: 600000)

Other:
      --hook <name>       Hook for install/uninstall (default: pre-push;
                          pre-commit implies --staged)
  -q, --quiet             No status messages on stderr
  -h, --help | -v, --version
`;

function parseArgs(argv) {
  const opts = {
    command: "generate", base: null, head: "HEAD", working: false, staged: false, format: "pr",
    out: null, changelog: null, release: "Unreleased", json: false, ai: process.env.PRNOTES_AI === "1",
    model: "claude-opus-5-5", effort: "medium", maxAiDiff: 600_000, hook: "pre-push", quiet: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) opts.command = args.shift();
  while (args.length) {
    const a = args.shift();
    const val = () => {
      const v = args.shift();
      if (v === undefined) throw new PrnotesError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-b": case "--base": opts.base = val(); break;
      case "--head": opts.head = val(); break;
      case "-w": case "--working": opts.working = true; break;
      case "-s": case "--staged": opts.staged = true; break;
      case "-f": case "--format": opts.format = val(); break;
      case "-o": case "--out": opts.out = path.resolve(val()); break;
      case "--changelog":
        opts.changelog = args[0] && !args[0].startsWith("-") ? path.resolve(args.shift()) : "default";
        break;
      case "--release": opts.release = val(); break;
      case "--json": opts.json = true; break;
      case "--ai": opts.ai = true; break;
      case "--no-ai": opts.ai = false; break;
      case "--model": opts.model = val(); break;
      case "--effort": opts.effort = val(); break;
      case "--max-ai-diff": opts.maxAiDiff = Number(val()); break;
      case "--hook": opts.hook = val(); break;
      case "-q": case "--quiet": opts.quiet = true; break;
      case "-h": case "--help": opts.command = "help"; break;
      case "-v": case "--version": opts.command = "version"; break;
      default: throw new PrnotesError(`unknown option ${a} (see --help)`);
    }
  }
  if (!["pr", "jira", "release"].includes(opts.format)) throw new PrnotesError("--format must be pr, jira or release");
  if (!["low", "medium", "high", "xhigh", "max"].includes(opts.effort)) throw new PrnotesError("--effort must be low, medium, high, xhigh or max");
  return opts;
}

// ───────────────────────── hooks ─────────────────────────

function hooksDir() {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const custom = git(["config", "--get", "core.hooksPath"], { allowFail: true })?.trim();
  if (custom) return path.resolve(root, custom);
  return path.join(path.resolve(root, git(["rev-parse", "--git-common-dir"]).trim()), "hooks");
}

function installHook(opts) {
  const dir = hooksDir();
  const file = path.join(dir, opts.hook);
  const script = SCRIPT_PATH.replace(/\\/g, "/");
  const staged = opts.hook === "pre-commit" ? " --staged" : "";
  const cmd = `node "${script}"${staged} --out "$(git rev-parse --git-dir)/PR_NOTES.md" --quiet`;
  if (existsSync(file) && !readFileSync(file, "utf8").includes(HOOK_MARKER)) {
    throw new PrnotesError(`${file} already exists and wasn't written by prnotes. Add this line to it yourself:\n  ${cmd} || true`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, [
    "#!/bin/sh",
    `${HOOK_MARKER}: regenerates the change summary draft. Never blocks the git operation.`,
    "# Set PRNOTES_AI=1 to include Claude-written explanations (slower; needs network).",
    `${cmd} || echo "prnotes: changelog generation failed (ignored)" >&2`,
    "exit 0",
    "",
  ].join("\n"));
  try { chmodSync(file, 0o755); } catch { /* Windows: Git for Windows runs hooks through sh regardless */ }
  console.log(`Installed ${opts.hook} hook: ${file}\nThe summary is written to .git/PR_NOTES.md on each ${opts.hook}.`);
}

function uninstallHook(opts) {
  const file = path.join(hooksDir(), opts.hook);
  if (!existsSync(file)) return console.log(`No ${opts.hook} hook installed.`);
  if (!readFileSync(file, "utf8").includes(HOOK_MARKER)) throw new PrnotesError(`${file} wasn't written by prnotes; leaving it alone.`);
  unlinkSync(file);
  console.log(`Removed ${file}`);
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (m) => { if (!opts.quiet) process.stderr.write(`prnotes: ${m}\n`); };
  if (opts.command === "help") return process.stdout.write(HELP);
  if (opts.command === "version") return console.log(VERSION);
  if (git(["rev-parse", "--is-inside-work-tree"], { allowFail: true })?.trim() !== "true") throw new PrnotesError("not inside a git repository");
  if (opts.command === "install-hook") return installHook(opts);
  if (opts.command === "uninstall-hook") return uninstallHook(opts);
  if (opts.command !== "generate") throw new PrnotesError(`unknown command "${opts.command}" (see --help)`);

  const a = analyze(opts);
  if (!a.files.length && a.mode === "committed" && git(["status", "--porcelain"]).trim()) {
    log("no committed changes vs base; use --working (everything) or --staged (index only) for uncommitted work");
  }

  if (opts.json) {
    const json = JSON.stringify({ ...a, files: a.files.map(({ patch, ...rest }) => rest) }, null, 2);
    return emit(json, opts, log, a);
  }

  let ai = null;
  if (opts.ai && a.files.length) {
    try {
      ai = await synthesize(a, opts, log);
    } catch (err) {
      log(`AI explanations skipped, using static analysis only: ${err.message}`);
    }
  }

  if (opts.changelog) {
    const file = opts.changelog === "default" ? path.resolve("CHANGELOG.md") : opts.changelog;
    updateChangelog(file, renderRelease(a, ai, opts.release), opts.release);
    log(`updated ${file} [${opts.release}]`);
    if (!opts.out) return;
  }

  const render = { pr: renderPR, jira: renderJira, release: (x, y) => renderRelease(x, y, opts.release) }[opts.format];
  emit(render(a, ai), opts, log, a);
}

function emit(text, opts, log, a) {
  if (opts.out) {
    mkdirSync(path.dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, text.trimEnd() + "\n");
    log(`wrote ${opts.out} (${a.totals.files} files, ${a.commits.length} commits)`);
  } else {
    process.stdout.write(text.trimEnd() + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`prnotes: ${err instanceof PrnotesError ? err.message : err.stack || err.message}\n`);
  process.exit(1);
});
