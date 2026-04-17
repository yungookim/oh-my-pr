# Lessons Learned

## 2026-04-16 - Make visible automation/comment behavior user-configurable when reasonable
- Pattern: I implemented repository-linked GitHub PR comment branding as always-on behavior, then the user corrected the requirement to allow turning it off in Settings.
- Rule: When adding visible automation output behavior that changes how the product speaks on a user's behalf, decide before closing whether it should be user-configurable.
- Prevention checklist:
  - Classify new outward-facing automation behavior as required, optional, or policy-driven before implementing it.
  - If the behavior affects GitHub comments, commit messages, or other user-visible agent output, check whether a config toggle is appropriate.
  - Thread new config-backed behavior through defaults, persistence, and every settings surface that already edits related config.
  - Add enabled and disabled regression coverage when the behavior changes rendered output.

## 2026-04-16 - Mirror durable repo rules into AGENTS.md, not just lessons
- Pattern: After the email-privacy push failure, I recorded the rule in `tasks/lessons.md`, but the user had to explicitly ask me to add it to `AGENTS.md` too so future sessions would see it in the main repo instructions.
- Rule: When a correction establishes a durable repository workflow rule, update both `tasks/lessons.md` and `AGENTS.md` if the rule belongs in the repo-level operating instructions.
- Prevention checklist:
  - Ask whether the new rule is session-local or repository-wide before closing the correction.
  - If the rule changes how future commits, pushes, reviews, or workflows should work in this repo, add it to `AGENTS.md` in the most relevant section.
  - Keep `tasks/lessons.md` for the failure pattern and `AGENTS.md` for the operational rule so both memory layers stay aligned.

## 2026-04-16 - Assume GitHub email privacy is enforced for this repo
- Pattern: I created the branch commit with `yungookim@gmail.com`, and GitHub rejected the push for `oh-my-pr` with `GH007` because the repository/account privacy settings do not allow publishing that private email.
- Rule: In `oh-my-pr`, prepare commits with the GitHub noreply email by default before pushing branches unless the user explicitly wants a different public identity.
- Prevention checklist:
  - Before the first commit intended for GitHub, check whether the local git email is a private address and switch to the GitHub noreply identity for the commit if needed.
  - Treat `oh-my-pr` as privacy-protected by default; do not assume a normal push will succeed with `yungookim@gmail.com`.
  - If an existing commit already uses the private address, ask before rewriting it, but avoid the rewrite path by setting the correct identity up front on new commits.

## 2026-04-16 - Diagnose Ink alignment bugs with rendered display width, not string length
- Pattern: The user reported broken TUI alignment from a screenshot, and I initially investigated pane sizing before confirming the real drift came from wide-glyph truncation and fragmented `Text` rows wrapping unexpectedly.
- Rule: For Ink/TUI alignment bugs, reproduce the rendered frame and audit truncation, padding, and wrapping with terminal display-width semantics before changing pane dimensions.
- Prevention checklist:
  - Render or inspect the actual terminal frame before assuming the problem is pane sizing.
  - Use display-width-aware helpers for any truncation or padding path that can include wide glyphs or Unicode separators.
  - Keep tab strips, log rows, and footer hints on explicitly truncated single lines instead of relying on default wrapping.
  - Add a regression test that covers long metadata plus wide glyphs in the affected pane.

## 2026-04-16 - Surface requested onboarding guidance explicitly
- Pattern: I cleaned up onboarding around checklist steps and install actions, but the user then had to ask for the multi-provider AI review tip and provider links to be shown explicitly during onboarding.
- Rule: When onboarding touches a setup capability that depends on third-party providers, include the requested explanatory tip and concrete provider links in the onboarding UI instead of assuming buttons or inferred context are sufficient.
- Prevention checklist:
  - Re-read the final onboarding copy against the user's requested guidance before closing the task.
  - If the user names specific providers or docs links, surface those exact links in the relevant onboarding step.
  - Treat missing instructional copy in onboarding as a product gap, not a follow-up nice-to-have.

## 2026-04-02 - Honor explicit checkpoint and hang-reporting requests as runtime requirements
- Pattern: Mid-implementation, the user had to explicitly ask for brief checkpoint updates and for hangs to be reported immediately if tests stall.
- Rule: When the user sets expectations for progress cadence or hang reporting, adopt those expectations immediately and treat them as part of the task contract.
- Prevention checklist:
  - Restate the requested update cadence or hang-handling behavior in the next progress update.
  - Report the exact command and suspected stuck test immediately if a verification run does not advance normally.
  - Use concise checkpoint updates at natural task boundaries without waiting for the user to prompt again.

## 2026-04-02 - Re-anchor design scope to the branch the user selects
- Pattern: I inspected newer background-job code on a feature branch, then the user corrected me to work from current `main`, which meant some of the async surfaces I had reasoned about were not actually present in the implementation target.
- Rule: When the user specifies a branch or says to work from `main`, verify the feature set on that exact branch before finalizing architecture or scope.
- Prevention checklist:
  - Re-check `git rev-parse --abbrev-ref HEAD` and the worktree base immediately after any branch-scope correction.
  - Re-read the actual implementation files on the selected branch instead of assuming earlier exploration still applies.
  - Restate which job types exist on the target branch before proposing queue coverage or migrations.

## 2026-04-01 - Do not rewrite commit identity without explicit user approval
- Pattern: GitHub rejected a branch push because the current commit email was protected, and I rewrote the branch commits to a noreply address before confirming that the user wanted that identity change.
- Rule: When push delivery is blocked by GitHub email privacy, keep the user's current commit email unless they explicitly approve rewriting commit metadata.
- Prevention checklist:
  - State the exact GitHub rejection and the affected email before changing author or committer identity.
  - Ask whether the user wants to keep the current email and accept a blocked push, or authorize a noreply rewrite.
  - Do not rewrite branch history for identity-only reasons unless the user explicitly approves that tradeoff.

## 2026-04-01 - Treat local feedback closure states as GitHub conversation closure triggers
- Pattern: I initially scoped PR conversation cleanup too narrowly and paused on whether manual rejection should resolve GitHub review threads immediately.
- Rule: In oh-my-pr, any feedback item transition to a terminal closed state owned by the app (`rejected` or `resolved`) should immediately attempt to resolve the corresponding GitHub review thread when one exists.
- Prevention checklist:
  - When implementing feedback-state transitions, map each terminal local state to its required remote GitHub side effect before coding.
  - Do not limit conversation cleanup to babysitter-authored follow-ups if the UI can also close items manually.
  - Verify both manual and automated paths converge on the same review-thread resolution behavior.

## 2026-04-01 - Default to removing the named UI surface, not its whole container
- Pattern: I treated a request to remove the `"AI code review not detected"` dialog as possibly meaning the entire onboarding banner, even after locating the text inside a shared panel with unrelated GitHub setup content.
- Rule: When the user names a specific dialog, heading, or message inside a composite UI, default to removing only that named surface and preserving adjacent sections unless they explicitly ask for broader cleanup.
- Prevention checklist:
  - Trace the exact component boundary around the named UI before widening scope.
  - Preserve unrelated content in shared panels by default.
  - Ask a scope question only when the named text maps to multiple equally plausible surfaces.

## 2026-03-28 - Design product features around user repositories, not this repo's own workflow
- Pattern: I framed a new PR-documentation feature as if it were about Code Factory's own repository and CI/docs pipeline, when the user intended a product capability that agents apply to any tracked repository.
- Rule: When designing or implementing Code Factory behavior, default to repository-agnostic product semantics unless the user explicitly scopes the request to this repo's own operations.
- Prevention checklist:
  - Restate whether a request targets Code Factory's product behavior or this repository's internal workflow before proposing a design.
  - Validate that prompt contracts, defaults, and storage shape make sense for arbitrary user repositories, not just `README.md` or docs layout in this repo.
  - Avoid deriving product requirements from this repo's local docs/build pipeline unless the user explicitly wants repo-specific behavior.
  - Check whether the feature needs to generalize across heterogeneous repositories before choosing fixed file paths or heuristics.

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

## 2026-03-28 - Lock generated content structure into prompts and tests
- Pattern: I implemented release-note generation without encoding the exact user-requested structure, and the user corrected it to require a value-driven summary followed by detailed plain-English changelog lines.
- Rule: When a feature depends on AI-generated text, translate any user-specified output structure into explicit prompt instructions and add a regression test that asserts those instructions are present.
- Prevention checklist:
  - Restate required sections, ordering, and tone before finalizing any prompt-backed feature.
  - Treat content shape requirements as part of the contract, not as optional wording polish.
  - Add a focused test on the prompt builder whenever the user specifies exact output sections.
  - Prefer explicit section headings in prompts when the output will be surfaced directly in the product.

## 2026-03-28 - Preserve useful visuals when tightening docs
- Pattern: I made the README more concise by removing visual elements the user still wanted to keep, then had to restore them.
- Rule: When simplifying documentation, keep helpful images and diagrams unless the user explicitly asks to remove them.
- Prevention checklist:
  - Separate content trimming from visual trimming before rewriting a docs page.
  - Inventory existing images and diagrams and decide which are essential before deleting them.
  - If the goal is "more concise," default to shortening copy first and preserving high-signal visuals.
  - Call out any planned visual removals in the execution update when they are not explicitly requested.
