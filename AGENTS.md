# Repository Guidelines

## Project Structure & Module Organization
`client/src/` hosts the React dashboard, including pages, hooks, and UI primitives. `server/` contains the Express entrypoint, GitHub integration, PR babysitter/worktree logic, storage adapters, and the current `*.test.ts` files. `shared/schema.ts` defines Zod contracts shared across the app. `script/build.ts` builds the production bundle into `dist/`; treat `dist/` as generated output. Planning and QA artifacts live in `docs/plans/`, `dogfood-output/`, and `tasks/`.

## Build, Test, and Development Commands
Use `npm install` to install dependencies. `npm run dev` starts the local service in development mode on `PORT` or `5001`. `npm run build` bundles the client and server into `dist/`, and `npm run start` runs `dist/index.cjs` in production mode. `npm run check` runs the strict TypeScript typecheck. Run the current test suite with `node --test --import tsx server/*.test.ts`. Use `npm run db:push` only when changing schema-backed database behavior; it requires `DATABASE_URL`.

## Coding Style & Naming Conventions
Use strict TypeScript, 2-space indentation, double quotes, and semicolons to match the existing code. Keep React code under `client/src/`, server modules under `server/`, and shared contracts in `shared/`. Prefer the existing path aliases: `@/` for client imports and `@shared/` for shared modules. Follow established file naming: camelCase for server helpers such as `repoWorkspace.ts`, kebab-case for route files such as `not-found.tsx`, and `*.test.ts` for tests.

## Testing Guidelines
Tests use the Node test runner with `tsx` and are currently colocated in `server/`. Add focused regression coverage for changes to storage, GitHub sync, repo workspace isolation, or babysitter flows. For filesystem behavior, prefer temp directories over repo-local fixtures so tests remain isolated and repeatable.

## Agent Defaults
When agents are used, default to `codingAgent: "claude"` and `model: "opus"`. There is no separate "thinking"/reasoning-effort configuration flag in this app today; agent reasoning behavior follows the selected model/runtime defaults. These defaults are set in `server/defaultConfig.ts` and can be changed at runtime via the dashboard model selector or the `/api/config` endpoint.

## Commit & Pull Request Guidelines
Recent commits favor short imperative summaries, usually with prefixes like `feat:`, `fix:`, and `docs:`. Keep PRs narrow, explain the behavior change, and list the commands you ran to verify it. Include screenshots for dashboard UI changes. Always start work in a git worktree created from a freshly updated `main`, then push to a branch instead of `main` unless the user explicitly asks for a direct push. Always open a PR when completed work is ready unless the user explicitly instructs otherwise. This repo/account enforces GitHub email privacy on pushes, so use the GitHub noreply email for commits you intend to push unless the user explicitly wants a different public identity.

## Post-Merge Maintenance
After every 5 PR merges, audit `AGENTS.md` for brevity: remove duplicate instructions, consolidate overlapping sections, and trim stale guidance. Submit the cleanup as its own PR so reviewers can approve the changes.

## Pre-Commit Quality Check
When creating a fresh PR with the `claude` agent available locally, run `/simplify` on all changed files before committing. This catches unnecessary complexity, code duplication, and quality issues early.
