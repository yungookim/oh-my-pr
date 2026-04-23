# Test Guidelines

This repository expects development to be test-led, narrow, and proven before a task is called complete. Use this file as the canonical testing guide for agents and contributors.

## How to Run Tests

- Install dependencies with `npm install`.
- Run the standard server test suite with `npm run test`.
- Run typechecking with `npm run check`.
- Run the full current TypeScript test surface, including client utility tests, with:

```sh
node --import tsx --test server/*.test.ts client/src/lib/*.test.ts
```

- When a change affects production bundling, startup behavior, shared contracts, or client/server integration, also run `npm run build`.
- When a change affects docs output, run the relevant docs build command, usually `npm run build:public-docs` or `npm run build:docs`.
- When checking coverage locally, use Node's test coverage runner against the tests that exercise the changed area:

```sh
node --experimental-test-coverage --import tsx --test server/*.test.ts client/src/lib/*.test.ts
```

## Completion Expectations

After development is done:

- The relevant test suite must pass before the task is marked complete.
- `npm run check` must pass for code changes.
- New behavior must have focused regression coverage unless the change is docs-only, generated-only, or explicitly untestable in this repo.
- Critical path changes must demonstrate at least 70% coverage of the affected critical path. Treat this as branch and behavior coverage for the product workflow, not only raw line coverage.
- If a critical path cannot be measured cleanly with the current tooling, document the gap in the PR and cover the path with the highest-value automated tests available.
- Verification notes must list the exact commands run and any tests intentionally skipped.

Critical paths include PR ingestion, GitHub feedback parsing, feedback lifecycle transitions, babysitter orchestration, repo workspace preparation, agent execution, durable background jobs, storage persistence, CI/deployment healing, and dashboard flows that trigger those backend behaviors.

## TDD Requirement

For every feature, bug fix, refactor, or behavior change, the assigned agent must use the red-green-refactor loop before editing production code. Docs-only, generated-only, config-only, and throwaway prototype work may skip TDD only when that scope is explicit or the human reviewer approves the exception.

- RED: write down the expected passing, failing, and edge cases, then add or update one focused automated test for the first behavior.
- Verify RED: run the focused test and confirm it fails for the expected product reason, not a typo, import error, or broken harness.
- GREEN: write the smallest production change that makes the failing test pass.
- Verify GREEN: rerun the focused test and the relevant surrounding suite.
- REFACTOR: clean up only after tests are green, then rerun the relevant tests.
- Repeat the loop for each additional behavior or edge case.
- If a failing test cannot be written because the harness is missing, add the smallest useful harness improvement first and verify that the new behavior test fails before implementing the production behavior.

## Repository Test Patterns

Follow the patterns already used in this repository:

- Use `node:test` and `node:assert/strict` for unit and integration tests.
- Keep server tests beside server modules as `server/*.test.ts`.
- Keep client utility tests beside the utility under `client/src/lib/*.test.ts`.
- Name tests by observable behavior, such as `"BackgroundJobQueue reclaims expired leases"` or `"classifyCIFailure marks build failures as healable in branch"`.
- Use small local factories and harnesses, such as `seedPR`, `createHarness`, or `makeFeedbackItem`, when setup repeats or realistic object shape matters.
- Prefer direct assertions on outputs, persisted state, queued jobs, and side effects over snapshots.
- Use deterministic timestamps, IDs, PR numbers, and repository names.
- Use `mkdtemp(path.join(os.tmpdir(), "..."))` for filesystem tests so runs are isolated and repeatable.
- Stub external boundaries with injected dependencies or local fakes instead of calling GitHub, shelling out to real repositories, or depending on global machine state.
- Restore mutated globals and environment variables in `finally` blocks.
- Close HTTP servers, storage handles, child processes, and temporary resources before a test exits.
- Prefer in-memory storage (`MemStorage`) for route and orchestration behavior unless SQLite persistence itself is under test.
- Prefer raw SQLite setup only when verifying migration, reload, locking, or persistence behavior.

## Pattern-Specific Best Practices

Use the narrowest test style that proves the behavior:

- Pure helpers: construct explicit inputs and assert exact outputs, categories, fingerprints, summaries, and fallback behavior.
- Storage and migrations: use a temp root, write through one storage instance, close it, reopen it, and assert durable state from the second instance.
- Route behavior: create an ephemeral Express server, inject `MemStorage`, disable background services, call `fetch`, and assert both HTTP response and storage side effects.
- Background jobs: assert ordering, dedupe keys, lease tokens, heartbeats, retry/requeue behavior, and terminal status transitions with fixed `now` values.
- GitHub integration: fake Octokit or `fetch`, assert normalized records and outbound payloads, and avoid unauthenticated network calls.
- Repo workspace and command execution: inject `runCommand`, record calls, create temp directories only when the behavior needs real filesystem state, and assert command intent plus returned paths.
- Shared contracts and defaults: assert required fields, schema validation, enum handling, numeric invariants, and safe defaults.
- TUI and view-model tests: assert stable rendered text or view-model state, especially wrapping, truncation, status labels, keyboard interactions, and action availability. Use deterministic dimensions and disabled timers where the harness supports them.
- Regression tests: reproduce the reported failure first, then assert the smallest externally visible behavior that prevents recurrence.

## PR Checklist

Before opening or updating a PR:

- Confirm the test cases were identified before implementation.
- Confirm the relevant automated tests pass.
- Confirm `npm run check` passes for code changes.
- Confirm critical path changes meet or justify the 70% coverage expectation.
- Include the verification commands and coverage notes in the PR description.
