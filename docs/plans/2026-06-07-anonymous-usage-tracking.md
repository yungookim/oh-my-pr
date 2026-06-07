# Anonymous Usage Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add anonymous local usage totals and a simple over-time usage page for app opens, tracked PRs, merged PRs, and fixes made by oh-my-pr.

**Architecture:** Store aggregate usage totals and daily usage buckets locally in the app storage layer. Expose them through thin runtime and route methods, then render Settings usage totals plus a `/usage` page with simple charts. Store only counts and dates; do not persist repo names, PR URLs, user IDs, or event streams.

**Tech Stack:** TypeScript, Zod shared schemas, Express routes, MemStorage, SQLite, React Query, Wouter, Tailwind.

---

### Task 1: Shared Contract And Storage Tests

**Files:**
- Modify: `shared/schema.ts`
- Modify: `server/storage.ts`
- Modify: `server/memoryStorage.test.ts`
- Modify: `server/storage.test.ts`

**Steps:**
1. Add a `usageCounterKeyEnum`, `usageCountersSchema`, `usageDailyBucketSchema`, and `usageSummarySchema`.
2. Add `getUsageSummary()` and `incrementUsageCounter(counter, amount?, occurredAt?)` to `IStorage`.
3. Write failing memory and SQLite tests that increment counters across two dates and assert totals plus daily buckets.
4. Implement the smallest storage changes that make those tests pass.

### Task 2: Runtime And API

**Files:**
- Modify: `server/appRuntime.ts`
- Modify: `server/routes.ts`
- Modify: `server/routes.test.ts`

**Steps:**
1. Add runtime methods for usage read and app-open tracking.
2. Add `GET /api/usage` and `POST /api/usage/app-open`.
3. Write failing route tests that assert the API exposes only anonymous aggregate fields.
4. Implement route and runtime methods.

### Task 3: Product Hooks

**Files:**
- Modify: `server/appRuntime.ts`
- Modify: `server/babysitter.ts`
- Modify: `server/backgroundJobHandlers.ts`
- Modify: relevant server tests

**Steps:**
1. Increment tracked PRs when a new PR record is created.
2. Increment merged PRs when a tracked PR is observed as merged and archived.
3. Increment fixes made when babysitter pushes a new fix commit or deployment healing submits a fix PR.
4. Add focused regression tests for each hook.

### Task 4: Settings And Usage Page

**Files:**
- Modify: `client/src/App.tsx`
- Modify: `client/src/pages/settings.tsx`
- Create: `client/src/pages/usage.tsx`
- Modify: `client/src/lib/fullAppQaSurface.test.ts`

**Steps:**
1. Record app open once from the mounted app shell.
2. Add a compact Settings usage section linking to `/usage`.
3. Add a simple `/usage` page with totals and daily bar charts.
4. Add full-app surface assertions for the settings query/link and usage route.

### Verification

Run:
- `npm run test -- server/memoryStorage.test.ts server/storage.test.ts server/routes.test.ts`
- `npm run test:all`
- `npm run check`
