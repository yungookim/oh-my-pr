# Conditional PR Documentation Updates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Teach Code Factory to have the configured agent assess whether a tracked PR needs documentation updates and, when needed, include those docs changes in the autonomous PR babysitter run.

**Architecture:** Add a global `autoUpdateDocs` config flag plus a small per-PR docs-assessment record. Reuse the existing `evaluateFixNecessityWithAgent` JSON contract for a dedicated docs-assessment prompt that runs inside the prepared PR worktree, persist the result per head SHA, and inject a docs task into the normal fix prompt only when the current SHA needs docs work.

**Tech Stack:** TypeScript, Express, React, SQLite (`node:sqlite`), Node test runner (`node --test --import tsx`).

---

### Task 1: Add Shared Docs Assessment And Config Types

**Files:**
- Modify: `shared/schema.ts`
- Modify: `shared/models.ts`
- Modify: `server/defaultConfig.ts`
- Modify: `server/defaultConfig.test.ts`
- Modify: `server/github.test.ts`

**Step 1: Add failing config assertions**
Add assertions in `server/defaultConfig.test.ts` that require `autoUpdateDocs` to exist and default to `true`.

**Step 2: Run the default-config test**
Run: `node --test --import tsx server/defaultConfig.test.ts`
Expected: FAIL because `autoUpdateDocs` is not defined yet.

**Step 3: Implement the shared schema changes**
Add:
- `docsAssessmentStatusEnum`
- `docsAssessmentSchema`
- optional `docsAssessment` on `prSchema`
- `autoUpdateDocs` on `configSchema`
- `applyConfigUpdate` merge support
- `DEFAULT_CONFIG.autoUpdateDocs = true`
- any required config-fixture updates in `server/github.test.ts`

**Step 4: Re-run the default-config test**
Run: `node --test --import tsx server/defaultConfig.test.ts`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat: add docs assessment schema and config defaults"`

### Task 2: Persist Docs Assessment State And Config

**Files:**
- Modify: `server/memoryStorage.ts`
- Modify: `server/sqliteStorage.ts`
- Modify: `server/storage.test.ts`
- Modify: `server/memoryStorage.test.ts`

**Step 1: Add failing storage tests**
Add coverage for:
- `autoUpdateDocs` round-tripping through storage,
- `docsAssessment` round-tripping on a stored PR,
- config fallback still returning `autoUpdateDocs: true` when the singleton config row is missing.

**Step 2: Run targeted storage tests**
Run: `node --test --import tsx server/storage.test.ts server/memoryStorage.test.ts`
Expected: FAIL.

**Step 3: Implement storage persistence**
Implement:
- config parsing/writing for `autoUpdateDocs`,
- `docs_assessment_json` in the SQLite `prs` table definition,
- matching `ensureColumn` migration for existing databases,
- JSON serialize/deserialize for PR docs assessment state,
- memory-storage preservation of the same field.

**Step 4: Re-run targeted storage tests**
Run: `node --test --import tsx server/storage.test.ts server/memoryStorage.test.ts`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat: persist per-pr docs assessment state"`

### Task 3: Expose The Global Docs Toggle In Product Surfaces

**Files:**
- Modify: `client/src/pages/dashboard.tsx`
- Modify: `client/src/pages/settings.tsx`
- Modify: `server/mcp.ts`

**Step 1: Add the product controls**
Implement:
- a dashboard-header checkbox alongside the existing autonomous controls,
- a settings-page control with a short explanation of what the feature does,
- MCP `update_config` schema/description support for `autoUpdateDocs`.

**Step 2: Run strict typecheck**
Run: `npm run check`
Expected: PASS.

**Step 3: Run the production build**
Run: `npm run build`
Expected: PASS.

**Step 4: Manual config smoke check**
Start the app, toggle `autoUpdateDocs` off and on, and confirm the setting persists across a refresh.

**Step 5: Commit**
`git commit -m "feat: add auto-update docs configuration controls"`

### Task 4: Add Worktree-Based Documentation Assessment

**Files:**
- Modify: `server/babysitter.ts`
- Modify: `server/babysitter.test.ts`

**Step 1: Add failing babysitter tests for assessment behavior**
Add tests for:
- docs assessment runs on the first unseen head SHA when `autoUpdateDocs` is enabled,
- `not_needed` on the same SHA skips reassessment,
- `failed` on the same SHA retries assessment,
- disabled config skips docs assessment entirely.

**Step 2: Run the babysitter test file**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: FAIL.

**Step 3: Implement the docs assessment flow**
Implement:
- `buildDocumentationAssessmentPrompt(...)`,
- stale/failed-SHA detection using `pr.docsAssessment`,
- worktree preparation when docs assessment is due,
- base-branch fetch plus diff context collection (`git diff --name-only` / `--stat`),
- agent evaluation for docs need using the existing evaluation helper,
- PR-state/log updates for `needed`, `not_needed`, and `failed`.

**Step 4: Re-run the babysitter tests**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: PASS for the assessment-only cases.

**Step 5: Commit**
`git commit -m "feat: assess documentation needs in pr worktrees"`

### Task 5: Make Docs-Needed A First-Class Remediation Task

**Files:**
- Modify: `server/babysitter.ts`
- Modify: `server/babysitter.test.ts`

**Step 1: Add failing remediation tests**
Add tests for:
- a `needed` docs assessment extending the autonomous fix prompt,
- docs-needed work alone triggering agent execution even with zero comment/status tasks,
- `not_needed` leaving the fix prompt unchanged,
- a failed fix run preserving the `needed` state for same-SHA retry.

**Step 2: Run the babysitter test file**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: FAIL.

**Step 3: Implement docs remediation integration**
Implement:
- a docs section in `buildAgentFixPrompt(...)`,
- prompt wording that lets the agent choose the right repository docs while following repo conventions,
- `hasAgentWork` support for docs-only remediation,
- same-SHA reuse of successful docs decisions,
- preservation of `needed` state across failed remediation runs.

**Step 4: Re-run the babysitter tests**
Run: `node --test --import tsx server/babysitter.test.ts`
Expected: PASS.

**Step 5: Commit**
`git commit -m "feat: include docs updates in autonomous pr remediation"`

### Task 6: Final Verification Sweep

**Files:**
- Modify: only files above as needed

**Step 1: Run targeted backend tests**
Run: `node --test --import tsx server/defaultConfig.test.ts server/storage.test.ts server/memoryStorage.test.ts server/babysitter.test.ts`
Expected: PASS.

**Step 2: Run the full server test suite**
Run: `node --test --import tsx server/*.test.ts`
Expected: PASS.

**Step 3: Run strict typecheck**
Run: `npm run check`
Expected: PASS.

**Step 4: Run the production build**
Run: `npm run build`
Expected: PASS.

**Step 5: Commit final verification fixes**
`git commit -m "test: verify conditional pr documentation update flow"`
