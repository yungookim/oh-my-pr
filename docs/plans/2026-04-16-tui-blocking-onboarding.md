# TUI Blocking Onboarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a blocking first-run TUI onboarding screen that collects one `owner/repo` slug before the main terminal UI appears.

**Architecture:** Keep the implementation inside the existing Ink app. Gate the main panes in `server/tui/App.tsx`, render a dedicated onboarding component when both `config.watchedRepos` and tracked PRs are empty, and reuse the existing `runtime.addRepo(...)` behavior for validation and persistence.

**Tech Stack:** TypeScript, React, Ink, Node test runner, ink-testing-library

---

### Task 1: Add a dedicated onboarding screen component

**Files:**
- Create: `server/tui/components/OnboardingScreen.tsx`

**Step 1: Write the component with a single-purpose API**

Create a presentational component that receives:

- `value: string`
- `errorMessage: string | null`

Render:

- app title
- short onboarding copy
- one input row labelled `Repository`
- examples like `owner/repo`
- compact key hints for `Enter`, `Esc`, and `q`
- inline error text when present

**Step 2: Keep the screen terminal-safe**

Use existing TUI theme primitives and simple `Box`/`Text` layout only. Avoid introducing a second focus model or extra navigation.

**Step 3: Commit**

```bash
git add server/tui/components/OnboardingScreen.tsx
git commit -m "feat: add tui onboarding screen"
```

### Task 2: Gate the TUI behind first-run onboarding

**Files:**
- Modify: `server/tui/App.tsx`
- Modify: `server/tui/useSelectionState.ts`

**Step 1: Write the failing test**

Add a test in `server/tuiApp.test.tsx` that renders the app with:

- `repos: []`
- `prs: []`
- `config.watchedRepos: []`

Assert that the frame shows onboarding copy and does not show `Pull Requests`.

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test server/tuiApp.test.tsx`
Expected: FAIL because the onboarding screen does not exist yet.

**Step 3: Implement the render gate**

In `server/tui/App.tsx`:

- derive `needsOnboarding` from `snapshot.config?.watchedRepos.length === 0 && snapshot.prs.length === 0`
- when true, render `OnboardingScreen`
- route text input to a repo-only onboarding draft instead of the normal pane behavior
- submit with `runtime.addRepo(...)`
- clear with `Esc`
- preserve `q` quit behavior

Keep the existing pane UI untouched when onboarding is not needed.

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test server/tuiApp.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add server/tui/App.tsx server/tui/useSelectionState.ts server/tuiApp.test.tsx
git commit -m "feat: gate tui with first-run onboarding"
```

### Task 3: Prove invalid input stays blocked with an inline error

**Files:**
- Modify: `server/tuiApp.test.tsx`
- Modify: `server/tui/testRuntime.ts`

**Step 1: Write the failing test**

Add a test that:

- renders the onboarding state
- types an invalid repo like `not a slug`
- presses `Enter`

Assert:

- onboarding remains visible
- the inline error mentions valid `owner/repo` format

**Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test server/tuiApp.test.tsx`
Expected: FAIL because the test runtime currently accepts any repo string.

**Step 3: Write minimal implementation**

Update `server/tui/testRuntime.ts` so `addRepo(...)` mirrors the production constraint closely enough for the TUI tests:

- reject values that do not match `owner/repo`
- when accepted, update both `state.repos` and `state.config.watchedRepos`

Keep the runtime stub narrow; do not reimplement full GitHub parsing.

**Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test server/tuiApp.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add server/tuiApp.test.tsx server/tui/testRuntime.ts
git commit -m "test: cover invalid tui onboarding repo input"
```

### Task 4: Verify successful transition and legacy bypass

**Files:**
- Modify: `server/tuiApp.test.tsx`

**Step 1: Write the failing tests**

Add:

1. A test that types `acme/widgets`, presses `Enter`, and asserts the app transitions from onboarding to the normal TUI.
2. A test that renders with `prs` populated but `config.watchedRepos: []` and asserts the normal TUI appears immediately.

**Step 2: Run test to verify they fail or are incomplete**

Run: `./node_modules/.bin/tsx --test server/tuiApp.test.tsx`
Expected: at least one assertion fails before the full behavior is in place.

**Step 3: Finish the minimal implementation**

Ensure the app refresh path and onboarding gate respond immediately after `addRepo(...)` succeeds.

**Step 4: Run the targeted tests**

Run: `./node_modules/.bin/tsx --test server/tuiApp.test.tsx server/tuiOperatorFlows.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add server/tuiApp.test.tsx
git commit -m "test: verify tui onboarding transition and bypass"
```

### Task 5: Final verification

**Files:**
- Test: `server/tuiApp.test.tsx`
- Test: `server/tuiOperatorFlows.test.tsx`
- Test: `server/tuiFeedback.test.tsx`

**Step 1: Run focused regression coverage**

Run:

```bash
./node_modules/.bin/tsx --test server/tuiApp.test.tsx server/tuiOperatorFlows.test.tsx server/tuiFeedback.test.tsx
```

Expected: PASS

**Step 2: Run typecheck if the surface changed materially**

Run:

```bash
npm run check
```

Expected: PASS

**Step 3: Commit**

```bash
git add server/tui/App.tsx server/tui/components/OnboardingScreen.tsx server/tui/testRuntime.ts server/tuiApp.test.tsx docs/plans/2026-04-16-tui-blocking-onboarding-design.md docs/plans/2026-04-16-tui-blocking-onboarding.md
git commit -m "feat: add blocking tui onboarding"
```
