# Terminal UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a full-screen Ink-based `oh-my-pr` terminal UI that becomes the primary CLI surface and runs the app runtime in-process.

**Architecture:** Extract a shared `AppRuntime` orchestration layer under `server/` so Express and the new Ink TUI call the same typed methods. Add a TUI module tree under `server/tui/`, keep background work on the existing durable queue, and switch the package CLI so `oh-my-pr` launches the TUI by default while `oh-my-pr web` still starts the browser dashboard.

**Tech Stack:** TypeScript, React, Ink, Express, Zod, Node test runner, `tsx`, esbuild

---

### Task 1: Extract The Shared App Runtime

**Files:**
- Create: `server/appRuntime.ts`
- Test: `server/appRuntime.test.ts`
- Modify: `server/routes.ts`
- Modify: `server/index.ts`
- Test: `server/routes.test.ts`

**Step 1: Write the failing runtime tests**

Add tests in `server/appRuntime.test.ts` that prove a runtime created around `MemStorage` can:

- list active and archived PRs,
- queue a babysitter run for a PR,
- toggle watch state,
- add a PR question and enqueue the durable answer job,
- update config and expose the new snapshot,
- emit a change event after a successful mutation.

Use explicit assertions on queued `background_jobs` rows so the runtime boundary is more than a pass-through getter.

**Step 2: Run the targeted runtime tests to verify they fail**

Run: `node --test --import tsx server/appRuntime.test.ts server/routes.test.ts`

Expected: FAIL because `server/appRuntime.ts` does not exist and routes still own orchestration directly.

**Step 3: Write the minimal runtime implementation**

Create `server/appRuntime.ts` with a factory shaped like:

```ts
export type AppRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: () => void): () => void;
  listPRs(view?: "active" | "archived"): Promise<PR[]>;
  getPR(id: string): Promise<PR | null>;
  queueBabysit(id: string): Promise<PR>;
  setWatchEnabled(id: string, enabled: boolean): Promise<PR>;
  setFeedbackDecision(prId: string, feedbackId: string, decision: "accept" | "reject" | "flag"): Promise<PR>;
  retryFeedback(prId: string, feedbackId: string): Promise<PR>;
  listLogs(prId?: string): Promise<LogEntry[]>;
  askQuestion(prId: string, question: string): Promise<PRQuestion>;
  listRepos(): Promise<string[]>;
  addRepo(repo: string): Promise<string[]>;
  addPR(url: string): Promise<PR>;
  getConfig(): Promise<Config>;
  updateConfig(updates: Partial<Config>): Promise<Config>;
  getRuntimeState(): Promise<RuntimeState & { activeRuns: number }>;
};
```

Move orchestration currently embedded in `server/routes.ts` behind these methods instead of duplicating logic.

**Step 4: Rewire Express to use the runtime**

Update `server/routes.ts` and `server/index.ts` so the web server constructs the shared runtime once and route handlers call runtime methods. Preserve current route shapes and HTTP responses.

**Step 5: Re-run the targeted runtime tests**

Run: `node --test --import tsx server/appRuntime.test.ts server/routes.test.ts`

Expected: PASS

**Step 6: Commit**

```bash
git add server/appRuntime.ts server/appRuntime.test.ts server/routes.ts server/index.ts server/routes.test.ts
git commit -m "refactor: extract shared app runtime"
```

### Task 2: Add CLI Mode Parsing And TUI Packaging

**Files:**
- Create: `server/cli.ts`
- Test: `server/cli.test.ts`
- Modify: `bin/codefactory.cjs`
- Modify: `script/build.ts`
- Modify: `package.json`

**Step 1: Write the failing CLI tests**

Add `server/cli.test.ts` that covers:

- no args selects TUI mode,
- `web` selects browser-server mode,
- `mcp` selects MCP mode,
- `--help` and `--version` still work,
- invalid subcommands return a friendly usage error.

**Step 2: Run the targeted CLI tests to verify they fail**

Run: `node --test --import tsx server/cli.test.ts`

Expected: FAIL because no parser module exists and the bin script only starts the web server.

**Step 3: Implement the CLI parser**

Create `server/cli.ts` with a pure parser like:

```ts
export type CliMode = "tui" | "web" | "mcp" | "help" | "version";

export function parseCliArgs(argv: string[]): { mode: CliMode; error?: string } {
  const command = argv[0];
  if (!command) return { mode: "tui" };
  if (command === "web") return { mode: "web" };
  if (command === "mcp") return { mode: "mcp" };
  if (command === "--help" || command === "-h") return { mode: "help" };
  if (command === "--version" || command === "-v") return { mode: "version" };
  return { mode: "help", error: `Unknown command: ${command}` };
}
```

**Step 4: Wire the packaged entrypoints**

Update:

- `bin/codefactory.cjs` to call the parser and dispatch to bundled outputs,
- `script/build.ts` to emit at least:
  - `dist/index.cjs`
  - `dist/tui.cjs`
  - `dist/mcp.cjs`
- `package.json` to add the `ink` dependency plus any TUI test dependency you actually use, such as `ink-testing-library`.

**Step 5: Re-run the targeted CLI tests**

Run: `node --test --import tsx server/cli.test.ts`

Expected: PASS

**Step 6: Commit**

```bash
git add server/cli.ts server/cli.test.ts bin/codefactory.cjs script/build.ts package.json package-lock.json
git commit -m "feat: add tui-first cli mode parsing"
```

### Task 3: Build Terminal View Models And Snapshot Hooks

**Files:**
- Create: `server/tui/viewModel.ts`
- Test: `server/tuiViewModel.test.ts`
- Create: `server/tui/useRuntimeSnapshot.ts`
- Create: `server/tui/useSelectionState.ts`

**Step 1: Write the failing view-model tests**

Add tests in `server/tuiViewModel.test.ts` for helpers that produce:

- PR row labels,
- watch / ready-to-merge indicators,
- feedback status labels,
- pane footer hints,
- narrow-layout decisions from terminal width.

Keep the tests pure and input/output focused.

**Step 2: Run the targeted view-model tests to verify they fail**

Run: `node --test --import tsx server/tuiViewModel.test.ts`

Expected: FAIL because the helper modules do not exist.

**Step 3: Implement the pure formatting helpers**

Create `server/tui/viewModel.ts` with functions such as:

```ts
export function formatPrRow(pr: PR): string { /* ... */ }
export function getFeedbackTone(status: FeedbackItem["status"]): "muted" | "info" | "success" | "warning" | "danger" { /* ... */ }
export function getLayoutMode(width: number): "full" | "stacked" | "compact-warning" { /* ... */ }
```

Match the browser dashboard's semantics, not its DOM structure.

**Step 4: Add runtime snapshot hooks**

Create:

- `server/tui/useRuntimeSnapshot.ts` for subscribing to the shared runtime and refreshing local snapshots
- `server/tui/useSelectionState.ts` for pane focus, selected PR index, selected feedback index, panel mode, and text-entry mode

Keep both hooks framework-local so Ink components remain small.

**Step 5: Re-run the targeted view-model tests**

Run: `node --test --import tsx server/tuiViewModel.test.ts`

Expected: PASS

**Step 6: Commit**

```bash
git add server/tui/viewModel.ts server/tui/useRuntimeSnapshot.ts server/tui/useSelectionState.ts server/tuiViewModel.test.ts
git commit -m "feat: add terminal view models and state hooks"
```

### Task 4: Build The Full-Screen Ink Shell

**Files:**
- Create: `server/tui/index.tsx`
- Create: `server/tui/App.tsx`
- Create: `server/tui/components/Header.tsx`
- Create: `server/tui/components/PrListPane.tsx`
- Create: `server/tui/components/PrDetailPane.tsx`
- Create: `server/tui/components/ContextPane.tsx`
- Create: `server/tui/components/Footer.tsx`
- Test: `server/tuiApp.test.tsx`

**Step 1: Write the failing shell interaction tests**

Add `server/tuiApp.test.tsx` that proves:

- the app renders the PR list from runtime data,
- arrow keys move PR selection,
- `Tab` cycles pane focus,
- `Enter` on a feedback row expands and collapses it,
- `l` and `a` switch the contextual pane between logs and ask-agent,
- the compact warning appears when terminal width is too small.

Use Ink's test renderer instead of snapshot-only assertions.

**Step 2: Run the targeted shell tests to verify they fail**

Run: `node --test --import tsx server/tuiApp.test.tsx`

Expected: FAIL because the Ink shell does not exist yet.

**Step 3: Implement the shell and layout**

Create `server/tui/App.tsx` and the pane components. Use a top-level structure like:

```tsx
<Box flexDirection="column" height={screenHeight}>
  <Header />
  <Box flexGrow={1}>
    <PrListPane />
    <PrDetailPane />
    <ContextPane />
  </Box>
  <Footer />
</Box>
```

Keep the shell focused on:

- loading state
- narrow-width fallback
- pane focus
- PR selection
- context-panel switching

**Step 4: Add the TUI process entrypoint**

In `server/tui/index.tsx`, validate TTY/raw-mode support, create the shared runtime, start it, render the Ink app, and cleanly stop runtime services on exit.

**Step 5: Re-run the targeted shell tests**

Run: `node --test --import tsx server/tuiApp.test.tsx`

Expected: PASS

**Step 6: Commit**

```bash
git add server/tui/index.tsx server/tui/App.tsx server/tui/components/Header.tsx server/tui/components/PrListPane.tsx server/tui/components/PrDetailPane.tsx server/tui/components/ContextPane.tsx server/tui/components/Footer.tsx server/tuiApp.test.tsx
git commit -m "feat: add full-screen ink shell"
```

### Task 5: Implement Feedback Triage And Live Logs

**Files:**
- Modify: `server/appRuntime.ts`
- Create: `server/tui/components/FeedbackList.tsx`
- Create: `server/tui/components/FeedbackActions.tsx`
- Create: `server/tui/components/LogPane.tsx`
- Modify: `server/tui/components/PrDetailPane.tsx`
- Modify: `server/tui/components/ContextPane.tsx`
- Test: `server/tuiFeedback.test.tsx`

**Step 1: Write the failing workflow tests**

Add `server/tuiFeedback.test.tsx` that proves:

- the selected feedback row can expand,
- inline actions can accept, reject, and flag the selected item,
- retry is only shown for `failed` and `warning` items,
- log rows update after a runtime log append event,
- the footer shows mutation errors without crashing the shell.

**Step 2: Run the targeted workflow tests to verify they fail**

Run: `node --test --import tsx server/tuiFeedback.test.tsx`

Expected: FAIL because the detail actions and log pane are still placeholders.

**Step 3: Implement the minimal feedback workflow**

Add Ink components that:

- render feedback metadata and wrapped body text,
- expose an inline decision strip,
- call the shared runtime mutation methods,
- preserve selection after a successful refresh.

Use explicit labels instead of single-letter controls inside the selected action strip.

**Step 4: Implement live log updates**

Render logs in `server/tui/components/LogPane.tsx` using runtime snapshots and subscriptions. Show:

- timestamp
- level
- phase
- message
- compact metadata block when present

Auto-scroll to the latest log only when the log pane owns focus.

**Step 5: Re-run the targeted workflow tests**

Run: `node --test --import tsx server/tuiFeedback.test.tsx`

Expected: PASS

**Step 6: Commit**

```bash
git add server/appRuntime.ts server/tui/components/FeedbackList.tsx server/tui/components/FeedbackActions.tsx server/tui/components/LogPane.tsx server/tui/components/PrDetailPane.tsx server/tui/components/ContextPane.tsx server/tuiFeedback.test.tsx
git commit -m "feat: add feedback triage and live logs to tui"
```

### Task 6: Implement Ask-Agent, Repo Watch Management, And Settings

**Files:**
- Modify: `server/appRuntime.ts`
- Create: `server/tui/components/AskPane.tsx`
- Create: `server/tui/components/RepoManagerPane.tsx`
- Create: `server/tui/components/SettingsPane.tsx`
- Modify: `server/tui/components/ContextPane.tsx`
- Modify: `server/tui/App.tsx`
- Test: `server/tuiOperatorFlows.test.tsx`
- Modify: `README.md`

**Step 1: Write the failing operator-flow tests**

Add `server/tuiOperatorFlows.test.tsx` that proves:

- `a` opens the ask-agent pane,
- entering a question queues a durable `answer_pr_question` job,
- repo manager can add a watched repo,
- repo manager can add a PR by URL,
- settings can toggle at least:
  - coding agent
  - auto-resolve conflicts
  - auto-update docs
- `w` pauses and resumes watch for the selected PR.

**Step 2: Run the targeted operator-flow tests to verify they fail**

Run: `node --test --import tsx server/tuiOperatorFlows.test.tsx`

Expected: FAIL because those panes and controls do not exist yet.

**Step 3: Implement ask-agent entry mode**

Create `server/tui/components/AskPane.tsx` with:

- question thread list
- input mode
- submit handling
- pending / answered / error states

Keep v1 to whole-answer refreshes only. Do not implement token streaming.

**Step 4: Implement repo and settings panels**

Create:

- `server/tui/components/RepoManagerPane.tsx`
- `server/tui/components/SettingsPane.tsx`

Allow simple arrow-and-enter editing for toggles and a basic text-entry mode for new repo / PR input.

**Step 5: Re-run the targeted operator-flow tests**

Run: `node --test --import tsx server/tuiOperatorFlows.test.tsx`

Expected: PASS

**Step 6: Update docs and verify the integrated surface**

Update `README.md` so Quick Start and CLI usage reflect the TUI-first command surface.

Run:

```bash
node --test --import tsx server/appRuntime.test.ts server/cli.test.ts server/tuiViewModel.test.ts server/tuiApp.test.tsx server/tuiFeedback.test.tsx server/tuiOperatorFlows.test.tsx server/routes.test.ts
npm run check
git diff --check
```

Expected:

- all targeted tests PASS
- `npm run check` PASS
- `git diff --check` prints no whitespace or conflict-marker errors

**Step 7: Commit**

```bash
git add server/appRuntime.ts server/tui/components/AskPane.tsx server/tui/components/RepoManagerPane.tsx server/tui/components/SettingsPane.tsx server/tui/components/ContextPane.tsx server/tui/App.tsx README.md server/tuiOperatorFlows.test.tsx
git commit -m "feat: ship terminal-native oh-my-pr tui"
```
