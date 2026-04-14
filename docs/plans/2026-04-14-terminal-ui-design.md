# Terminal UI Design

**Date:** 2026-04-14
**Status:** Approved

## Goal

Add a full-screen terminal-native interface for `oh-my-pr` that becomes the primary CLI surface for day-to-day operator workflows. The TUI must own the runtime in-process, not proxy through a separate daemon by default.

## Reference

Claude Code appears to be built on [Ink](https://github.com/vadimdemedes/ink), based on Anthropic's public issue [anthropics/claude-code#5925](https://github.com/anthropics/claude-code/issues/5925), whose runtime error text states that "Ink uses as input stream by default." That is the strongest direct public signal for the UI library, so Ink is the correct baseline for a Claude Code-style terminal experience here.

## User-Approved Product Decisions

- The TUI is a full-screen `oh-my-pr` interface, not a thin wrapper over the browser app.
- The TUI owns the app runtime in-process and starts background services directly.
- The first end-to-end workflows are:
  - PR list/detail
  - feedback triage
  - live logs
  - ask-agent
  - repo watch management
  - settings
- Interaction model is intentionally simple:
  - list/detail layout
  - arrow-key navigation
  - `Enter` for expand/confirm
  - no command palette in v1

## Scope

### In Scope

- A bundled Ink-based TUI entrypoint shipped with `oh-my-pr`.
- Runtime extraction so both Express and the TUI call the same orchestration layer.
- Full-screen layout with:
  - PR list pane
  - selected PR detail pane
  - contextual logs / ask-agent pane
  - header/footer status chrome
- Mutations for:
  - run babysitter
  - pause/resume PR watch
  - accept/reject/flag feedback
  - retry failed feedback
  - add watched repo
  - add PR by URL
  - update key settings
- Terminal-safe error, loading, and narrow-width states.

### Out Of Scope

- Releases and social changelogs in v1.
- Rich HTML rendering parity with the browser dashboard.
- Token-by-token streaming answers in ask-agent.
- Mouse-first interaction patterns.
- A background daemon requirement for normal use.

## Current Architecture Problem

The current CLI surface is only a tiny wrapper around the bundled Express server. The browser dashboard owns the usable interface, while orchestration logic is distributed across route handlers and service classes. That creates three problems for a terminal-native product:

1. The CLI cannot become primary without a real runtime-facing UI surface.
2. A direct TUI implementation would either duplicate route logic or speak HTTP to its own process.
3. Testing terminal behavior cleanly is hard if routes remain the orchestration boundary.

## Proposed Architecture

### 1. Extract A Shared App Runtime

Create a new runtime module under `server/` that owns:

- storage
- background job queue
- background job dispatcher
- babysitter
- watcher scheduler
- release manager
- deployment healing manager
- runtime state / config access

This runtime becomes the source of truth for operator actions and snapshots. Express routes and the TUI become adapters over the same typed runtime API.

### 2. Keep Express As A Thin Secondary Surface

`server/routes.ts` should stop owning workflow orchestration directly. Instead, it should translate HTTP requests into runtime method calls such as:

- `listPRs()`
- `listArchivedPRs()`
- `getPR(id)`
- `queueBabysit(id)`
- `setPRWatchEnabled(id, enabled)`
- `setFeedbackDecision(prId, feedbackId, decision)`
- `retryFeedback(prId, feedbackId)`
- `listLogs(prId?)`
- `askQuestion(prId, question)`
- `listRepos()`
- `addRepo(repo)`
- `addPR(url)`
- `getConfig()`
- `updateConfig(updates)`

That preserves the browser dashboard without letting HTTP remain the architecture center.

### 3. Build The TUI On Ink

The TUI should live in a dedicated `server/tui/` module tree and use Ink's React rendering model for:

- pane composition
- keyboard input
- screen clearing
- terminal resize handling
- testable component rendering

Ink is a strong fit because it matches the Claude Code reference point and allows the TUI to share React mental models with the existing frontend team without forcing browser-only dependencies into the terminal surface.

## Runtime API Shape

The runtime should expose two kinds of interfaces.

### Commands

Typed imperative methods for mutations and fetches:

- `getSnapshot()`
- `listPRs(view)`
- `selectPR(id)`
- `queuePRRun(id)`
- `setWatchEnabled(id, enabled)`
- `setFeedbackDecision(prId, feedbackId, decision)`
- `retryFeedback(prId, feedbackId)`
- `listLogs(prId?)`
- `askQuestion(prId, question)`
- `listRepos()`
- `addRepo(repo)`
- `addPR(url)`
- `getConfig()`
- `updateConfig(updates)`

### Subscriptions

Evented updates for UI refresh without forcing the TUI to poll every screen element:

- PR collection changed
- PR detail changed
- logs appended
- questions changed
- repos changed
- config changed
- runtime state changed

An internal `EventEmitter`-style mechanism is sufficient for v1.

## TUI Layout

### Default Layout

- Header: app identity, runtime state, active agent, poll interval, counts, focus hint
- Left pane: active/archived PR list
- Center pane: selected PR summary and feedback list
- Right pane: contextual panel with logs or ask-agent
- Footer: key hints and transient error/status messages

### Narrow Layout

If the terminal width is too small for a three-pane layout, degrade gracefully:

- keep PR list on the left
- stack detail and context panels vertically
- if the window is too narrow for useful interaction, show a centered resize warning instead of broken output

## Interaction Model

The interaction model stays deliberately conservative.

### Navigation

- Arrow keys move inside the focused panel.
- `Tab` cycles focus between panes.
- `Enter` expands/collapses feedback rows and confirms the currently highlighted action.
- `Esc` exits text-entry mode or closes transient overlays.
- `q` quits from the main shell when not editing text.

### High-Value Actions

Use a small set of single-key shortcuts only where they save obvious friction:

- `r`: queue babysitter run for selected PR
- `w`: pause/resume watch for selected PR
- `l`: switch contextual pane to logs
- `a`: switch contextual pane to ask-agent
- `s`: open settings panel
- `/`: start quick filter in the PR list

Feedback decision making should remain explicit. The selected feedback row opens an inline action strip where the user can choose accept, reject, flag, or retry with arrows plus `Enter`.

## Data Flow

1. `oh-my-pr` starts the shared runtime.
2. The runtime starts storage-backed services in-process.
3. The TUI loads an initial snapshot from runtime methods.
4. User actions call typed runtime commands directly.
5. Background jobs continue to run through the existing durable queue.
6. Runtime events update the TUI state, with lightweight periodic refresh only where existing subsystems already expose polling boundaries.

This avoids the anti-pattern of a TUI making loopback HTTP requests to its own process.

## Error Handling

### Startup Errors

Startup failures should render a full-screen terminal error panel with the actionable cause, including:

- missing GitHub authentication
- missing configured coding agent CLI
- storage initialization failure
- unsupported raw-mode / non-TTY execution

### Runtime Errors

- Mutations should report failures in the footer status area and keep the message visible until the next successful action.
- Panels with stale data should show a small status note instead of clearing useful prior content immediately.
- Ask-agent failures should remain attached to the affected question row.

## Testing Strategy

### Runtime Tests

Add unit tests around the extracted runtime layer first. That is the behavior boundary that must stay consistent across web and terminal surfaces.

### TUI Tests

Use Ink's testing utilities to cover:

- pane focus and arrow navigation
- PR selection changes
- feedback row expansion
- decision action flows
- contextual pane switching
- settings toggles
- error rendering

### CLI Tests

Add small CLI parsing / mode selection tests so the packaged command surface is stable.

## Packaging And Command Surface

`oh-my-pr` should become the TUI-first command. The existing browser dashboard remains available through an explicit subcommand such as `oh-my-pr web`.

Expected command surface:

- `oh-my-pr` -> start TUI
- `oh-my-pr web` -> start browser dashboard server
- `oh-my-pr mcp` -> start MCP server
- `oh-my-pr --help`
- `oh-my-pr --version`

This makes the terminal app the primary operator interface while preserving the current web and MCP surfaces.

## Implementation Notes

- Keep the TUI code in `server/tui/` to colocate it with runtime access and CLI entrypoints.
- Do not pull browser dashboard components into the terminal surface.
- Prefer small pure helpers for formatting status labels, counters, and keyboard state so the Ink components stay thin.
- Preserve the current durable background job system. The TUI is a new operator surface, not a rewrite of execution semantics.

## Success Criteria

The feature is successful when:

- `oh-my-pr` launches directly into a usable full-screen TUI.
- The TUI can complete the approved workflows end to end without needing the browser dashboard.
- Web routes and TUI commands share the same runtime orchestration layer.
- The TUI is covered by focused keyboard-navigation and runtime tests.
