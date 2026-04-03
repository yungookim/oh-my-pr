# Deployment Healing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect deployment platforms (Vercel/Railway), monitor deployments after PR merges, and attempt single-pass fixes via coding agent in isolated worktrees — submitted as PRs for human review.

**Architecture:** New `DeploymentHealingManager` orchestrates the flow, mirroring the existing CI healing pattern. Platform-specific adapters wrap CLI tools (vercel, railway). A new `heal_deployment` background job triggers after PR merge detection in the babysitter. The fix agent runs in an isolated git worktree and creates a PR on a `deploy-fix/{platform}-{timestamp}` branch.

**Tech Stack:** TypeScript, Zod schemas, SQLite storage, existing background job queue, existing agent runner (codex/claude), Octokit for PR creation.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `shared/schema.ts` | Modify | Add `deploymentHealingSessionSchema`, `deploymentPlatformEnum`, `deploymentHealingStateEnum`, `heal_deployment` job kind, new config fields |
| `shared/models.ts` | Modify | Add `createDeploymentHealingSession`, `applyDeploymentHealingSessionUpdate` factories |
| `server/defaultConfig.ts` | Modify | Add default values for new config fields |
| `server/deploymentPlatformDetector.ts` | Create | Scan repo for Vercel/Railway config files |
| `server/deploymentAdapters.ts` | Create | `DeploymentPlatformAdapter` interface + Vercel/Railway CLI wrappers |
| `server/deploymentHealingManager.ts` | Create | Session CRUD, job enqueuing, state transitions |
| `server/deploymentHealingAgent.ts` | Create | Worktree setup, agent prompt, push, PR creation |
| `server/storage.ts` | Modify | Add `IStorage` methods for deployment healing sessions |
| `server/memoryStorage.ts` | Modify | In-memory implementation for tests |
| `server/sqliteStorage.ts` | Modify | SQLite table + CRUD implementation |
| `server/backgroundJobHandlers.ts` | Modify | Register `heal_deployment` handler |
| `server/babysitter.ts` | Modify | Enqueue deployment healing job after merge detection |
| `server/routes.ts` | Modify | Add two GET endpoints |
| `server/mcp.ts` | Modify | Add two MCP tools |

---

### Task 1: Schema and Data Model

**Files:**
- Modify: `shared/schema.ts:129-136` (backgroundJobKindEnum), `shared/schema.ts:359-378` (configSchema)
- Modify: `shared/models.ts`
- Modify: `server/defaultConfig.ts`
- Test: `server/defaultConfig.test.ts`

- [ ] **Step 1: Write failing test for new config fields**

Add a test case in `server/defaultConfig.test.ts` that asserts the new deployment healing config defaults exist:

```typescript
it("includes deployment-healing defaults", () => {
  assert.equal(DEFAULT_CONFIG.autoHealDeployments, false);
  assert.equal(DEFAULT_CONFIG.deploymentCheckDelayMs, 60000);
  assert.equal(DEFAULT_CONFIG.deploymentCheckTimeoutMs, 600000);
  assert.equal(DEFAULT_CONFIG.deploymentCheckPollIntervalMs, 15000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test server/defaultConfig.test.ts`
Expected: FAIL because `autoHealDeployments` is not a property of `DEFAULT_CONFIG`.

- [ ] **Step 3: Add deployment healing schemas to `shared/schema.ts`**

Add the deployment platform enum and deployment healing session state enum after the existing `healingAttemptSchema` block (after line 307):

```typescript
export const deploymentPlatformEnum = z.enum(["vercel", "railway"]);
export type DeploymentPlatform = z.infer<typeof deploymentPlatformEnum>;

export const deploymentHealingStateEnum = z.enum([
  "monitoring",
  "failed",
  "fixing",
  "fix_submitted",
  "escalated",
]);
export type DeploymentHealingState = z.infer<typeof deploymentHealingStateEnum>;

export const deploymentHealingSessionSchema = z.object({
  id: z.string(),
  repo: z.string(),
  platform: deploymentPlatformEnum,
  triggerPrNumber: z.number(),
  triggerPrTitle: z.string(),
  triggerPrUrl: z.string(),
  mergeSha: z.string(),
  deploymentId: z.string().nullable(),
  deploymentLog: z.string().nullable(),
  fixBranch: z.string().nullable(),
  fixPrNumber: z.number().nullable(),
  fixPrUrl: z.string().nullable(),
  state: deploymentHealingStateEnum,
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type DeploymentHealingSession = z.infer<typeof deploymentHealingSessionSchema>;
```

Update `backgroundJobKindEnum` to include `heal_deployment`:

```typescript
export const backgroundJobKindEnum = z.enum([
  "sync_watched_repos",
  "babysit_pr",
  "process_release_run",
  "answer_pr_question",
  "generate_social_changelog",
  "heal_deployment",
]);
```

Add new config fields to `configSchema`:

```typescript
export const configSchema = z.object({
  // ... existing fields ...
  autoHealDeployments: z.boolean(),
  deploymentCheckDelayMs: z.number(),
  deploymentCheckTimeoutMs: z.number(),
  deploymentCheckPollIntervalMs: z.number(),
});
```

- [ ] **Step 4: Add model factories to `shared/models.ts`**

Add imports for `DeploymentHealingSession` and `deploymentHealingSessionSchema` at the top. Then add after the CI healing section:

```typescript
// -- Deployment healing -------------------------------------------------------

export function createDeploymentHealingSession(
  data: Omit<DeploymentHealingSession, "id" | "createdAt" | "updatedAt">,
): DeploymentHealingSession {
  const now = new Date().toISOString();
  return deploymentHealingSessionSchema.parse({
    ...data,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
}

export function applyDeploymentHealingSessionUpdate(
  existing: DeploymentHealingSession,
  updates: Partial<DeploymentHealingSession>,
): DeploymentHealingSession {
  return deploymentHealingSessionSchema.parse({
    ...existing,
    ...updates,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}
```

- [ ] **Step 5: Add defaults to `server/defaultConfig.ts`**

Add the four new fields to `DEFAULT_CONFIG`:

```typescript
export const DEFAULT_CONFIG: Config = {
  // ... existing fields ...
  autoHealDeployments: false,
  deploymentCheckDelayMs: 60000,
  deploymentCheckTimeoutMs: 600000,
  deploymentCheckPollIntervalMs: 15000,
};
```

- [ ] **Step 6: Update the existing defaultConfig test to include new fields**

In `server/defaultConfig.test.ts`, add `"autoHealDeployments"`, `"deploymentCheckDelayMs"`, `"deploymentCheckTimeoutMs"`, `"deploymentCheckPollIntervalMs"` to the `requiredFields` array in the first test. Add the new numeric fields to the `numericFields` array in the positive numbers test (except `autoHealDeployments` which is boolean).

- [ ] **Step 7: Run tests to verify everything passes**

Run: `npx tsx --test server/defaultConfig.test.ts`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add shared/schema.ts shared/models.ts server/defaultConfig.ts server/defaultConfig.test.ts
git commit -m "feat: add deployment healing schema, models, and config defaults"
```

---

### Task 2: Storage Layer

**Files:**
- Modify: `server/storage.ts`
- Modify: `server/memoryStorage.ts`
- Modify: `server/sqliteStorage.ts`
- Test: `server/storage.test.ts`

- [ ] **Step 1: Write failing test for deployment healing session CRUD**

Add to `server/storage.test.ts`:

```typescript
import type { DeploymentHealingSession } from "@shared/schema";

test("deployment healing session CRUD", async () => {
  const storage = new MemStorage();

  // Create
  const session = await storage.createDeploymentHealingSession({
    repo: "owner/repo",
    platform: "vercel",
    triggerPrNumber: 42,
    triggerPrTitle: "Add feature",
    triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123",
    deploymentId: null,
    deploymentLog: null,
    fixBranch: null,
    fixPrNumber: null,
    fixPrUrl: null,
    state: "monitoring",
    error: null,
    completedAt: null,
  });

  assert.ok(session.id);
  assert.equal(session.repo, "owner/repo");
  assert.equal(session.platform, "vercel");
  assert.equal(session.state, "monitoring");

  // Get by id
  const fetched = await storage.getDeploymentHealingSession(session.id);
  assert.deepEqual(fetched, session);

  // List
  const all = await storage.listDeploymentHealingSessions();
  assert.equal(all.length, 1);

  // List with repo filter
  const filtered = await storage.listDeploymentHealingSessions({ repo: "owner/repo" });
  assert.equal(filtered.length, 1);
  const empty = await storage.listDeploymentHealingSessions({ repo: "other/repo" });
  assert.equal(empty.length, 0);

  // Update
  const updated = await storage.updateDeploymentHealingSession(session.id, {
    state: "failed",
    deploymentId: "dpl_123",
    deploymentLog: "Error: build failed",
  });
  assert.ok(updated);
  assert.equal(updated!.state, "failed");
  assert.equal(updated!.deploymentId, "dpl_123");

  // Get by repo and merge sha
  const byMerge = await storage.getDeploymentHealingSessionByRepoAndMergeSha("owner/repo", "abc123");
  assert.ok(byMerge);
  assert.equal(byMerge!.id, session.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test server/storage.test.ts`
Expected: FAIL because `createDeploymentHealingSession` is not a function on storage.

- [ ] **Step 3: Add IStorage interface methods**

In `server/storage.ts`, add the import for `DeploymentHealingSession` and `DeploymentHealingState` at the top, then add these methods to the `IStorage` interface:

```typescript
  // Deployment healing
  getDeploymentHealingSession(id: string): Promise<DeploymentHealingSession | undefined>;
  getDeploymentHealingSessionByRepoAndMergeSha(repo: string, mergeSha: string): Promise<DeploymentHealingSession | undefined>;
  listDeploymentHealingSessions(filters?: {
    repo?: string;
    state?: DeploymentHealingState;
  }): Promise<DeploymentHealingSession[]>;
  createDeploymentHealingSession(data: Omit<DeploymentHealingSession, "id" | "createdAt" | "updatedAt">): Promise<DeploymentHealingSession>;
  updateDeploymentHealingSession(id: string, updates: Partial<DeploymentHealingSession>): Promise<DeploymentHealingSession | undefined>;
```

- [ ] **Step 4: Implement MemStorage**

In `server/memoryStorage.ts`, add the import for `DeploymentHealingSession`, `DeploymentHealingState`, and the model functions `createDeploymentHealingSession`, `applyDeploymentHealingSessionUpdate`. Add a private map:

```typescript
private deploymentHealingSessions: Map<string, DeploymentHealingSession> = new Map();
```

Then implement the five methods:

```typescript
async getDeploymentHealingSession(id: string): Promise<DeploymentHealingSession | undefined> {
  return this.deploymentHealingSessions.get(id);
}

async getDeploymentHealingSessionByRepoAndMergeSha(repo: string, mergeSha: string): Promise<DeploymentHealingSession | undefined> {
  return Array.from(this.deploymentHealingSessions.values()).find(
    (s) => s.repo === repo && s.mergeSha === mergeSha,
  );
}

async listDeploymentHealingSessions(filters?: {
  repo?: string;
  state?: DeploymentHealingState;
}): Promise<DeploymentHealingSession[]> {
  let sessions = Array.from(this.deploymentHealingSessions.values());
  if (filters?.repo) {
    sessions = sessions.filter((s) => s.repo === filters.repo);
  }
  if (filters?.state) {
    sessions = sessions.filter((s) => s.state === filters.state);
  }
  return sessions.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

async createDeploymentHealingSession(data: Omit<DeploymentHealingSession, "id" | "createdAt" | "updatedAt">): Promise<DeploymentHealingSession> {
  const entry = createDeploymentHealingSession(data);
  this.deploymentHealingSessions.set(entry.id, entry);
  return entry;
}

async updateDeploymentHealingSession(id: string, updates: Partial<DeploymentHealingSession>): Promise<DeploymentHealingSession | undefined> {
  const existing = this.deploymentHealingSessions.get(id);
  if (!existing) return undefined;
  const updated = applyDeploymentHealingSessionUpdate(existing, updates);
  this.deploymentHealingSessions.set(id, updated);
  return updated;
}
```

- [ ] **Step 5: Implement SqliteStorage**

In `server/sqliteStorage.ts`:

Add a row type near the other row types:

```typescript
type DeploymentHealingSessionRow = {
  id: string;
  repo: string;
  platform: string;
  trigger_pr_number: number;
  trigger_pr_title: string;
  trigger_pr_url: string;
  merge_sha: string;
  deployment_id: string | null;
  deployment_log: string | null;
  fix_branch: string | null;
  fix_pr_number: number | null;
  fix_pr_url: string | null;
  state: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};
```

Add the table creation in `bootstrap()` after the existing healing tables:

```sql
CREATE TABLE IF NOT EXISTS deployment_healing_sessions (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  platform TEXT NOT NULL,
  trigger_pr_number INTEGER NOT NULL,
  trigger_pr_title TEXT NOT NULL,
  trigger_pr_url TEXT NOT NULL,
  merge_sha TEXT NOT NULL,
  deployment_id TEXT,
  deployment_log TEXT,
  fix_branch TEXT,
  fix_pr_number INTEGER,
  fix_pr_url TEXT,
  state TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(repo, merge_sha)
);
```

Add a row parser method:

```typescript
private parseDeploymentHealingSessionRow(row: DeploymentHealingSessionRow): DeploymentHealingSession {
  return {
    id: row.id,
    repo: row.repo,
    platform: row.platform as DeploymentPlatform,
    triggerPrNumber: row.trigger_pr_number,
    triggerPrTitle: row.trigger_pr_title,
    triggerPrUrl: row.trigger_pr_url,
    mergeSha: row.merge_sha,
    deploymentId: row.deployment_id,
    deploymentLog: row.deployment_log,
    fixBranch: row.fix_branch,
    fixPrNumber: row.fix_pr_number,
    fixPrUrl: row.fix_pr_url,
    state: row.state as DeploymentHealingState,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
```

Implement the five CRUD methods following the same pattern as `getSocialChangelog` / `createSocialChangelog`:

```typescript
async getDeploymentHealingSession(id: string): Promise<DeploymentHealingSession | undefined> {
  const row = this.get<DeploymentHealingSessionRow>(`
    SELECT * FROM deployment_healing_sessions WHERE id = ?
  `, id);
  return row ? this.parseDeploymentHealingSessionRow(row) : undefined;
}

async getDeploymentHealingSessionByRepoAndMergeSha(repo: string, mergeSha: string): Promise<DeploymentHealingSession | undefined> {
  const row = this.get<DeploymentHealingSessionRow>(`
    SELECT * FROM deployment_healing_sessions WHERE repo = ? AND merge_sha = ?
  `, repo, mergeSha);
  return row ? this.parseDeploymentHealingSessionRow(row) : undefined;
}

async listDeploymentHealingSessions(filters?: {
  repo?: string;
  state?: DeploymentHealingState;
}): Promise<DeploymentHealingSession[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters?.repo) {
    conditions.push("repo = ?");
    params.push(filters.repo);
  }
  if (filters?.state) {
    conditions.push("state = ?");
    params.push(filters.state);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = this.all<DeploymentHealingSessionRow>(`
    SELECT * FROM deployment_healing_sessions ${where} ORDER BY datetime(created_at) DESC
  `, ...params);
  return rows.map((row) => this.parseDeploymentHealingSessionRow(row));
}

async createDeploymentHealingSession(data: Omit<DeploymentHealingSession, "id" | "createdAt" | "updatedAt">): Promise<DeploymentHealingSession> {
  const entry = createDeploymentHealingSession(data);
  this.run(`
    INSERT INTO deployment_healing_sessions (
      id, repo, platform, trigger_pr_number, trigger_pr_title, trigger_pr_url,
      merge_sha, deployment_id, deployment_log, fix_branch, fix_pr_number, fix_pr_url,
      state, error, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    entry.id, entry.repo, entry.platform, entry.triggerPrNumber, entry.triggerPrTitle,
    entry.triggerPrUrl, entry.mergeSha, entry.deploymentId, entry.deploymentLog,
    entry.fixBranch, entry.fixPrNumber, entry.fixPrUrl, entry.state, entry.error,
    entry.createdAt, entry.updatedAt, entry.completedAt,
  );
  return entry;
}

async updateDeploymentHealingSession(id: string, updates: Partial<DeploymentHealingSession>): Promise<DeploymentHealingSession | undefined> {
  const existing = await this.getDeploymentHealingSession(id);
  if (!existing) return undefined;
  const next = applyDeploymentHealingSessionUpdate(existing, updates);
  this.run(`
    UPDATE deployment_healing_sessions
    SET repo = ?, platform = ?, trigger_pr_number = ?, trigger_pr_title = ?, trigger_pr_url = ?,
        merge_sha = ?, deployment_id = ?, deployment_log = ?, fix_branch = ?, fix_pr_number = ?,
        fix_pr_url = ?, state = ?, error = ?, updated_at = ?, completed_at = ?
    WHERE id = ?
  `,
    next.repo, next.platform, next.triggerPrNumber, next.triggerPrTitle, next.triggerPrUrl,
    next.mergeSha, next.deploymentId, next.deploymentLog, next.fixBranch, next.fixPrNumber,
    next.fixPrUrl, next.state, next.error, next.updatedAt, next.completedAt, id,
  );
  return next;
}
```

- [ ] **Step 6: Add config columns to SqliteStorage bootstrap**

In the `config` table creation in `bootstrap()`, add these columns:

```sql
auto_heal_deployments INTEGER NOT NULL DEFAULT 0,
deployment_check_delay_ms INTEGER NOT NULL DEFAULT 60000,
deployment_check_timeout_ms INTEGER NOT NULL DEFAULT 600000,
deployment_check_poll_interval_ms INTEGER NOT NULL DEFAULT 15000
```

Also update the `ConfigRow` type, the `parseConfigRow` method, and the `updateConfig` / `getConfig` methods to handle the new fields. The mapping follows the existing pattern: `autoHealDeployments` maps to `auto_heal_deployments`, etc.

For existing databases that do not have the columns yet, add ALTER TABLE migrations in the `bootstrap()` method after the CREATE TABLE, following the existing pattern for schema migrations (check if `safeAddColumn` exists; if not, use `try { this.exec("ALTER TABLE ...") } catch {}`).

- [ ] **Step 7: Run tests to verify passes**

Run: `npx tsx --test server/storage.test.ts`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add server/storage.ts server/memoryStorage.ts server/sqliteStorage.ts server/storage.test.ts
git commit -m "feat: add deployment healing session storage layer"
```

---

### Task 3: Platform Detector

**Files:**
- Create: `server/deploymentPlatformDetector.ts`
- Create: `server/deploymentPlatformDetector.test.ts`

- [ ] **Step 1: Write failing test**

Create `server/deploymentPlatformDetector.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { detectDeploymentPlatform } from "./deploymentPlatformDetector";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = path.join(tmpdir(), `deploy-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detects vercel.json", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "vercel.json"), "{}");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "vercel");
    assert.equal(result!.configPath, "vercel.json");
  });
});

test("detects .vercel/project.json", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, ".vercel"), { recursive: true });
    await writeFile(path.join(dir, ".vercel", "project.json"), "{}");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "vercel");
    assert.equal(result!.configPath, ".vercel/project.json");
  });
});

test("detects vercel in package.json scripts", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      scripts: { deploy: "vercel --prod" },
    }));
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "vercel");
    assert.equal(result!.configPath, "package.json");
  });
});

test("detects railway.toml", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "railway.toml"), "[build]");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "railway");
    assert.equal(result!.configPath, "railway.toml");
  });
});

test("detects railway.json", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "railway.json"), "{}");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "railway");
    assert.equal(result!.configPath, "railway.json");
  });
});

test("detects nixpacks.toml as railway", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "nixpacks.toml"), "[phases.build]");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "railway");
    assert.equal(result!.configPath, "nixpacks.toml");
  });
});

test("returns null when no platform detected", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      scripts: { start: "node index.js" },
    }));
    const result = await detectDeploymentPlatform(dir);
    assert.equal(result, null);
  });
});

test("vercel takes priority over railway when both present", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "vercel.json"), "{}");
    await writeFile(path.join(dir, "railway.toml"), "[build]");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "vercel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test server/deploymentPlatformDetector.test.ts`
Expected: FAIL because module not found.

- [ ] **Step 3: Implement the detector**

Create `server/deploymentPlatformDetector.ts`:

```typescript
import { readFile, access } from "fs/promises";
import path from "path";
import type { DeploymentPlatform } from "@shared/schema";

export type PlatformDetection = {
  platform: DeploymentPlatform;
  configPath: string;
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectVercel(repoPath: string): Promise<PlatformDetection | null> {
  if (await fileExists(path.join(repoPath, "vercel.json"))) {
    return { platform: "vercel", configPath: "vercel.json" };
  }

  if (await fileExists(path.join(repoPath, ".vercel", "project.json"))) {
    return { platform: "vercel", configPath: ".vercel/project.json" };
  }

  const pkgPath = path.join(repoPath, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      const scripts = pkg.scripts ?? {};
      const hasVercel = Object.values(scripts).some(
        (script) => typeof script === "string" && script.includes("vercel"),
      );
      if (hasVercel) {
        return { platform: "vercel", configPath: "package.json" };
      }
    } catch {
      // Malformed package.json - skip
    }
  }

  return null;
}

async function detectRailway(repoPath: string): Promise<PlatformDetection | null> {
  if (await fileExists(path.join(repoPath, "railway.toml"))) {
    return { platform: "railway", configPath: "railway.toml" };
  }

  if (await fileExists(path.join(repoPath, "railway.json"))) {
    return { platform: "railway", configPath: "railway.json" };
  }

  if (await fileExists(path.join(repoPath, "nixpacks.toml"))) {
    return { platform: "railway", configPath: "nixpacks.toml" };
  }

  return null;
}

export async function detectDeploymentPlatform(repoPath: string): Promise<PlatformDetection | null> {
  return await detectVercel(repoPath) ?? await detectRailway(repoPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test server/deploymentPlatformDetector.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/deploymentPlatformDetector.ts server/deploymentPlatformDetector.test.ts
git commit -m "feat: add deployment platform detector for Vercel and Railway"
```

---

### Task 4: Platform Adapters

**Files:**
- Create: `server/deploymentAdapters.ts`
- Create: `server/deploymentAdapters.test.ts`

- [ ] **Step 1: Write failing test for Vercel and Railway adapters**

Create `server/deploymentAdapters.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult } from "./agentRunner";
import { VercelAdapter, RailwayAdapter } from "./deploymentAdapters";

type RunCommand = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }) => Promise<CommandResult>;

function mockRunner(results: Record<string, CommandResult>): RunCommand {
  return async (_cmd: string, args: string[]) => {
    const key = args.join(" ");
    for (const [pattern, result] of Object.entries(results)) {
      if (key.includes(pattern)) return result;
    }
    return { stdout: "", stderr: "unmatched command", code: 1 };
  };
}

function ok(stdout: string): CommandResult {
  return { stdout, stderr: "", code: 0 };
}

test("VercelAdapter.getDeploymentStatus parses ready deployment", async () => {
  const adapter = new VercelAdapter(mockRunner({
    "list": ok(JSON.stringify({
      deployments: [{
        uid: "dpl_abc",
        state: "READY",
        url: "my-app.vercel.app",
        meta: { githubCommitSha: "sha123" },
      }],
    })),
  }));

  const status = await adapter.getDeploymentStatus({ repo: "owner/repo", sha: "sha123" });
  assert.equal(status.state, "ready");
  assert.equal(status.deploymentId, "dpl_abc");
  assert.equal(status.url, "my-app.vercel.app");
});

test("VercelAdapter.getDeploymentStatus returns error for failed deployment", async () => {
  const adapter = new VercelAdapter(mockRunner({
    "list": ok(JSON.stringify({
      deployments: [{
        uid: "dpl_abc",
        state: "ERROR",
        url: "my-app.vercel.app",
        meta: { githubCommitSha: "sha123" },
      }],
    })),
  }));

  const status = await adapter.getDeploymentStatus({ repo: "owner/repo", sha: "sha123" });
  assert.equal(status.state, "error");
});

test("VercelAdapter.getDeploymentStatus returns not_found when no matching deployment", async () => {
  const adapter = new VercelAdapter(mockRunner({
    "list": ok(JSON.stringify({ deployments: [] })),
  }));

  const status = await adapter.getDeploymentStatus({ repo: "owner/repo", sha: "sha123" });
  assert.equal(status.state, "not_found");
});

test("VercelAdapter.getDeploymentLogs returns log output", async () => {
  const adapter = new VercelAdapter(mockRunner({
    "inspect": ok(JSON.stringify({ url: "my-app.vercel.app" })),
    "logs": ok("Build failed: module not found"),
  }));

  const logs = await adapter.getDeploymentLogs({ repo: "owner/repo", deploymentId: "dpl_abc" });
  assert.ok(logs.includes("Build failed"));
});

test("RailwayAdapter.getDeploymentStatus parses success", async () => {
  const adapter = new RailwayAdapter(mockRunner({
    "status": ok(JSON.stringify({
      deploymentId: "dep_123",
      status: "SUCCESS",
      url: "my-app.up.railway.app",
    })),
  }));

  const status = await adapter.getDeploymentStatus({ repo: "owner/repo", sha: "sha123" });
  assert.equal(status.state, "ready");
  assert.equal(status.deploymentId, "dep_123");
});

test("RailwayAdapter.getDeploymentStatus returns error for crashed deployment", async () => {
  const adapter = new RailwayAdapter(mockRunner({
    "status": ok(JSON.stringify({
      deploymentId: "dep_123",
      status: "CRASHED",
      url: null,
    })),
  }));

  const status = await adapter.getDeploymentStatus({ repo: "owner/repo", sha: "sha123" });
  assert.equal(status.state, "error");
});

test("RailwayAdapter.getDeploymentLogs returns log output", async () => {
  const adapter = new RailwayAdapter(mockRunner({
    "logs": ok("Error: cannot find module 'express'"),
  }));

  const logs = await adapter.getDeploymentLogs({ repo: "owner/repo", deploymentId: "dep_123" });
  assert.ok(logs.includes("cannot find module"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test server/deploymentAdapters.test.ts`
Expected: FAIL because module not found.

- [ ] **Step 3: Implement adapters**

Create `server/deploymentAdapters.ts`:

```typescript
import type { DeploymentPlatform } from "@shared/schema";
import type { CommandResult } from "./agentRunner";
import { runCommand as defaultRunCommand } from "./agentRunner";

export type DeploymentStatus = {
  state: "building" | "deploying" | "ready" | "error" | "not_found";
  deploymentId: string | null;
  url: string | null;
  error: string | null;
};

export interface DeploymentPlatformAdapter {
  platform: DeploymentPlatform;
  getDeploymentStatus(opts: { repo: string; sha: string }): Promise<DeploymentStatus>;
  getDeploymentLogs(opts: { repo: string; deploymentId: string }): Promise<string>;
}

type RunCommand = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }) => Promise<CommandResult>;

const COMMAND_TIMEOUT_MS = 30_000;

function notFound(): DeploymentStatus {
  return { state: "not_found", deploymentId: null, url: null, error: null };
}

// -- Vercel -------------------------------------------------------------------

function mapVercelState(state: string): DeploymentStatus["state"] {
  switch (state.toUpperCase()) {
    case "READY": return "ready";
    case "BUILDING": return "building";
    case "INITIALIZING":
    case "DEPLOYING": return "deploying";
    case "ERROR":
    case "CANCELED": return "error";
    default: return "not_found";
  }
}

export class VercelAdapter implements DeploymentPlatformAdapter {
  readonly platform = "vercel" as const;
  private readonly run: RunCommand;

  constructor(run?: RunCommand) {
    this.run = run ?? defaultRunCommand;
  }

  async getDeploymentStatus(opts: { repo: string; sha: string }): Promise<DeploymentStatus> {
    const result = await this.run("vercel", [
      "list", "--meta", `githubCommitSha=${opts.sha}`, "--json",
    ], { timeoutMs: COMMAND_TIMEOUT_MS });

    if (result.code !== 0) {
      return { state: "error", deploymentId: null, url: null, error: result.stderr || result.stdout };
    }

    try {
      const data = JSON.parse(result.stdout);
      const deployments = data.deployments ?? [];
      if (deployments.length === 0) return notFound();

      const deployment = deployments[0];
      return {
        state: mapVercelState(deployment.state ?? ""),
        deploymentId: deployment.uid ?? null,
        url: deployment.url ?? null,
        error: deployment.state === "ERROR" ? (deployment.errorMessage ?? "Deployment failed") : null,
      };
    } catch {
      return { state: "error", deploymentId: null, url: null, error: "Failed to parse vercel output" };
    }
  }

  async getDeploymentLogs(opts: { repo: string; deploymentId: string }): Promise<string> {
    const inspectResult = await this.run("vercel", [
      "inspect", opts.deploymentId, "--json",
    ], { timeoutMs: COMMAND_TIMEOUT_MS });

    let url = opts.deploymentId;
    if (inspectResult.code === 0) {
      try {
        const data = JSON.parse(inspectResult.stdout);
        url = data.url ?? opts.deploymentId;
      } catch {
        // Fall through with deploymentId
      }
    }

    const logsResult = await this.run("vercel", [
      "logs", url,
    ], { timeoutMs: COMMAND_TIMEOUT_MS });

    return logsResult.stdout || logsResult.stderr || "No logs available";
  }
}

// -- Railway ------------------------------------------------------------------

function mapRailwayStatus(status: string): DeploymentStatus["state"] {
  switch (status.toUpperCase()) {
    case "SUCCESS": return "ready";
    case "BUILDING": return "building";
    case "DEPLOYING": return "deploying";
    case "FAILED":
    case "CRASHED":
    case "REMOVED": return "error";
    default: return "not_found";
  }
}

export class RailwayAdapter implements DeploymentPlatformAdapter {
  readonly platform = "railway" as const;
  private readonly run: RunCommand;

  constructor(run?: RunCommand) {
    this.run = run ?? defaultRunCommand;
  }

  async getDeploymentStatus(opts: { repo: string; sha: string }): Promise<DeploymentStatus> {
    const result = await this.run("railway", [
      "status", "--json",
    ], { timeoutMs: COMMAND_TIMEOUT_MS });

    if (result.code !== 0) {
      return { state: "error", deploymentId: null, url: null, error: result.stderr || result.stdout };
    }

    try {
      const data = JSON.parse(result.stdout);
      return {
        state: mapRailwayStatus(data.status ?? ""),
        deploymentId: data.deploymentId ?? null,
        url: data.url ?? null,
        error: data.status === "FAILED" || data.status === "CRASHED"
          ? (data.error ?? "Deployment failed")
          : null,
      };
    } catch {
      return { state: "error", deploymentId: null, url: null, error: "Failed to parse railway output" };
    }
  }

  async getDeploymentLogs(opts: { repo: string; deploymentId: string }): Promise<string> {
    const result = await this.run("railway", [
      "logs", "--deployment", opts.deploymentId,
    ], { timeoutMs: COMMAND_TIMEOUT_MS });

    return result.stdout || result.stderr || "No logs available";
  }
}

export function createAdapter(platform: DeploymentPlatform, run?: RunCommand): DeploymentPlatformAdapter {
  switch (platform) {
    case "vercel": return new VercelAdapter(run);
    case "railway": return new RailwayAdapter(run);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test server/deploymentAdapters.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/deploymentAdapters.ts server/deploymentAdapters.test.ts
git commit -m "feat: add Vercel and Railway deployment platform adapters"
```

---

### Task 5: Deployment Healing Manager

**Files:**
- Create: `server/deploymentHealingManager.ts`
- Create: `server/deploymentHealingManager.test.ts`

- [ ] **Step 1: Write failing test**

Create `server/deploymentHealingManager.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { MemStorage } from "./memoryStorage";
import { DeploymentHealingManager } from "./deploymentHealingManager";
import type { Config } from "@shared/schema";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    githubToken: "",
    codingAgent: "claude",
    maxTurns: 15,
    batchWindowMs: 300000,
    pollIntervalMs: 120000,
    maxChangesPerRun: 20,
    autoResolveMergeConflicts: true,
    autoCreateReleases: true,
    autoUpdateDocs: true,
    autoHealCI: false,
    maxHealingAttemptsPerSession: 3,
    maxHealingAttemptsPerFingerprint: 2,
    maxConcurrentHealingRuns: 1,
    healingCooldownMs: 300000,
    watchedRepos: [],
    trustedReviewers: [],
    ignoredBots: [],
    autoHealDeployments: true,
    deploymentCheckDelayMs: 60000,
    deploymentCheckTimeoutMs: 600000,
    deploymentCheckPollIntervalMs: 15000,
    ...overrides,
  };
}

test("creates a deployment healing session", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const manager = new DeploymentHealingManager(storage);

  const session = await manager.createSession({
    repo: "owner/repo",
    platform: "vercel",
    triggerPrNumber: 42,
    triggerPrTitle: "Add feature",
    triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123",
  });

  assert.ok(session.id);
  assert.equal(session.state, "monitoring");
  assert.equal(session.platform, "vercel");
});

test("transitions session through states", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const manager = new DeploymentHealingManager(storage);

  const session = await manager.createSession({
    repo: "owner/repo",
    platform: "vercel",
    triggerPrNumber: 42,
    triggerPrTitle: "Add feature",
    triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123",
  });

  const failed = await manager.transitionTo(session.id, "failed", {
    deploymentId: "dpl_abc",
    deploymentLog: "Build error",
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.deploymentId, "dpl_abc");

  const fixing = await manager.transitionTo(session.id, "fixing");
  assert.equal(fixing.state, "fixing");

  const submitted = await manager.transitionTo(session.id, "fix_submitted", {
    fixBranch: "deploy-fix/vercel-1234",
    fixPrNumber: 43,
    fixPrUrl: "https://github.com/owner/repo/pull/43",
  });
  assert.equal(submitted.state, "fix_submitted");
  assert.ok(submitted.completedAt);
});

test("rejects invalid state transitions", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const manager = new DeploymentHealingManager(storage);

  const session = await manager.createSession({
    repo: "owner/repo",
    platform: "vercel",
    triggerPrNumber: 42,
    triggerPrTitle: "Add feature",
    triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123",
  });

  await assert.rejects(
    () => manager.transitionTo(session.id, "fixing"),
    /illegal.*transition/i,
  );
});

test("deduplicates by repo + merge sha", async () => {
  const storage = new MemStorage();
  await storage.updateConfig(makeConfig());
  const manager = new DeploymentHealingManager(storage);

  const first = await manager.createSession({
    repo: "owner/repo",
    platform: "vercel",
    triggerPrNumber: 42,
    triggerPrTitle: "Add feature",
    triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123",
  });

  const second = await manager.ensureSession({
    repo: "owner/repo",
    platform: "vercel",
    triggerPrNumber: 42,
    triggerPrTitle: "Add feature",
    triggerPrUrl: "https://github.com/owner/repo/pull/42",
    mergeSha: "abc123",
  });

  assert.equal(first.id, second.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test server/deploymentHealingManager.test.ts`
Expected: FAIL because module not found.

- [ ] **Step 3: Implement the manager**

Create `server/deploymentHealingManager.ts`:

```typescript
import type { DeploymentHealingSession, DeploymentHealingState, DeploymentPlatform } from "@shared/schema";
import type { IStorage } from "./storage";

export type DeploymentHealingSessionInput = {
  repo: string;
  platform: DeploymentPlatform;
  triggerPrNumber: number;
  triggerPrTitle: string;
  triggerPrUrl: string;
  mergeSha: string;
};

const TERMINAL_STATES: ReadonlyArray<DeploymentHealingState> = [
  "fix_submitted",
  "escalated",
];

const NEXT_STATES: Record<DeploymentHealingState, ReadonlyArray<DeploymentHealingState>> = {
  monitoring: ["failed", "escalated"],
  failed: ["fixing", "escalated"],
  fixing: ["fix_submitted", "escalated"],
  fix_submitted: [],
  escalated: [],
};

export class DeploymentHealingManager {
  constructor(
    private readonly storage: IStorage,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async createSession(input: DeploymentHealingSessionInput): Promise<DeploymentHealingSession> {
    return this.storage.createDeploymentHealingSession({
      repo: input.repo,
      platform: input.platform,
      triggerPrNumber: input.triggerPrNumber,
      triggerPrTitle: input.triggerPrTitle,
      triggerPrUrl: input.triggerPrUrl,
      mergeSha: input.mergeSha,
      deploymentId: null,
      deploymentLog: null,
      fixBranch: null,
      fixPrNumber: null,
      fixPrUrl: null,
      state: "monitoring",
      error: null,
      completedAt: null,
    });
  }

  async ensureSession(input: DeploymentHealingSessionInput): Promise<DeploymentHealingSession> {
    const existing = await this.storage.getDeploymentHealingSessionByRepoAndMergeSha(
      input.repo,
      input.mergeSha,
    );
    if (existing) return existing;
    return this.createSession(input);
  }

  async transitionTo(
    sessionId: string,
    nextState: DeploymentHealingState,
    updates: Partial<DeploymentHealingSession> = {},
  ): Promise<DeploymentHealingSession> {
    const session = await this.storage.getDeploymentHealingSession(sessionId);
    if (!session) {
      throw new Error(`Deployment healing session not found: ${sessionId}`);
    }

    if (session.state === nextState) {
      const updated = await this.storage.updateDeploymentHealingSession(sessionId, updates);
      if (!updated) throw new Error(`Deployment healing session not found: ${sessionId}`);
      return updated;
    }

    if (!NEXT_STATES[session.state].includes(nextState)) {
      throw new Error(`Illegal deployment healing transition: ${session.state} -> ${nextState}`);
    }

    const mergedUpdates: Partial<DeploymentHealingSession> = {
      ...updates,
      state: nextState,
    };

    if (TERMINAL_STATES.includes(nextState)) {
      mergedUpdates.completedAt = updates.completedAt ?? this.clock().toISOString();
    }

    const updated = await this.storage.updateDeploymentHealingSession(sessionId, mergedUpdates);
    if (!updated) throw new Error(`Deployment healing session not found: ${sessionId}`);
    return updated;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test server/deploymentHealingManager.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/deploymentHealingManager.ts server/deploymentHealingManager.test.ts
git commit -m "feat: add deployment healing manager with state machine"
```

---

### Task 6: Deployment Healing Agent

**Files:**
- Create: `server/deploymentHealingAgent.ts`
- Create: `server/deploymentHealingAgent.test.ts`

- [ ] **Step 1: Write failing test for prompt builder and summary extractor**

Create `server/deploymentHealingAgent.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeploymentHealingPrompt,
  extractDeploymentHealingSummary,
} from "./deploymentHealingAgent";

test("buildDeploymentHealingPrompt includes platform and log", () => {
  const prompt = buildDeploymentHealingPrompt({
    repo: "owner/repo",
    platform: "vercel",
    mergeSha: "abc123",
    triggerPrNumber: 42,
    triggerPrTitle: "Add feature",
    triggerPrUrl: "https://github.com/owner/repo/pull/42",
    deploymentLog: "Error: Cannot find module 'express'\n    at require (internal/modules/cjs/loader.js:1)",
    baseBranch: "main",
  });

  assert.ok(prompt.includes("vercel"), "should mention platform");
  assert.ok(prompt.includes("owner/repo"), "should mention repo");
  assert.ok(prompt.includes("abc123"), "should mention sha");
  assert.ok(prompt.includes("Cannot find module"), "should include log");
  assert.ok(prompt.includes("deploy-fix/"), "should mention branch naming");
  assert.ok(prompt.includes("DEPLOYMENT_FIX_SUMMARY:"), "should include summary marker");
});

test("extractDeploymentHealingSummary finds marker", () => {
  const summary = extractDeploymentHealingSummary(
    "lots of output\nDEPLOYMENT_FIX_SUMMARY: Added express to dependencies\nmore output",
  );
  assert.equal(summary, "Added express to dependencies");
});

test("extractDeploymentHealingSummary falls back to last line", () => {
  const summary = extractDeploymentHealingSummary("first\nsecond\nthird line");
  assert.equal(summary, "third line");
});

test("extractDeploymentHealingSummary handles empty output", () => {
  const summary = extractDeploymentHealingSummary("");
  assert.equal(summary, "No agent summary provided");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test server/deploymentHealingAgent.test.ts`
Expected: FAIL because module not found.

- [ ] **Step 3: Implement the deployment healing agent**

Create `server/deploymentHealingAgent.ts`:

```typescript
import type { CodingAgent, CommandResult } from "./agentRunner";
import { applyFixesWithAgent, runCommand as defaultRunCommand } from "./agentRunner";
import { ensureRepoCache } from "./repoWorkspace";
import type { DeploymentPlatform } from "@shared/schema";

export type DeploymentHealingPromptInput = {
  repo: string;
  platform: DeploymentPlatform;
  mergeSha: string;
  triggerPrNumber: number;
  triggerPrTitle: string;
  triggerPrUrl: string;
  deploymentLog: string;
  baseBranch: string;
};

export type DeploymentHealingRepairInput = DeploymentHealingPromptInput & {
  repoCloneUrl: string;
  agent: CodingAgent;
  githubToken: string;
  rootDir?: string;
};

export type DeploymentHealingRepairResult = {
  accepted: boolean;
  rejectionReason: string | null;
  summary: string;
  fixBranch: string;
  agentResult: CommandResult;
};

export type DeploymentHealingRepairDependencies = {
  ensureRepoCache: typeof ensureRepoCache;
  applyFixesWithAgent: typeof applyFixesWithAgent;
  runCommand: typeof defaultRunCommand;
};

function buildDeps(overrides?: Partial<DeploymentHealingRepairDependencies>): DeploymentHealingRepairDependencies {
  return {
    ensureRepoCache: overrides?.ensureRepoCache ?? ensureRepoCache,
    applyFixesWithAgent: overrides?.applyFixesWithAgent ?? applyFixesWithAgent,
    runCommand: overrides?.runCommand ?? defaultRunCommand,
  };
}

function trimLine(value: string, maxLength = 240): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}\u2026`;
}

export function buildDeploymentHealingPrompt(input: DeploymentHealingPromptInput): string {
  const lines = [
    "You are fixing a failed deployment.",
    `The deployment platform is ${input.platform}.`,
    "Make the smallest safe change that fixes the deployment.",
    "Do not expand scope to unrelated files or tasks.",
    "",
    `Repository: ${input.repo}`,
    `Trigger PR: #${input.triggerPrNumber} -- ${input.triggerPrTitle}`,
    `PR URL: ${input.triggerPrUrl}`,
    `Merge SHA: ${input.mergeSha}`,
    `Base branch: ${input.baseBranch}`,
    `Platform: ${input.platform}`,
    "",
    "You are on a fix branch named deploy-fix/{platform}-{timestamp}.",
    "Commit your fix and push it. Do NOT create a PR -- that will be done automatically.",
    "",
    "Deployment log:",
    "```",
    input.deploymentLog.slice(0, 10_000),
    "```",
    "",
    "At the end of your response, include exactly one line in this format:",
    "DEPLOYMENT_FIX_SUMMARY: <one short sentence about what changed>",
  ];

  return lines.join("\n");
}

export function extractDeploymentHealingSummary(stdout: string): string {
  const marker = stdout.match(/^DEPLOYMENT_FIX_SUMMARY:\s*(.+)$/m);
  if (marker?.[1]) {
    return marker[1].trim();
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return "No agent summary provided";
  }

  const outputLines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return trimLine(outputLines.slice(-1).join(" "));
}

const GIT_TIMEOUT_MS = 60_000;

export async function runDeploymentHealingRepair(input: DeploymentHealingRepairInput & {
  dependencies?: Partial<DeploymentHealingRepairDependencies>;
}): Promise<DeploymentHealingRepairResult> {
  const deps = buildDeps(input.dependencies);
  const timestamp = Math.floor(Date.now() / 1000);
  const fixBranch = `deploy-fix/${input.platform}-${timestamp}`;
  const prompt = buildDeploymentHealingPrompt(input);

  // Ensure repo cache is up to date
  const { repoCacheDir } = await deps.ensureRepoCache({
    rootDir: input.rootDir,
    repoFullName: input.repo,
    repoCloneUrl: input.repoCloneUrl,
    runCommand: deps.runCommand,
  });

  // Create and checkout fix branch from merge sha
  const checkoutResult = await deps.runCommand("git", [
    "-C", repoCacheDir, "checkout", "-b", fixBranch, input.mergeSha,
  ], { timeoutMs: GIT_TIMEOUT_MS });

  if (checkoutResult.code !== 0) {
    return {
      accepted: false,
      rejectionReason: `Failed to create fix branch: ${checkoutResult.stderr || checkoutResult.stdout}`,
      summary: "Branch creation failed",
      fixBranch,
      agentResult: checkoutResult,
    };
  }

  try {
    // Run the agent
    const agentResult = await deps.applyFixesWithAgent({
      agent: input.agent,
      cwd: repoCacheDir,
      prompt,
    });

    const summary = extractDeploymentHealingSummary(agentResult.stdout);

    // Check if agent made any commits
    const logResult = await deps.runCommand("git", [
      "-C", repoCacheDir, "log", `${input.mergeSha}..HEAD`, "--oneline",
    ], { timeoutMs: GIT_TIMEOUT_MS });

    const hasNewCommits = logResult.code === 0 && logResult.stdout.trim().length > 0;

    if (!hasNewCommits) {
      return {
        accepted: false,
        rejectionReason: "Agent did not create any commits",
        summary,
        fixBranch,
        agentResult,
      };
    }

    // Push the fix branch
    const pushResult = await deps.runCommand("git", [
      "-C", repoCacheDir, "push", "origin", fixBranch,
    ], { timeoutMs: GIT_TIMEOUT_MS });

    if (pushResult.code !== 0) {
      return {
        accepted: false,
        rejectionReason: `Failed to push fix branch: ${pushResult.stderr || pushResult.stdout}`,
        summary,
        fixBranch,
        agentResult,
      };
    }

    return {
      accepted: true,
      rejectionReason: null,
      summary,
      fixBranch,
      agentResult,
    };
  } finally {
    // Clean up: go back to detached HEAD so the branch can be reused later
    await deps.runCommand("git", ["-C", repoCacheDir, "checkout", "--detach"], { timeoutMs: GIT_TIMEOUT_MS });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test server/deploymentHealingAgent.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/deploymentHealingAgent.ts server/deploymentHealingAgent.test.ts
git commit -m "feat: add deployment healing agent with prompt builder and repair flow"
```

---

### Task 7: Background Job Handler

**Files:**
- Modify: `server/backgroundJobHandlers.ts`
- Test: `server/backgroundJobHandlers.test.ts`

- [ ] **Step 1: Write failing test for heal_deployment handler registration**

Add to `server/backgroundJobHandlers.test.ts`:

```typescript
test("heal_deployment handler is registered when deploymentHealingManager is provided", () => {
  const storage = new MemStorage();
  const handlers = createBackgroundJobHandlers({
    storage,
    deploymentHealingManager: {} as any,
  });
  assert.ok(handlers.heal_deployment);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test server/backgroundJobHandlers.test.ts`
Expected: FAIL because `deploymentHealingManager` is not a recognized parameter.

- [ ] **Step 3: Register the handler**

In `server/backgroundJobHandlers.ts`:

Add imports:
```typescript
import type { DeploymentHealingManager } from "./deploymentHealingManager";
import { createAdapter } from "./deploymentAdapters";
import { runDeploymentHealingRepair } from "./deploymentHealingAgent";
import type { DeploymentPlatform } from "@shared/schema";
import { buildOctokit, parseRepoSlug } from "./github";
```

Add `deploymentHealingManager` to the params type:
```typescript
deploymentHealingManager?: DeploymentHealingManager;
```

Add the handler in the returned object (after `process_release_run`):

```typescript
    heal_deployment: params.deploymentHealingManager
      ? async (job) => {
          const config = await storage.getConfig();
          const repo = readStringPayload(job, "repo");
          const platform = readStringPayload(job, "platform") as DeploymentPlatform | null;
          const mergeSha = readStringPayload(job, "mergeSha");
          const triggerPrNumber = job.payload.triggerPrNumber as number | undefined;
          const triggerPrTitle = readStringPayload(job, "triggerPrTitle") ?? "";
          const triggerPrUrl = readStringPayload(job, "triggerPrUrl") ?? "";
          const baseBranch = readStringPayload(job, "baseBranch") ?? "main";

          if (!repo || !platform || !mergeSha || !triggerPrNumber) {
            throw new CancelBackgroundJobError(
              `heal_deployment job ${job.id} is missing required payload fields`,
            );
          }

          const manager = params.deploymentHealingManager!;
          const session = await manager.ensureSession({
            repo,
            platform,
            triggerPrNumber,
            triggerPrTitle,
            triggerPrUrl,
            mergeSha,
          });

          // Wait for deployment to start
          const delayMs = config.deploymentCheckDelayMs;
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          // Poll deployment status
          const adapter = createAdapter(platform);
          const timeoutMs = config.deploymentCheckTimeoutMs;
          const pollMs = config.deploymentCheckPollIntervalMs;
          const deadline = Date.now() + timeoutMs;

          let lastStatus = await adapter.getDeploymentStatus({ repo, sha: mergeSha });

          while (
            (lastStatus.state === "building" || lastStatus.state === "deploying" || lastStatus.state === "not_found") &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            lastStatus = await adapter.getDeploymentStatus({ repo, sha: mergeSha });
          }

          if (lastStatus.state === "ready") {
            // Deployment succeeded, nothing to fix
            return;
          }

          if (lastStatus.state !== "error") {
            await manager.transitionTo(session.id, "escalated", {
              error: `Deployment timed out in state: ${lastStatus.state}`,
            });
            return;
          }

          // Deployment failed -- get logs and attempt fix
          const logs = lastStatus.deploymentId
            ? await adapter.getDeploymentLogs({ repo, deploymentId: lastStatus.deploymentId })
            : "No deployment ID available for log retrieval";

          await manager.transitionTo(session.id, "failed", {
            deploymentId: lastStatus.deploymentId,
            deploymentLog: logs,
          });

          await manager.transitionTo(session.id, "fixing");

          const parsedRepo = parseRepoSlug(repo);
          if (!parsedRepo) {
            await manager.transitionTo(session.id, "escalated", {
              error: `Invalid repo slug: ${repo}`,
            });
            return;
          }

          try {
            const repoCloneUrl = `https://github.com/${repo}.git`;
            const result = await runDeploymentHealingRepair({
              repo,
              platform,
              mergeSha,
              triggerPrNumber,
              triggerPrTitle,
              triggerPrUrl,
              deploymentLog: logs,
              baseBranch,
              repoCloneUrl,
              agent: config.codingAgent,
              githubToken: config.githubToken,
            });

            if (!result.accepted) {
              await manager.transitionTo(session.id, "escalated", {
                error: result.rejectionReason ?? "Agent fix was not accepted",
              });
              return;
            }

            // Create PR via Octokit
            const octokit = await buildOctokit(config);
            const pr = await octokit.pulls.create({
              owner: parsedRepo.owner,
              repo: parsedRepo.repo,
              title: `fix(deploy): ${result.summary}`,
              head: result.fixBranch,
              base: baseBranch,
              body: [
                "## Automated Deployment Fix",
                "",
                `**Platform:** ${platform}`,
                `**Trigger PR:** #${triggerPrNumber} -- ${triggerPrTitle}`,
                `**Merge SHA:** \`${mergeSha}\``,
                "",
                "### What failed",
                "```",
                logs.slice(0, 3000),
                "```",
                "",
                "### What changed",
                result.summary,
                "",
                "> This is an automated deployment fix created by oh-my-pr. Please review before merging.",
              ].join("\n"),
            });

            await manager.transitionTo(session.id, "fix_submitted", {
              fixBranch: result.fixBranch,
              fixPrNumber: pr.data.number,
              fixPrUrl: pr.data.html_url,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await manager.transitionTo(session.id, "escalated", {
              error: message.slice(0, 2000),
            });
          }
        }
      : undefined,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test server/backgroundJobHandlers.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/backgroundJobHandlers.ts server/backgroundJobHandlers.test.ts
git commit -m "feat: register heal_deployment background job handler"
```

---

### Task 8: Babysitter Integration

**Files:**
- Modify: `server/babysitter.ts`

- [ ] **Step 1: Add deployment healing manager to babysitter constructor**

Read the babysitter constructor to understand the existing pattern. Add `deploymentHealingManager` as an optional dependency, following the same pattern as `releaseManager`.

Add to the constructor's dependency type:
```typescript
deploymentHealingManager?: DeploymentHealingManager;
```

Store it as a private field:
```typescript
this.deploymentHealingManager = params.deploymentHealingManager ?? null;
```

Import `DeploymentHealingManager` and `detectDeploymentPlatform` at the top:
```typescript
import { DeploymentHealingManager } from "./deploymentHealingManager";
import { detectDeploymentPlatform } from "./deploymentPlatformDetector";
```

- [ ] **Step 2: Add deployment healing trigger after merge detection**

In `babysitter.ts`, after the existing release evaluation block (around line 1176, after the `} else if (closeState && !closeState.merged)` block and before `hadNewlyArchived = true`), add:

```typescript
if (closeState?.merged && this.deploymentHealingManager && config.autoHealDeployments) {
  const depBaseBranch = closeState.baseRef.trim();
  const depMergeSha = closeState.mergeCommitSha || closeState.headSha;
  if (depBaseBranch && depMergeSha) {
    try {
      const repoCloneUrl = `https://github.com/${repoSlug}.git`;
      const { repoCacheDir } = await ensureRepoCache({
        repoFullName: repoSlug,
        repoCloneUrl,
        runCommand,
      });
      const detected = await detectDeploymentPlatform(repoCacheDir);

      if (detected) {
        await this.scheduleBackgroundJob(
          "heal_deployment",
          `${repoSlug}:${depMergeSha}`,
          buildBackgroundJobDedupeKey("heal_deployment", `${repoSlug}:${depMergeSha}`),
          {
            repo: repoSlug,
            platform: detected.platform,
            mergeSha: depMergeSha,
            triggerPrNumber: pr.number,
            triggerPrTitle: pr.title,
            triggerPrUrl: pr.url,
            baseBranch: depBaseBranch,
          },
        );
        await this.storage.addLog(pr.id, "info", `PR #${pr.number} merged -- queued deployment healing (${detected.platform})`, {
          phase: "watcher",
          metadata: { platform: detected.platform, mergeSha: depMergeSha },
        });
      }
    } catch (error) {
      await this.storage.addLog(pr.id, "warn", `Failed to queue deployment healing: ${summarizeUnknownError(error)}`, {
        phase: "watcher",
      });
    }
  }
}
```

Also add imports for `ensureRepoCache` and `buildBackgroundJobDedupeKey` if not already imported (check existing imports first).

- [ ] **Step 3: Verify the babysitter has access to scheduleBackgroundJob**

Check if the babysitter already has a `scheduleBackgroundJob` method or property. If it does, use it. If not, it should be injected via the constructor (similar to how `releaseManager` gets `scheduleBackgroundJob`). Follow the existing pattern.

- [ ] **Step 4: Run existing babysitter tests to verify no regressions**

Run: `npx tsx --test server/babysitter.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/babysitter.ts
git commit -m "feat: trigger deployment healing after PR merge detection"
```

---

### Task 9: API Routes and MCP Tools

**Files:**
- Modify: `server/routes.ts`
- Modify: `server/mcp.ts`

- [ ] **Step 1: Add API routes**

In `server/routes.ts`, after the existing healing sessions routes (around line 691), add:

```typescript
  // -- Deployment healing -----------------------------------------------------

  app.get("/api/deployment-healing-sessions", async (req, res) => {
    try {
      const repo = typeof req.query.repo === "string" ? req.query.repo : undefined;
      const sessions = await storage.listDeploymentHealingSessions(repo ? { repo } : undefined);
      res.json(sessions);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/deployment-healing-sessions/:id", async (req, res) => {
    try {
      const session = await storage.getDeploymentHealingSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: "Deployment healing session not found" });
      }
      res.json(session);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
```

- [ ] **Step 2: Add MCP tools**

In `server/mcp.ts`, add to the `TOOLS` array before the closing `]`:

```typescript
  // -- Deployment healing -----------------------------------------------------
  {
    name: "list_deployment_healing_sessions",
    description: "List deployment healing sessions, optionally filtered by repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Optional repository slug 'owner/repo' to filter by." },
      },
      required: [],
    },
  },
  {
    name: "get_deployment_healing_session",
    description: "Get details of a single deployment healing session by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Deployment healing session ID." },
      },
      required: ["id"],
    },
  },
```

Add the handler cases in the `switch` statement:

```typescript
    case "list_deployment_healing_sessions": {
      const query = args.repo ? `?repo=${encodeURIComponent(args.repo as string)}` : "";
      return cfFetch("GET", `/api/deployment-healing-sessions${query}`);
    }
    case "get_deployment_healing_session":
      return cfFetch("GET", `/api/deployment-healing-sessions/${args.id}`);
```

- [ ] **Step 3: Wire up the DeploymentHealingManager in routes.ts**

In `server/routes.ts`, import `DeploymentHealingManager` and create an instance alongside the existing manager setup. Pass it to `createBackgroundJobHandlers` and to the babysitter:

```typescript
import { DeploymentHealingManager } from "./deploymentHealingManager";

// Inside registerRoutes, after releaseManager creation:
const deploymentHealingManager = new DeploymentHealingManager(storage);

// Pass to background job handlers:
const handlers = createBackgroundJobHandlers({
  storage,
  babysitter,
  releaseManager,
  deploymentHealingManager,
});
```

If the babysitter is constructed in `routes.ts`, pass `deploymentHealingManager` to its constructor as well.

- [ ] **Step 4: Run route tests to verify no regressions**

Run: `npx tsx --test server/routes.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/mcp.ts
git commit -m "feat: add deployment healing API routes and MCP tools"
```

---

### Task 10: Integration Test and Final Verification

**Files:**
- Run all tests

- [ ] **Step 1: Run the full test suite**

Run: `npx tsx --test server/*.test.ts`
Expected: All tests PASS.

- [ ] **Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Run lint**

Run: `npx eslint server/ shared/`
Expected: No lint errors.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve any remaining issues from deployment healing integration"
```

Skip this step if no changes were needed.
