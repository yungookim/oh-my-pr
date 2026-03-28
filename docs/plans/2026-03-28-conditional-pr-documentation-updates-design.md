# Conditional PR Documentation Updates Design

**Date:** 2026-03-28
**Status:** Approved

## Goal

Teach Code Factory to decide, for arbitrary tracked repositories, whether a pull request changes user-facing behavior, public API, configuration, setup, or operator workflow enough to require documentation updates, and if so update the appropriate repository docs as part of the autonomous PR babysitter flow.

## Requirements

- Keep the feature repository-agnostic. Do not hardcode this repo's own docs layout or CI pipeline into product behavior.
- Run documentation assessment for newly tracked PRs and again whenever the tracked PR's head SHA changes.
- Add a global `autoUpdateDocs` setting, default `true`.
- Let the agent decide both whether docs are needed and which documents should be edited.
- Treat a docs-needed decision as real autonomous work, even if the PR has no review comments or failing CI statuses.
- Persist per-PR documentation assessment state so successful same-SHA decisions are reused and failed same-SHA assessments are retried.
- Keep documentation assessment out of GitHub feedback items and out of GitHub audit comments.
- Do not let documentation assessment failure abort the rest of the babysitter run.
- Continue to run all assessment and remediation inside the app-owned `~/.codefactory` repo cache and worktree model.

## Architecture

Add a new global config flag, `autoUpdateDocs`, and a small optional `docsAssessment` record on each tracked PR. That PR-level record should store the last attempted head SHA, an outcome (`needed`, `not_needed`, or `failed`), a short summary, and an assessment timestamp.

Code Factory should compare the current GitHub head SHA to the stored docs assessment state after it fetches the latest PR summary. If docs automation is enabled and the current SHA has never been assessed, has changed since the last successful assessment, or the last assessment for this SHA failed, the babysitter should run a dedicated documentation assessment step.

That assessment must happen inside the prepared PR worktree, not from the Code Factory repo itself. The agent needs actual repository context to judge whether docs should change, so the babysitter should prepare the isolated worktree, fetch the base branch, and build prompt context from the branch diff before asking the agent for a yes/no decision.

If the agent says docs are needed, the babysitter should keep using the existing autonomous fix run rather than inventing a second remediation pipeline. The fix prompt should include a docs task that tells the agent to update the appropriate repository documentation according to that repo's own conventions. Code Factory should not maintain a hardcoded document allowlist.

## Data Model

### Config

Add `autoUpdateDocs: boolean` to the shared config schema and default config. Persist it through both memory and SQLite storage, expose it through the existing config API, and include it in the MCP `update_config` schema.

### PR State

Add an optional `docsAssessment` object to the shared PR schema with:

- `headSha`
- `status`
- `summary`
- `assessedAt`

Store this on the PR itself rather than in feedback items. This is internal automation state, not reviewer-authored feedback.

### SQLite Persistence

Persist the docs assessment as JSON in the `prs` table via a new `docs_assessment_json` column. That keeps the change small while still making the assessment durable across restarts. Fresh databases and migrated databases must share the same schema shape.

## Assessment Flow

1. Fetch the latest PR summary and failing statuses.
2. Evaluate pending GitHub feedback and failing statuses as today.
3. Decide whether docs assessment is due for the current head SHA.
4. If there is no comment work, no status work, no follow-up work, no conflict work, and no docs assessment due or docs-needed state for the current SHA, end the run as a no-op.
5. If docs assessment is due, or other work already requires a worktree, prepare the isolated PR worktree.
6. Fetch `origin/<baseRef>` into the worktree and gather diff context such as:
   - `git diff --name-only origin/<baseRef>...HEAD`
   - `git diff --stat origin/<baseRef>...HEAD`
7. Ask the configured agent whether the PR requires documentation changes. Reuse the existing evaluation JSON shape (`needsFix` + `reason`) instead of adding a second parsing contract.
8. Persist the assessment result on the PR and write explicit logs for required / not required / failed decisions.
9. If the result is `needed`, include documentation work in the main fix prompt and treat that as actionable work even with zero comment/status tasks.

## Prompt Contract

The documentation assessment prompt should:

- identify the repo, PR number, title, base branch, and head branch;
- include changed-file and diff-stat context from the prepared worktree;
- ask for JSON only;
- use `needsFix=true` only when repository docs should be updated in the PR branch;
- require `reason` to explain what kind of docs are likely stale, such as README, setup docs, API docs, config docs, or operator docs.

The remediation prompt should add a documentation task only when the current PR state says docs are needed. That prompt should tell the agent to follow repo conventions, update canonical docs sources when obvious, and avoid unrelated rewrites.

## Re-run Semantics

- Same SHA + `needed`: reuse the stored docs-required decision and retry remediation without reassessing.
- Same SHA + `not_needed`: skip reassessment.
- Same SHA + `failed`: retry assessment on the next babysitter run.
- New SHA: reassess docs need, regardless of the prior decision.

If the babysitter pushes a documentation update successfully, the next watcher cycle will see a new head SHA and reassess that new branch state normally.

## Operator Visibility

- Add `autoUpdateDocs` controls to the dashboard/settings config surfaces.
- Keep the docs assessment record in the PR API response for future UI use.
- Add explicit log entries for:
  - docs assessment skipped because SHA already assessed,
  - docs assessment started,
  - docs update required,
  - docs update not required,
  - docs assessment failed,
  - docs task injected into the autonomous fix prompt.

Do not post separate GitHub comments for docs assessment decisions.

## Error Handling

If docs assessment fails, store `failed` for that SHA, log the failure, and continue the babysitter run. Feedback-driven or status-driven remediation should still proceed.

If docs are required and the later autonomous fix run fails, keep the `needed` decision attached to that SHA so the next babysitter run can retry remediation without re-running the assessment first.

## Testing Strategy

Add targeted coverage for:

- shared schema / default config updates;
- SQLite and memory-storage round-trips for `autoUpdateDocs` and `docsAssessment`;
- watcher/manual babysitter behavior when docs automation is disabled;
- first-run docs assessment on a new SHA;
- same-SHA reuse for `needed` and `not_needed`;
- same-SHA retry for `failed`;
- prompt injection when docs are required;
- autonomous agent execution triggered by docs-needed work alone;
- graceful continuation when docs assessment fails.

## Risks And Constraints

- Diff-only context may be imperfect for repositories with unusual docs generation flows. The prompt should bias toward canonical source docs when that distinction is obvious, but the agent remains responsible for following the repo's actual conventions.
- A successful docs-only run will create a new head SHA, so the next watcher cycle will reassess the branch. Same-SHA caching prevents immediate loops on unchanged commits.
- Reusing the existing evaluation contract keeps the system simpler and avoids introducing a second structured parser path in `server/agentRunner.ts`.
