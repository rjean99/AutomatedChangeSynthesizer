# prnotes: Automated PR / Release Note Synthesizer

`prnotes` diffs your work against a target branch (or the staging area) and reads the actual code
changes. It sorts them into four buckets and writes Markdown for a pull request, a Jira release
ticket, or `CHANGELOG.md`.

It runs on Node ≥ 18 and has no runtime dependencies. The optional Claude explanations need
`@anthropic-ai/sdk` (`npm install`).

```bash
node bin/prnotes.mjs                         # branch vs main → PR markdown on stdout
node bin/prnotes.mjs --base staging          # different target branch
node bin/prnotes.mjs --staged                # only what's in the index (pre-commit review)
node bin/prnotes.mjs --working               # branch + uncommitted + untracked
node bin/prnotes.mjs -f jira                 # same content, no HTML, for Jira tickets
node bin/prnotes.mjs --changelog --release 2.4.0   # insert/replace "## [2.4.0]" in CHANGELOG.md
node bin/prnotes.mjs --ai                    # Claude explains each change and why it matters
node bin/prnotes.mjs --json                  # raw analysis for other tooling
```

To use it as `git prnotes`: `git config --global alias.prnotes "!node /path/to/bin/prnotes.mjs"`

## How it meets the requirements

### 1. Git inspection

| Mode | Compares |
|---|---|
| default | `merge-base(<base>, HEAD)..HEAD`, so commits that landed on the target after you branched are excluded. `<base>` auto-detects `main` → `master` → `origin/main` → `origin/master`; override with `--base`. |
| `--staged` | The index vs `HEAD`: exactly what the next commit will contain. |
| `--working` | The merge-base vs the working tree, including untracked files. |

### 2. Semantic categorization

Every change goes into one of the required buckets. A fifth, minor section lists tests and docs.

| Bucket | Populated from |
|---|---|
| ⚠️ **Breaking Changes** | Public symbols that were removed, renamed or moved across files; incompatible signature changes; removed HTTP endpoints; destructive SQL (`DROP`, `RENAME`, type changes); major upgrades of runtime dependencies; removed modules or source files; `!` / `BREAKING CHANGE:` commits |
| ✨ **Features & Functional Updates** | New public symbols, new endpoints, signatures extended with *optional* parameters, and behavior changes in files whose commits are `feat` |
| 🐛 **Bug Fixes & Refactoring** | Implementation changes, internal renames and moves, and work in `fix` / `refactor` / `perf` commits |
| 📦 **Dependency Updates & Infrastructure Changes** | Manifest diffs (npm, Composer, pip, pyproject, Go, Cargo) with major/minor/patch classification, lockfiles, migrations, CI, Docker/Kubernetes/Terraform, config files, new or dropped environment variables |

"Public" is language-aware: `export`, Rust `pub`, capitalized Go names, Python names without a
leading `_`, JVM/C# `public`. Signature changes count as breaking only if callers would break.
Adding a defaulted parameter goes under Features. A change that only adds an optional parameter
is never flagged as breaking.

### 3. Contextual depth from the code itself

The tool parses the old and new version of each file instead of reading commit messages. It
supports JS/TS, Python, Go, Rust, Java/Kotlin/C#/Scala/Swift, PHP and Ruby, and reports:

- **Per-symbol changes:** added, removed, renamed (same body, new name), moved between files,
  signature changes and body changes.
- **What a body change does:** calls gained or lost (`now calls s.mu.RLock; no longer calls
  Math.random`), plus new guard clauses, error handling or concurrency control.
- **Blast radius:** for each breaking API change, it searches the new tree for remaining
  references or call sites and lists them.
- **🏗️ Architecture impact:**
  - churn hotspots by module;
  - new and removed modules;
  - **new or dropped dependencies between modules**, from import analysis;
  - new third-party imports;
  - public API surface changes per module.
- **🔍 Review notes:**
  - hard-coded secrets (value redacted);
  - `.only` focused tests and skipped tests;
  - migrations and security-sensitive paths;
  - debug statements and lint suppressions;
  - changed logic with no matching test change.

With **`--ai`**, Claude (`claude-opus-5-5`, adaptive thinking, `--effort medium`) gets this
analysis plus the unified diff. It returns schema-validated JSON with one entry per logical
change: *what changed* and *why it matters* to callers, data, operations or the architecture.
It also returns an overview, architecture bullets and where reviewers should focus. Each bucket
then shows Claude's explanations. In `pr` format, the static evidence stays below them in a
collapsible block. Notes on the AI pass:

- Diffs are prioritized source → migrations → deps → infra → config → tests → docs, up to
  `--max-ai-diff` bytes (default 600 KB). Anything left out is named in the output.
- Lockfiles and binaries are never sent.
- The server-side refusal fallback (`fallbacks: "default"`) is enabled.
- If the SDK, credentials or network are missing, prnotes prints a warning and falls back to
  the static report.

`--ai` sends your diff to the Claude API. Credentials come from `ANTHROPIC_API_KEY` or an
`ant auth login` profile.

### 4. Markdown output

| Target | Command | Shape |
|---|---|---|
| Pull request | default / `-f pr` | Overview, architecture, four buckets, review notes, collapsible per-file analysis and commit log |
| Jira release ticket | `-f jira` | The same content without raw HTML (Jira's editor drops it) |
| `CHANGELOG.md` | `--changelog [file] --release <label>` | Inserts `## [label] - date` above the previous release, keeping the preamble. Re-running with the same label replaces that section. |
| Release entry to stdout | `-f release` | Just the CHANGELOG section |

Use `-o <file>` to write any format to a file instead of stdout.

## Git hooks

```bash
node bin/prnotes.mjs install-hook                    # pre-push: branch summary
node bin/prnotes.mjs install-hook --hook pre-commit  # runs with --staged
node bin/prnotes.mjs uninstall-hook --hook pre-commit
```

Hooks write `.git/PR_NOTES.md` and **never block** the git operation. `PRNOTES_AI=1` turns on
the Claude pass inside hooks; that makes a network call on each run. The installer respects
`core.hooksPath`. It won't overwrite a hook it didn't create.

## Project layout

```
bin/prnotes.mjs     CLI, hook installer
lib/git.mjs         comparisons (branch / working / staged), patches, commits, grep
lib/symbols.mjs     per-language symbol extraction and symbol diffing
lib/analyze.mjs     classification, imports/coupling, routes, env vars, deps, flags, buckets
lib/render.mjs      PR / Jira / release Markdown, CHANGELOG.md maintenance
lib/ai.mjs          Claude structured-output pass
test/               fixture repo + node:test suite (npm test)
```

## Limits

- Symbol extraction uses regexes plus brace or indent tracking, not a full compiler front end.
  It handles idiomatic code well but can miss exotic constructs. C/C++ falls back to git's hunk
  context.
- Import resolution covers relative paths, `@/` aliases, Go module paths, `crate::`, and Python
  packages found in the repo.
- Whether a modified function counts as a feature or a fix depends on the commit types that
  touched its file. Commits that mix both fall back to fixes.
- The `--ai` mode has only been tested against mocked responses and the authentication-failure
  path. It has not yet run against the live API.
