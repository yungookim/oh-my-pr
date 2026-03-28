# Lessons Learned

## 2026-03-15 - Keep PR automation in app-owned `~/.codefactory`
- Pattern: I described PR workspace isolation too loosely and pointed it at a repo-local `.codefactory` directory instead of the app-owned `~/.codefactory` workspace, and I omitted the required checkout-plus-worktree flow.
- Rule: When implementing PR automation, default to a clean repository checkout in `~/.codefactory`, fetch and check out the PR there, and create agent worktrees from that app-owned clone rather than from the user's working copy.
- Prevention checklist:
  - Separate the user's repo checkout from the app-owned automation workspace before proposing filesystem behavior.
  - Verify the default root path with the user when a new workspace directory is introduced.
  - Write down the exact git lifecycle before coding: clone or refresh, fetch PR refs, create worktree, run agent, clean up worktree.
  - Keep coding-agent writes inside `~/.codefactory` unless the user explicitly asks to operate in their normal workspace.

## 2026-03-15 - Keep the app thin and delegate remediation to the coding agent
- Pattern: I was still framing the app as owning more of the remediation flow when the intended design is for the app to monitor PRs, prepare isolated git state, invoke the coding agent, and let the agent handle fixes and comment resolution.
- Rule: For PR babysitter behavior, keep orchestration in the app and push remediation decisions and GitHub comment-resolution work down into the coding-agent prompt and execution flow.
- Prevention checklist:
  - Separate orchestration responsibilities from remediation responsibilities before designing new babysitter behavior.
  - Default the app to monitoring, checkout/worktree preparation, agent launch, and result logging only.
  - When recovery is needed, prefer auto-heal plus agent-guided repair over manual operator workflows.
  - Include comment-resolution expectations explicitly in the agent contract whenever review feedback is part of the task.


## 2026-03-15 - Confirm automation scope before coding
- Pattern: User corrected a narrow bugfix request into a broader end-to-end automation requirement.
- Rule: Before implementing backend behavior changes, restate the target operating mode (manual assist vs fully autonomous babysitter) and align the design to that mode.
- Prevention checklist:
  - Verify whether the user expects manual buttons or unattended background execution.
  - Verify if fixes must be pushed automatically to PR branches.
  - Verify which coding agent is desired and what the default should be.

## 2026-03-15 - Prefer local auth primitives for local tools
- Pattern: I assumed the app should manage its own GitHub token instead of first checking whether a local runtime can reuse existing machine auth like `gh`.
- Rule: For locally run developer tools that integrate with GitHub, evaluate `gh`-based auth before adding or recommending separate token entry flows.
- Prevention checklist:
  - Check whether `gh` is installed and authenticated before designing app-managed GitHub auth.
  - Prefer a local-auth fallback order that matches the runtime context: env vars, configured app token, then `gh` when appropriate.
  - Surface `gh auth` validity issues explicitly instead of hiding them behind generic GitHub API errors.

## 2026-03-15 - Preserve completion semantics when tightening validation
- Pattern: I fixed the GitHub auth/error path but did not re-verify that the PR fetch lifecycle still exits `processing` in every failure mode.
- Rule: When changing an async integration path, explicitly retest all caller-visible state transitions, not just the error message content.
- Prevention checklist:
  - Verify success and failure both clear `processing`/loading states.
  - Test route-level flows, not only helper functions in isolation.
  - Check for swallowed errors or background tasks that can leave stale state behind.

## 2026-03-15 - Clarify persistence scope before designing storage
- Pattern: The persistence request expanded from PR logs to full durable app state.
- Rule: When adding local persistence, confirm whether the user wants only operational logs or all runtime state persisted across restarts.
- Prevention checklist:
  - Enumerate the exact persisted entities before choosing a schema.
  - Reflect that scope in the design doc and implementation plan.
  - Add reload tests that cover each promised state category, not just one table.

## 2026-03-15 - Sync CREATE TABLE DDL with ensureColumn migrations
- Pattern: New columns were added via `ensureColumn` but the `CREATE TABLE` statement was left unchanged, causing the DDL to diverge from the actual table shape.
- Rule: When adding columns to an existing SQLite table via `ensureColumn`, also add those columns to the `CREATE TABLE` block so fresh databases and migrated databases have identical schemas.
- Prevention checklist:
  - After adding an `ensureColumn` call, also update the `CREATE TABLE` statement with the same column definition.
  - Use `ensureColumn` only for migration of existing DBs; the canonical definition lives in `CREATE TABLE`.

## 2026-03-15 - Use Zod's `.catch()` for safe SQLite enum round-trips
- Pattern: Raw SQLite string values were cast with TypeScript `as` to enum types, bypassing validation. A corrupt or future value would silently produce invalid state.
- Rule: When reading enum-typed columns from SQLite, use `schema.catch(defaultValue).parse(row.field)` so unknown values fall back gracefully instead of propagating invalid state.
- Prevention checklist:
  - Never cast SQLite TEXT columns to enum types with `as`; use Zod parse with `.catch()` instead.
  - Provide a safe default (e.g., `"pending"`) that keeps old rows valid without throwing.

## 2026-03-15 - Confirm the exact push target before defaulting to a safety branch
- Pattern: I defaulted to pushing a new branch for a repo import, but the user later clarified they wanted the full workspace on `main`.
- Rule: When a user asks to push a repository, determine the intended destination branch up front; use a safety branch only when the branch target is unspecified.
- Prevention checklist:
  - Extract both the remote and branch target before initializing or pushing a repo.
  - If the user says "everything", include previously excluded workspace files unless they are ignored or clearly machine-local.
  - When an explicit user branch target conflicts with my default safety preference, follow the explicit target.

## 2026-03-15 - Confirm which docs already shipped before opening a follow-up PR
- Pattern: I was about to open a second PR from a mixed commit that bundled code changes with planning docs that had already shipped in another PR.
- Rule: Before creating a follow-up PR from a mixed commit, verify which files already belong to existing PRs and split the new branch so it contains only the remaining intended changes.
- Prevention checklist:
  - Inspect the full mixed commit, not just the code paths I care about.
  - Ask whether any docs or supporting files already shipped in another PR before reusing a previous commit.
  - Build follow-up PR branches from `main` and cherry-pick or restage only the intended files.
  - Re-read the final staged file list before pushing a new PR branch.

## 2026-03-15 - Capture the fresh-main worktree rule in repo guidance
- Pattern: I wrote the repository guide without stating the required workflow of starting work from a git worktree based on a freshly updated `main`.
- Rule: When documenting or following this repository's workflow, explicitly require a fresh `main` update and a new worktree before making changes.
- Prevention checklist:
  - Check for repo-specific branch and worktree rules before drafting contributor docs.
  - If the repo uses isolated branches, state the exact starting point: update `main`, create worktree, then branch.
  - Re-read workflow sections to confirm they include branch base, isolation model, and push target.

## 2026-03-15 - Ship lesson updates with the same rigor as code changes
- Pattern: I opened the implementation PR but left the required `tasks/lessons.md` update unshipped until the user asked for a separate PR.
- Rule: When a user correction adds a lesson, treat that lesson update as a deliverable and explicitly decide whether it belongs in the active PR or a separate PR before closing the task.
- Prevention checklist:
  - After each user correction, verify whether `tasks/lessons.md` changed and whether that change still needs to ship.
  - Before opening a PR, inspect staged and unstaged diffs for pending lesson updates.
  - If lessons should be isolated from product changes, create a docs-only branch from fresh `main` and open that PR in the same session.
  - Call out any intentionally unshipped lesson updates in the final handoff.
## 2026-03-15 - Confirm workspace isolation requirements before editing repo automation
- Pattern: I started investigating a CI change in the user's current checkout before the user clarified they wanted the work done from a clean worktree off `main`.
- Rule: For CI/CD, repository automation, or branch-sensitive changes, confirm the required git starting point and isolation model before editing files.
- Prevention checklist:
  - Ask whether the user wants changes in the current checkout, a fresh branch from `main`, or an isolated worktree when the request affects shared automation.
  - Create the requested branch/worktree before installing dependencies or editing tracked files.
  - Restate the chosen branch/worktree path in the first execution update so the working context is explicit.

## 2026-03-15 - Re-verify lockfile completeness with `npm ci`
- Pattern: I updated dependencies and committed a lockfile that still omitted the optional `bufferutil` package, so GitHub Actions failed at `npm ci` even though the branch looked healthy locally.
- Rule: After any dependency or lockfile change, prove the committed state with a clean `npm ci`, not just `npm install`, `npm run`, or a warm existing `node_modules`.
- Prevention checklist:
  - Check that every declared dependency bucket, including `optionalDependencies`, appears in `package-lock.json`.
  - Run `npm ci` in the branch before opening or updating a PR when dependency metadata changes.
  - If CI reports a manifest-lock mismatch, inspect the exact missing package from the log instead of assuming the root dependency lists are sufficient.

## 2026-03-15 - Treat PR creation as a default completion step
- Pattern: I documented branch-push safety rules but did not explicitly require opening a PR for finished work.
- Rule: When work is complete in this repository, open a PR unless the user explicitly says not to.
- Prevention checklist:
  - Re-read the repo workflow instructions before closing a task and confirm whether PR creation is mandatory.
  - Treat "push to a branch" and "open a PR" as separate requirements, and satisfy both.
  - If the current worktree contains unrelated changes, isolate the task in a fresh worktree before creating the PR.
  - Call out any explicit user instruction to skip PR creation in the final handoff.

## 2026-03-18 - Never implement directly on local `main`
- Pattern: I started implementation work while checked out on local `main`.
- Rule: Before any non-trivial edit, verify branch context and move to a dedicated worktree branch if currently on `main`.
- Prevention checklist:
  - Run `git rev-parse --abbrev-ref HEAD` at task start.
  - If on `main`, create a fresh worktree and `codex/*` branch before editing.
  - Keep docs/planning and implementation changes in that isolated worktree.
  - Do not proceed with code changes until branch/worktree isolation is confirmed.

## 2026-03-23 - Confirm visual tone early for creative assets
- Pattern: I delivered an initial robot icon that read as too mechanical, and the user requested a friendlier direction.
- Rule: For style-sensitive assets, lock tone up front (for example: friendly, playful, minimal, industrial) and reflect it in the first draft.
- Prevention checklist:
  - Capture 2-3 tone adjectives before drawing or coding the asset.
  - Default to round shapes and softer contrast when the request implies "friendly."
  - Present the first version with a short stated style intent so mismatches are easy to spot quickly.

## 2026-03-23 - Start icon drafts with minimal geometry
- Pattern: My friendlier revision still had too much visual detail, and the user asked for a simpler icon.
- Rule: For requested app icons, start with a minimal silhouette-first draft and only add detail if explicitly requested.
- Prevention checklist:
  - Keep first pass to <= 6 visible primitives when "simple" is requested.
  - Use at most 2-3 colors in the base draft.
  - Remove decorative elements (cheeks, highlights, side caps) unless the user asks for them.

## 2026-03-23 - Tune visual detail in small increments
- Pattern: After simplifying the icon, the next correction requested a modest increase in polish rather than another full style shift.
- Rule: For iterative visual feedback, adjust one notch at a time (minimal -> slightly polished -> stylized) and preserve the accepted base silhouette.
- Prevention checklist:
  - Keep the core geometry stable between revisions unless the user asks to rework the shape.
  - Add at most 2-3 new decorative elements per revision.
  - Describe the exact detail delta before editing so the scope stays controlled.

## 2026-03-23 - Obey explicit style constraints literally
- Pattern: The user explicitly requested a silhouette-only black-and-white line icon after prior stylized passes.
- Rule: When a user provides strict visual constraints (for example: silhouette-only, monochrome, simple lines), implement those constraints exactly with no extra styling.
- Prevention checklist:
  - Convert explicit constraints into a short checklist before editing and verify each item in the output.
  - Remove fills, gradients, and decorative details when the request says line-only.
  - Keep the palette literal (black strokes on transparent/white) unless the user asks otherwise.

## 2026-03-23 - When user provides a source asset, stop redesigning and propagate it
- Pattern: The user provided an explicit icon image and wanted it used everywhere with resizing, replacing prior iterative redesign direction.
- Rule: If a source asset is supplied, treat it as canonical and regenerate all target formats from it instead of continuing custom design edits.
- Prevention checklist:
  - Detect and use newly provided files/images as the authoritative source of truth.
  - Enumerate every icon target in the repo and regenerate each from the same source.
  - Verify dimensions and formats after generation to confirm consistent propagation.

## 2026-03-23 - Overwrite asset paths on explicit replacement requests
- Pattern: I added an initial hero image, then the user corrected it with a direct replacement request.
- Rule: When a user says to replace an uploaded asset, overwrite the existing target file path unless they explicitly ask for versioned copies.
- Prevention checklist:
  - Keep the destination filename stable for replacement requests.
  - Verify the replacement by checking file type and dimensions after writing.
  - State clearly in handoff that the asset was replaced, not added as a second variant.

## 2026-03-24 - Include lock recovery with SQLite contention fixes
- Pattern: I scoped the SQLite fix to WAL and timeout hardening, and the user corrected it to also require an explicit recovery path when the database still reports `database is locked`.
- Rule: When fixing storage contention, include both prevention (`WAL`, timeouts, transactions) and a bounded recovery mechanism for residual lock failures.
- Prevention checklist:
  - Ask whether the user expects retry/recovery behavior in addition to concurrency hardening whenever the symptom is an intermittent storage lock.
  - Keep recovery in the storage layer so every caller gets the same behavior and error classification.
  - Add a regression test that proves the recovery path works under two live connections contending on the same database file.

## 2026-03-24 - Confirm the exact frontend surface before changing theme tokens
- Pattern: I started auditing the app-wide theme when the user only wanted the documentation page switched to a black-and-white palette.
- Rule: Before changing visual theme tokens, identify the exact surface in scope (app UI, docs shell, generated docs pages, or another isolated frontend) and patch only that surface.
- Prevention checklist:
  - Restate the target surface explicitly in the first execution update for any theme or styling request.
  - Map the entry files that own that surface before touching shared or global styles.
  - Treat documentation pages and the app dashboard as separate styling systems unless the user asks for both.
  - Avoid app-wide token audits when the request names a specific page or docs surface.

## 2026-03-24 - Treat user-provided reference markup as the canonical docs source
- Pattern: I initially optimized around the existing docs landing page instead of locking onto the exact reference markup the user later provided.
- Rule: When a user supplies canonical HTML/CSS for a docs surface, treat that snippet as the source of truth and align every related generated page to it, not just the page that looked closest already.
- Prevention checklist:
  - Ask for or confirm the canonical reference before redesigning an existing docs surface.
  - Compare both the root docs entry page and any generated docs pages against the provided reference before editing.
  - Move shared docs layout into the generator or a shared template so the reference style cannot drift between pages.
  - Rebuild generated docs after the template change and inspect at least one root page and one generated page for matching shell structure.
