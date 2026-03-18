# Changelog

## 2026-03-18

### New Features

- **PR Q&A feature** — Ask agents questions about PR status and activity (#23)
- **Agent status indicator** — Show 🤖 icon on PR rows and detail view when an agent is active (#26)
- **"Ready to merge" indicator** — Display merge-readiness for PRs with all comments resolved (#27)
- **Agent command logging** — Log agent commands with prompts in activity log and as GitHub PR comments (#17)
- **PR agent summaries** — Extract agent summaries from stdout and include them in PR follow-up comments (#24)
- **Codex code review GitHub Action** — Automated code review via Codex on pull requests (#18)
- **Auto-open browser** — Automatically open browser when running the app locally in development (#19)
- **Warning status & retry option** — Add warning status for non-critical failures with a retry option (#31)
- **Safe update drain mode** — Add drain mode and crash-resume for running agents (#29)
- **Conflict resolution feature** — Added to the README diagram and project description (#34)

### Bug Fixes

- Fix GraphQL variables not being wrapped in `variables` object (#30)
- Serialize retry mutations and type GitHub errors (#30)
- Fix dynamic code fence for embedded backticks and prevent self-comment re-ingestion (#17)
- Use `open` package for local browser launch (#19)
- Use default query function for PR questions (#23)
- Restore essential startup logging (#22)
- Reuse active feedback status helper for agent count (#26)
- Address ready-to-merge review feedback (#27)
- Fix Codex code review: pass API key as action input instead of env var (#20)
- Left-align README diagram box text (#34)

### UI Changes

- **Ask Agent as default tab** — Make Ask Agent the default active tab and move it to the left (#35)
- **Hide merge indicator during agent activity** — Hide "Ready to merge" when an agent is active (#33)
- **Clickable PR links** — Make repo#number in PR detail header a clickable link opening in a new tab (#25)

### Improvements

- Reduce backend console verbosity to error level (#22)
- Remove noisy per-line stdout/stderr activity outputs from agent runs (#28)
- Simplify QA question mutation function
- Narrow GraphQL variable cast types in tests

### Documentation

- Improve repository SEO and visitor appeal (#21)
- Document PR question-and-answer feature
- Clarify contributor guidance links
- Update README with new image and content

### Chores

- Update package-lock.json
- Remove node-gyp-build from package-lock.json
