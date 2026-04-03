# Deployment Healing Feature

**Date:** 2026-04-03
**Status:** Approved

## Overview

Automatically detect how a watched repository is deployed, monitor deployments after PR merges, and attempt to fix deployment failures by invoking a coding agent in an isolated worktree — submitting the fix as a PR for human review.

## Decisions

- **Platforms:** Vercel and Railway only (v1). Designed for extensibility.
- **Detection:** Fully automatic — scan repo for config files, no user confirmation needed.
- **Trigger:** Event-driven — monitor after a tracked PR merges to the default branch.
- **Fix strategy:** Single attempt, then escalate. No retry loops.
- **PR convention:** Fix branch named `deploy-fix/{platform}-{timestamp}`. Always requires human review (no auto-merge).

## Platform Detection

A `deploymentPlatformDetector.ts` module exports `detectDeploymentPlatform(repoPath: string): Promise<PlatformDetection | null>` that scans for:

| Platform | Signals |
|----------|---------|
| Vercel | `vercel.json`, `.vercel/project.json`, or `"vercel"` in package.json scripts |
| Railway | `railway.toml`, `railway.json`, or `nixpacks.toml` |

Detection runs during the sync cycle inside `syncAndBabysitTrackedRepos`. The result is used at merge time to decide whether to enqueue a deployment healing job. If no platform is detected, deployment healing is silently skipped.

## Deployment Monitoring Trigger

When the babysitter detects a PR merge (`babysitter.ts:~1127`, alongside the existing release evaluation trigger), it enqueues a `heal_deployment` background job if:

1. A deployment platform was detected for that repo
2. `autoHealDeployments` config flag is `true`
3. The merge target is the repo's default/production branch

Job payload: `{ repo, platform, mergeSha, prNumber, prTitle, prUrl }`.

The job handler then:

1. Waits `deploymentCheckDelayMs` (default 60s) for the platform to start the deployment
2. Polls deployment status via the platform CLI adapter with `deploymentCheckPollIntervalMs` (default 15s) intervals, up to `deploymentCheckTimeoutMs` (default 10 min)
3. If **success** — job completes, log it
4. If **failure** — transitions to the fix phase

## Platform Adapters

A `DeploymentPlatformAdapter` interface abstracts CLI interactions:

```typescript
interface DeploymentPlatformAdapter {
  platform: "vercel" | "railway";
  detectConfig(repoPath: string): Promise<PlatformDetection | null>;
  getDeploymentStatus(opts: { repo: string; sha: string }): Promise<DeploymentStatus>;
  getDeploymentLogs(opts: { repo: string; deploymentId: string }): Promise<string>;
}

type PlatformDetection = {
  platform: "vercel" | "railway";
  configPath: string;
};

type DeploymentStatus = {
  state: "building" | "deploying" | "ready" | "error" | "not_found";
  deploymentId: string | null;
  url: string | null;
  error: string | null;
};
```

**Vercel adapter** uses `vercel list --meta gitCommitSha=<sha> --json` to find the deployment, `vercel inspect <id> --json` for status, and `vercel logs <url>` for failure logs.

**Railway adapter** uses `railway status --json` for current deployment state and `railway logs` for failure output. Commands run from the worktree's cwd since Railway ties to the linked project in the repo directory.

Both adapters use the existing `runCommand` from `agentRunner.ts` for consistent command execution.

File: `server/deploymentAdapters.ts`

## Fix Attempt & PR Creation

When a deployment failure is detected:

1. **Prepare worktree** using existing `preparePrWorktree` from `repoWorkspace.ts`, branching from the merge SHA on the default branch
2. **Create fix branch** named `deploy-fix/{platform}-{timestamp}` (e.g., `deploy-fix/vercel-1743638400`)
3. **Build agent prompt** including:
   - The deployment platform and failure context
   - The full deployment log output
   - Instructions to fix the deployment issue with minimal changes
4. **Invoke agent** via existing `agentRunner.ts` (codex or claude per user config)
5. **Commit & push** the fix branch
6. **Create PR** via Octokit targeting the default branch, with body containing:
   - What deployment failed and why
   - What the agent changed
   - Note that this is an automated fix requiring human review
7. **Log outcome** to the existing log system

If any step fails, log the failure, mark the session as `escalated`, and stop. No retry loop.

File: `server/deploymentHealingAgent.ts`

## Data Model

### New background job kind

Add `"heal_deployment"` to `backgroundJobKindEnum` in `shared/schema.ts`.

### New config fields

```typescript
autoHealDeployments: z.boolean()          // default false
deploymentCheckDelayMs: z.number()        // default 60_000
deploymentCheckTimeoutMs: z.number()      // default 600_000
deploymentCheckPollIntervalMs: z.number() // default 15_000
```

### Deployment healing session schema

```typescript
deploymentHealingSessionSchema = z.object({
  id: z.string(),
  repo: z.string(),
  platform: z.enum(["vercel", "railway"]),
  triggerPrNumber: z.number(),
  triggerPrTitle: z.string(),
  triggerPrUrl: z.string(),
  mergeSha: z.string(),
  deploymentId: z.string().nullable(),
  deploymentLog: z.string().nullable(),
  fixBranch: z.string().nullable(),
  fixPrNumber: z.number().nullable(),
  fixPrUrl: z.string().nullable(),
  state: z.enum(["monitoring", "failed", "fixing", "fix_submitted", "escalated"]),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
```

Linear state machine: `monitoring -> failed -> fixing -> fix_submitted | escalated`.

### Storage layer

New CRUD methods on `IStorage` and `SqliteStorage` for deployment healing sessions, plus a new `deployment_healing_sessions` SQLite table. `MemoryStorage` gets a matching in-memory implementation for tests.

## Integration Points

### Background job handler

Register `heal_deployment` in `backgroundJobHandlers.ts`. The handler instantiates the appropriate platform adapter, monitors deployment, and delegates to `deploymentHealingAgent.ts` on failure.

### Babysitter hook

In the merge detection block (`babysitter.ts:~1127`), after the release evaluation check:

```typescript
if (closeState?.merged && config.autoHealDeployments && detectedPlatform) {
  // enqueue heal_deployment job
}
```

The babysitter gains a reference to a `DeploymentHealingManager`.

### API routes

Two new read-only endpoints:

- `GET /api/deployment-healing-sessions` — list sessions
- `GET /api/deployment-healing-sessions/:id` — get session detail

### MCP tools

Two new tools:

- `list_deployment_healing_sessions` — list with optional repo filter
- `get_deployment_healing_session` — get by ID

### Dashboard

Not in scope for v1. API is sufficient; UI can be added later.

## File Change Summary

| File | Action | Purpose |
|------|--------|---------|
| `shared/schema.ts` | Modify | Add `heal_deployment` job kind, `deploymentHealingSessionSchema`, new config fields |
| `server/deploymentPlatformDetector.ts` | New | Scan repo for Vercel/Railway config files |
| `server/deploymentAdapters.ts` | New | `DeploymentPlatformAdapter` interface + Vercel/Railway implementations |
| `server/deploymentHealingManager.ts` | New | Session CRUD, job enqueuing, state transitions |
| `server/deploymentHealingAgent.ts` | New | Worktree -> agent -> push -> PR orchestration |
| `server/backgroundJobHandlers.ts` | Modify | Register `heal_deployment` handler |
| `server/babysitter.ts` | Modify | Enqueue deployment healing after merge detection |
| `server/storage.ts` | Modify | Add `IStorage` methods for deployment healing sessions |
| `server/sqliteStorage.ts` | Modify | Implement new table + CRUD |
| `server/memoryStorage.ts` | Modify | In-memory implementation for tests |
| `server/routes.ts` | Modify | Add two GET endpoints |
| `server/mcp.ts` | Modify | Add two MCP tools |

## Out of Scope

- Dashboard UI
- Platforms beyond Vercel and Railway
- Retry loops / multiple fix attempts
- Auto-merge of fix PRs
