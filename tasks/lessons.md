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
