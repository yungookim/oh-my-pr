# Multiple GitHub Tokens Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add ordered, user-configurable GitHub tokens and resolve GitHub auth from that order before environment and `gh` fallbacks.

**Architecture:** Extend shared config with `githubTokens: string[]` while accepting legacy `githubToken` updates. Store ordered tokens in SQLite JSON, mask ordered tokens at the API boundary, and keep all runtime callers on the central GitHub token resolver so clone URLs and agent environments receive the selected token.

**Tech Stack:** TypeScript, Zod, Express, React, TanStack Query, SQLite through `node:sqlite`, Node test runner with `tsx`.

---

### Task 1: Shared Config Shape And Defaults

**Files:**
- Modify: `shared/schema.ts`
- Modify: `shared/models.ts`
- Modify: `server/defaultConfig.ts`
- Modify: `server/defaultConfig.test.ts`

**Step 1: Write the failing default config tests**

Update `server/defaultConfig.test.ts` so the required config fields include `githubTokens`, and replace the single-token assertion with:

```ts
it("has empty array as default githubTokens", () => {
  assert.ok(Array.isArray(DEFAULT_CONFIG.githubTokens));
  assert.deepEqual(DEFAULT_CONFIG.githubTokens, []);
});
```

Run:

```bash
node --test --import tsx server/defaultConfig.test.ts
```

Expected: FAIL because `githubTokens` is missing.

**Step 2: Add schema/default support**

In `shared/schema.ts`, add:

```ts
githubTokens: z.array(z.string()),
githubToken: z.string().optional(),
```

Keep `githubToken` optional for legacy clients only.

In `server/defaultConfig.ts`, add:

```ts
githubTokens: [],
```

Remove the required default `githubToken` field unless TypeScript requires the optional compatibility field to be present.

**Step 3: Normalize legacy updates**

In `shared/models.ts`, update `applyConfigUpdate` to turn a legacy `githubToken` update into a one-item `githubTokens` update when `githubTokens` is not provided:

```ts
const githubTokens = updates.githubTokens
  ?? (updates.githubToken !== undefined ? [updates.githubToken] : existing.githubTokens);
```

Trim empty values before parsing:

```ts
githubTokens: githubTokens.map((token) => token.trim()).filter(Boolean),
githubToken: undefined,
```

**Step 4: Run the focused test**

Run:

```bash
node --test --import tsx server/defaultConfig.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/schema.ts shared/models.ts server/defaultConfig.ts server/defaultConfig.test.ts
git commit -m "feat: add ordered github token config"
```

### Task 2: Storage Persistence And Migration

**Files:**
- Modify: `server/sqliteStorage.ts`
- Modify: `server/memoryStorage.ts`
- Modify: `server/storage.test.ts`
- Modify: `server/memoryStorage.test.ts`
- Modify: `server/tui/testRuntime.ts`
- Modify any test fixtures that fail due to the new required `githubTokens` field.

**Step 1: Write failing storage tests**

In `server/storage.test.ts`, update existing config persistence coverage to save:

```ts
githubTokens: ["ghs_first", "ghs_second"],
```

Assert reload returns the same order.

Add a migration test that writes a legacy row with `github_token = 'ghs_legacy'` and no ordered JSON tokens, then asserts:

```ts
assert.deepEqual(config.githubTokens, ["ghs_legacy"]);
```

In `server/memoryStorage.test.ts`, update the config update test to use and assert:

```ts
githubTokens: ["tok_123", "tok_456"],
```

Run:

```bash
node --test --import tsx server/storage.test.ts server/memoryStorage.test.ts
```

Expected: FAIL because storage does not persist `githubTokens`.

**Step 2: Add SQLite column and row mapping**

In `server/sqliteStorage.ts`:

- Add `github_tokens_json: string;` to `ConfigRow`.
- Add `github_tokens_json TEXT NOT NULL DEFAULT '[]'` to the `CREATE TABLE config` block.
- Add `this.ensureColumn("config", "github_tokens_json", "TEXT NOT NULL DEFAULT '[]'");`.
- Select `github_tokens_json` in `getConfig`.
- Parse the JSON with a safe helper that falls back to `[]` on malformed values.
- In `parseConfigRow`, derive ordered tokens from `github_tokens_json`, falling back to `[row.github_token]` when the JSON array is empty and the legacy value is non-empty.
- In `writeConfig`, write `JSON.stringify(config.githubTokens)` and keep `github_token` as `config.githubTokens[0] ?? ""`.

**Step 3: Update in-memory copies**

Ensure `MemoryStorage.getConfig` and `updateConfig` return copied token arrays, not shared array references.

**Step 4: Run storage tests**

Run:

```bash
node --test --import tsx server/storage.test.ts server/memoryStorage.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/sqliteStorage.ts server/memoryStorage.ts server/storage.test.ts server/memoryStorage.test.ts server/tui/testRuntime.ts
git commit -m "feat: persist ordered github tokens"
```

### Task 3: Auth Resolver Ordering

**Files:**
- Modify: `server/github.ts`
- Modify: `server/github.test.ts`
- Modify: `server/babysitter.test.ts`
- Modify: `server/backgroundJobHandlers.test.ts`
- Modify any server test fixtures that still define only `githubToken`.

**Step 1: Write failing resolver tests**

In `server/github.test.ts`, add direct tests for `resolveGitHubAuthToken`:

```ts
test("resolveGitHubAuthToken prefers ordered config tokens before env token", async () => {
  const original = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "env-token";
  try {
    const token = await resolveGitHubAuthToken({
      ...config,
      githubTokens: ["first-token", "second-token"],
    });
    assert.equal(token, "first-token");
  } finally {
    process.env.GITHUB_TOKEN = original;
  }
});
```

Add another test for legacy `githubToken` compatibility and another for environment fallback when no configured tokens exist.

Run:

```bash
node --test --import tsx server/github.test.ts
```

Expected: FAIL because the resolver still reads `GITHUB_TOKEN` first and only uses `config.githubToken`.

**Step 2: Implement resolver order**

In `server/github.ts`, change `resolveGitHubAuthToken` to:

1. Return the first non-empty `config.githubTokens` entry.
2. Fall back to legacy `config.githubToken` if present.
3. Fall back to `process.env.GITHUB_TOKEN`.
4. Fall back to cached/fresh `gh auth token`.

**Step 3: Update existing consumer tests**

Update existing test fixtures so `githubTokens: []` is present. Where tests assert agent env or clone URL token behavior, set `githubTokens: ["test-token"]` or keep injected mock resolver behavior unchanged.

**Step 4: Run focused GitHub tests**

Run:

```bash
node --test --import tsx server/github.test.ts server/backgroundJobHandlers.test.ts server/babysitter.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/github.ts server/github.test.ts server/babysitter.test.ts server/backgroundJobHandlers.test.ts
git commit -m "feat: prefer ordered github tokens"
```

### Task 4: API Masking And MCP Schema

**Files:**
- Modify: `server/routes.ts`
- Modify: `server/routes.test.ts`
- Modify: `server/mcp.ts`

**Step 1: Write failing route tests**

Add route tests for `/api/config`:

```ts
const patchResponse = await fetch(`${harness.baseUrl}/api/config`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ githubTokens: ["ghs_alpha1234", "ghs_beta5678"] }),
});
const patched = await patchResponse.json();
assert.deepEqual(patched.githubTokens, ["***1234", "***5678"]);

const stored = await harness.storage.getConfig();
assert.deepEqual(stored.githubTokens, ["ghs_alpha1234", "ghs_beta5678"]);
```

Add a legacy payload test:

```ts
body: JSON.stringify({ githubToken: "ghs_legacy9999" })
```

and assert the stored ordered list is `["ghs_legacy9999"]`.

Run:

```bash
node --test --import tsx server/routes.test.ts
```

Expected: FAIL because masking and route parsing are single-token only.

**Step 2: Update masking**

In `server/routes.ts`, replace the single-token masking helper with an ordered helper:

```ts
function maskToken(token: string): string {
  return token ? `***${token.slice(-4)}` : "";
}
```

Return:

```ts
githubTokens: config.githubTokens.map(maskToken),
githubToken: config.githubTokens[0] ? maskToken(config.githubTokens[0]) : "",
```

**Step 3: Update MCP schema text**

In `server/mcp.ts`, change config descriptions and input schema to include:

```ts
githubTokens: { type: "array", items: { type: "string" } },
```

Keep `githubToken` documented as legacy-compatible only if desired.

**Step 4: Run route tests**

Run:

```bash
node --test --import tsx server/routes.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts server/mcp.ts
git commit -m "feat: mask ordered github tokens"
```

### Task 5: Settings UI

**Files:**
- Modify: `client/src/pages/settings.tsx`
- Modify: `client/src/components/OnboardingPanel.tsx`

**Step 1: Implement compact ordered token controls**

In `client/src/pages/settings.tsx`:

- Replace single `githubToken` input state with `newGithubToken`.
- Read `config?.githubTokens ?? []`.
- Render a row for each masked token.
- Add `move up`, `move down`, and `remove` buttons.
- Add a password input and `add` button that appends the new token to the ordered list.
- PATCH `{ githubTokens: nextTokens }` for every reorder/remove/add action.

Use plain compact buttons matching the existing settings page style.

**Step 2: Avoid leaking masked values as saved tokens**

Only construct PATCH payloads from the current ordered masked list for reordering/removal if the API supports masked tokens as identifiers. Prefer a simple full-list update model using raw values only for adding new tokens is not enough because the client cannot know existing raw tokens. If needed, add dedicated server merge semantics:

- Sending `githubTokens` with masked entries keeps matching existing tokens in that position.
- Sending a new raw token appends or replaces that entry.

Document and test this behavior in Task 4 before relying on it.

**Step 3: Update onboarding copy**

Change singular copy from “token field” to “token list” in `client/src/components/OnboardingPanel.tsx`.

**Step 4: Run typecheck**

Run:

```bash
npm run check
```

Expected: PASS.

**Step 5: Commit**

```bash
git add client/src/pages/settings.tsx client/src/components/OnboardingPanel.tsx server/routes.ts server/routes.test.ts
git commit -m "feat: manage ordered github tokens in settings"
```

### Task 6: Full Verification

**Files:**
- No planned file edits.

**Step 1: Run full static and server test suite**

Run:

```bash
npm run check
node --test --import tsx server/*.test.ts
```

Expected: PASS.

**Step 2: Inspect diff**

Run:

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- shared/schema.ts shared/models.ts server/github.ts server/routes.ts server/sqliteStorage.ts client/src/pages/settings.tsx
```

Expected: Diff is limited to config/auth/storage/API/settings/docs/tests for ordered GitHub tokens.

**Step 3: Final commit if needed**

If verification required small fixes:

```bash
git add <changed-files>
git commit -m "fix: harden ordered github token handling"
```

**Step 4: Prepare PR**

Push the branch and open a PR with:

- Behavior summary.
- Migration note for existing single saved token.
- Verification commands and results.
