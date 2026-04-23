# Multiple GitHub Tokens Design

## Goal

Allow users to save multiple GitHub tokens and control the order in which the app tries them.

## Current State

The app stores one `githubToken` string in config. GitHub auth currently resolves in this order:

1. `GITHUB_TOKEN` from the app process environment.
2. The saved `config.githubToken`.
3. Cached `gh auth token`.
4. A fresh `gh auth token` shell command.
5. No auth token.

Settings exposes one password input and `/api/config` masks one token as `***last4`.

## Approved Approach

Use an ordered saved-token list as the primary configured auth source. The new order is:

1. Saved GitHub tokens in the order shown in Settings.
2. `GITHUB_TOKEN` from the app process environment.
3. Cached `gh auth token`.
4. A fresh `gh auth token` shell command.
5. No auth token.

This makes the Settings order meaningful while preserving existing environment and `gh` fallbacks.

## Data Model

Add `githubTokens: string[]` to `Config`. Keep legacy `githubToken` compatibility only where needed for migration and older API clients.

For SQLite, add `github_tokens_json TEXT NOT NULL DEFAULT '[]'` to the `config` table. When reading a row whose ordered token list is empty but legacy `github_token` is not empty, return a one-item `githubTokens` list. When writing config, store the ordered list in `github_tokens_json`; keep `github_token` populated from the first token only for compatibility with existing databases and older code paths during the transition.

## API And Redaction

`GET /api/config` and `PATCH /api/config` must never return raw token values. They should return ordered masked tokens such as `***1234`.

`PATCH /api/config` accepts `githubTokens` for the new behavior. If a request still sends `githubToken`, convert it into a one-item ordered list so existing clients do not break.

## Settings UI

Replace the single-token control with an ordered token list:

- Show each saved token as a masked value.
- Add a token through a password input.
- Remove a token.
- Move tokens up and down to set priority.
- Save the full ordered list through `/api/config`.

The UI should keep controls compact and consistent with the existing settings page.

## Runtime Behavior

Existing callers that need one token for clone URLs or agent environment variables continue to call the central token resolver. The resolver returns the first non-empty token from `config.githubTokens`, then falls back to the environment and `gh`.

This design does not implement per-request retry on `401` or `403`. That deeper behavior can follow later because it touches Octokit request creation, clone/fetch retry behavior, and error reporting across many GitHub paths.

## Testing

Add or update tests for:

- Default config validates with `githubTokens: []`.
- SQLite persists and reloads ordered token lists.
- SQLite migrates legacy `github_token` into a one-item ordered list.
- REST config responses mask ordered tokens and accept ordered token updates.
- Auth resolution prefers saved token order before `GITHUB_TOKEN` and `gh auth token`.
- Existing agent environment and clone URL behavior receives the first configured token.

Run:

```bash
npm run check
node --test --import tsx server/*.test.ts
```
