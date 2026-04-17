# TUI Blocking Onboarding Design

**Date:** 2026-04-16
**Status:** Approved

## Goal

Add a blocking first-run onboarding flow to the TUI that collects at least one repository slug before the normal three-pane interface becomes available.

## Product Decision

- The TUI onboarding is blocking.
- It only collects `owner/repo` repository slugs.
- The gate clears as soon as the user adds at least one repository.
- GitHub auth and AI review workflow setup are not part of this TUI onboarding pass.

## Recommended Approach

Add a TUI-only onboarding screen inside the existing Ink app instead of extending the TUI to consume the full web onboarding checklist.

This keeps the change narrow:

- no new runtime APIs
- no pre-Ink CLI wizard
- no duplication of web onboarding logic

The TUI already has the runtime method it needs: `addRepo(...)`.

## UX

When the runtime has no watched repositories and no tracked PRs, the TUI renders a dedicated onboarding screen instead of the normal panes.

The screen should:

- explain that `oh-my-pr` needs a repository to start watching
- accept a single `owner/repo` input
- submit with `Enter`
- clear the current draft with `Esc`
- quit with `q`
- show validation or runtime errors inline

After a successful add, the normal TUI should appear automatically once the refreshed runtime snapshot reflects the new repository.

## Gating Rule

Use a narrow first-run gate:

- show onboarding when `config.watchedRepos.length === 0` and `prs.length === 0`
- skip onboarding otherwise

This avoids trapping legacy or partially populated state behind a first-run screen.

## Architecture

- Add `server/tui/components/OnboardingScreen.tsx`
- Gate rendering in `server/tui/App.tsx`
- Reuse existing `runtime.addRepo(...)` validation and persistence behavior
- Extend the test runtime so repo additions update both visible repos and `config.watchedRepos`

## Error Handling

- Empty input: ignore submit and keep focus in the input
- Invalid slug: show the existing runtime error inline
- Runtime failure: keep the onboarding screen visible and preserve the entered context enough for retry

## Testing

Add focused TUI tests for:

- blocking onboarding on first run
- invalid slug rejection
- successful transition into the main TUI after adding a repo
- bypassing onboarding when tracked PRs already exist
