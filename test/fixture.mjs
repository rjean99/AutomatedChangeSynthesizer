// Builds a throwaway repo with a `main` branch and a feature branch that
// exercises every bucket: API breaks, features, fixes, deps, infra, routes,
// env vars, coupling changes and a destructive migration.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "prn-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const write = (p, text) => {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), text);
  };
  const commit = (msg, body) => {
    run("add", "-A");
    run("commit", "-q", "-m", msg, ...(body ? ["-m", body] : []));
  };

  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Tester");
  run("config", "core.autocrlf", "false");

  write("src/auth/session.ts", `export interface SessionOptions {
  ttl: number;
}

export class SessionManager {
  private store = new Map<string, number>();

  constructor(private opts: SessionOptions) {}

  create(userId: string): string {
    const id = Math.random().toString(36);
    this.store.set(id, Date.now());
    return id;
  }

  isValid(id: string): boolean {
    const t = this.store.get(id);
    return t !== undefined && Date.now() - t < this.opts.ttl;
  }
}

export function legacyLogin(user: string) {
  return user.length > 0;
}

export const hashToken = (token: string) => {
  return token.split("").reverse().join("");
};
`);
  write("src/api/routes.ts", `import { legacyLogin } from "../auth/session";

export function register(app: any) {
  app.get("/health", (req: any, res: any) => res.send("ok"));
  app.post("/login", (req: any, res: any) => res.send(legacyLogin(req.body.user)));
}
`);
  write("src/billing/invoice.py", `class Invoice:
    def __init__(self, amount):
        self.amount = amount

    def total(self):
        return self.amount


def format_currency(v):
    return f"\${v:.2f}"
`);
  write("pkg/store/store.go", `package store

type Store struct {
	items map[string]string
}

func (s *Store) Get(key string) string {
	return s.items[key]
}
`);
  write("package.json", JSON.stringify({ name: "demo", dependencies: { express: "^4.18.2", lodash: "^4.17.21" }, devDependencies: { jest: "^29.0.0" } }, null, 2));
  write("README.md", "# Demo\n");
  commit("initial");

  run("checkout", "-q", "-b", "feature/session-refresh");

  write("src/util/ids.ts", `export function newId(): string {
  return crypto.randomUUID();
}
`);
  write("src/auth/session.ts", `import { newId } from "../util/ids";

export interface SessionOptions {
  ttl: number;
  refreshWindow?: number;
}

export class SessionManager {
  private store = new Map<string, number>();

  constructor(private opts: SessionOptions) {}

  create(userId: string, meta: Record<string, string> = {}): string {
    const id = newId();
    this.store.set(id, Date.now());
    return id;
  }

  isValid(id: string): boolean {
    const t = this.store.get(id);
    if (t === undefined) return false;
    return Date.now() - t < this.opts.ttl;
  }

  refresh(id: string): boolean {
    if (!this.isValid(id)) return false;
    this.store.set(id, Date.now());
    return true;
  }
}

export const reverseToken = (token: string) => {
  return token.split("").reverse().join("");
};
`);
  write("src/api/routes.ts", `import { SessionManager } from "../auth/session";

const sessions = new SessionManager({ ttl: Number(process.env.SESSION_TTL_MS) });

export function register(app: any) {
  app.get("/health", (req: any, res: any) => res.send("ok"));
  app.post("/sessions/refresh", (req: any, res: any) => res.send(sessions.refresh(req.body.id)));
}
`);
  commit("feat(auth): add session refresh endpoint", "BREAKING CHANGE: POST /login removed; use SessionManager");

  write("pkg/store/store.go", `package store

import "sync"

type Store struct {
	mu    sync.RWMutex
	items map[string]string
}

func (s *Store) Get(key string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.items[key]
}
`);
  commit("fix(store): make Store safe for concurrent use");

  write("src/billing/invoice.py", `from decimal import Decimal


class Invoice:
    def __init__(self, amount, currency="USD"):
        self.amount = Decimal(amount)
        self.currency = currency

    def total(self, tax_rate=Decimal("0")):
        return self.amount * (1 + tax_rate)
`);
  write("src/billing/fmt.py", `def format_currency(v, symbol="$"):
    return f"{symbol}{v:.2f}"
`);
  write("package.json", JSON.stringify({ name: "demo", dependencies: { express: "^5.0.1", zod: "^3.23.0" }, devDependencies: { jest: "^29.7.0" } }, null, 2));
  write("db/migrations/0002_sessions.sql", "ALTER TABLE sessions ADD COLUMN refreshed_at timestamptz;\nALTER TABLE users DROP COLUMN legacy_token;\n");
  write(".github/workflows/ci.yml", "name: ci\non: [push]\njobs: {}\n");
  write("tests/session.test.ts", `describe("SessionManager", () => {\n  it("refreshes a valid session", () => {});\n});\n`);
  commit("refactor(billing): move currency formatting", "Also upgrades express and adds a migration.");

  return { dir, run, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
