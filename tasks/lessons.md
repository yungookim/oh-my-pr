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
