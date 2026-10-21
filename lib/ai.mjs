// Optional Claude pass: turns the static analysis plus the raw diff into
// bucketed, explanatory changelog entries (what changed and why it matters).

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

const ENTRY = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "impact", "files"],
  properties: {
    summary: { type: "string", description: "One line: what changed. Markdown with backticked identifiers." },
    impact: { type: "string", description: "One to three sentences: why it matters to callers, operators or the architecture." },
    files: { type: "array", items: { type: "string" }, description: "Repo-relative paths that carry this change." },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "architecture", "breaking", "features", "fixes", "infrastructure", "reviewer_focus"],
  properties: {
    overview: { type: "string" },
    architecture: { type: "array", items: { type: "string" } },
    breaking: { type: "array", items: ENTRY },
    features: { type: "array", items: ENTRY },
    fixes: { type: "array", items: ENTRY },
    infrastructure: { type: "array", items: ENTRY },
    reviewer_focus: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM_PROMPT = `You write technical changelogs for pull requests and release tickets. You receive a static analysis of a git change (symbol-level diffs, import/coupling changes, dependency changes, heuristic bucket assignments, review flags), the commit log, and the unified diff.

Produce JSON matching the schema:
- overview: two to four sentences on what this change does and why, for a reviewer who has not seen it.
- architecture: zero to five bullets on structural impact: new or removed modules, dependency direction between modules, public API surface, data model, runtime topology. Omit anything already obvious from a single entry.
- breaking: API removals or renames, incompatible signature changes, removed endpoints, destructive schema changes, behavior changes callers must react to, risky major dependency upgrades.
- features: new capabilities and functional/behavioral updates.
- fixes: bug fixes, refactors, performance work, internal cleanups.
- infrastructure: dependency updates, build, CI, deployment, configuration, migrations.
- reviewer_focus: two to five bullets on where a reviewer should look hardest and why.

How to write entries:
- Read the diff. Explain what the code now does differently and why that matters (to callers, data, operations, or the architecture). Don't just restate commit messages or symbol names.
- One entry per logical change. Fold related symbol edits into a single entry instead of listing each function.
- The heuristic bucket assignments are a starting point. Move an item to a different bucket when the code shows it belongs there, e.g. a "changed implementation" that actually fixes a race condition goes under fixes and says so.
- Every claim must be grounded in the diff or the analysis. If intent isn't evident, describe the effect without guessing motives.
- Use backticks for identifiers and paths. Empty arrays are fine.`;

function buildPayload(a, maxBytes) {
  const slim = {
    mode: a.mode, branch: a.branch, base: a.base, totals: a.totals,
    architecture: a.architecture, deps: a.deps, routes: a.routes, envVars: a.envVars,
    heuristicBuckets: Object.fromEntries(["breaking", "features", "fixes", "infra", "quality"].map((k) => [k,
      a.buckets[k].map((i) => ({ text: i.text, path: i.path, hint: i.hint, references: i.refs ? { name: i.refs.name, count: i.refs.count, files: i.refs.files } : undefined }))])),
    flags: a.flags.map(({ label, path: p, line }) => ({ label, path: p, line })),
    files: a.files.map((f) => ({
      path: f.path, status: f.status, oldPath: f.oldPath, class: f.cls, insertions: f.insertions, deletions: f.deletions,
      symbols: f.symbols.map((c) => ({ change: c.type, kind: c.sym.kind, name: c.sym.qname, public: c.sym.pub, signature: c.sym.signature, oldSignature: c.old?.signature, hint: c.hint })),
      importsAdded: f.imports.added, importsRemoved: f.imports.removed,
    })),
  };
  const commits = a.commits.map((c) => `${c.short} ${c.subject}${c.body ? `\n${c.body}` : ""}`).join("\n\n");
  // Most informative diffs first; lockfiles and binaries never help the narrative.
  const rank = { source: 0, migration: 1, deps: 2, infra: 3, config: 4, ci: 5, test: 6, docs: 7, other: 8, asset: 9 };
  const candidates = a.files.filter((f) => !f.binary && f.cls !== "lockfile").sort((x, y) => rank[x.cls] - rank[y.cls]);
  let used = 0;
  const included = [];
  const omitted = [];
  for (const f of candidates) {
    if (used + f.patch.length <= maxBytes) { included.push(f.patch); used += f.patch.length; }
    else omitted.push(f.path);
  }
  const omittedNote = omitted.length ? `\n\nDiffs NOT included (size budget): ${omitted.join(", ")}. Rely only on the static analysis for those files.` : "";
  const text = `<analysis>\n${JSON.stringify(slim, null, 2)}\n</analysis>\n\n<commits>\n${commits || "(no commits: uncommitted or staged changes only)"}\n</commits>\n\n<diff>\n${included.join("\n")}\n</diff>${omittedNote}`;
  return { text, omitted };
}

function validate(out) {
  const arrays = ["architecture", "breaking", "features", "fixes", "infrastructure", "reviewer_focus"];
  if (typeof out?.overview !== "string" || arrays.some((k) => !Array.isArray(out[k]))) throw new Error("Claude returned an unexpected shape");
  for (const k of ["breaking", "features", "fixes", "infrastructure"]) {
    out[k] = out[k].filter((e) => e && typeof e.summary === "string").map((e) => ({ summary: e.summary, impact: e.impact || "", files: Array.isArray(e.files) ? e.files : [] }));
  }
  return out;
}

export async function synthesize(a, opts, log) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    throw new Error(`--ai needs the Anthropic SDK. Run: npm install --prefix "${ROOT}"`);
  }
  const { text, omitted } = buildPayload(a, opts.maxAiDiff);
  if (omitted.length) log(`AI pass: ${omitted.length} file diff(s) over the --max-ai-diff budget were omitted: ${omitted.join(", ")}`);
  log(`asking ${opts.model} to explain the changes...`);

  const client = new Anthropic();
  const params = {
    model: opts.model,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: opts.effort, format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
  };
  // Server-side refusal fallback: a declined request is re-run on Anthropic's recommended model.
  if (FALLBACK_MODELS.has(opts.model)) Object.assign(params, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });

  let msg;
  try {
    msg = await client.beta.messages.stream(params).finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Claude API authentication failed. Set ANTHROPIC_API_KEY or run `ant auth login`.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Claude API rate limit hit; try again shortly.");
    if (err instanceof Anthropic.BadRequestError) throw new Error(`Claude API rejected the request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach the Claude API (network error).");
    throw err;
  }
  if (msg.stop_reason === "refusal") throw new Error(`Claude declined to summarize this diff (${msg.stop_details?.category ?? "no category"})`);
  if (msg.stop_reason === "max_tokens") throw new Error("Claude's answer hit max_tokens and is incomplete");
  const raw = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = validate(JSON.parse(raw));
  if (omitted.length) out.overview += ` _(The AI pass did not see the diffs of ${omitted.map((p) => `\`${p}\``).join(", ")}; entries for them rely on static analysis.)_`;
  return out;
}
