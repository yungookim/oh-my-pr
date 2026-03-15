import test from "node:test";
import assert from "node:assert/strict";
import { getRepoHref } from "./repoHref.ts";

test("getRepoHref encodes valid owner/name repositories", () => {
  assert.equal(getRepoHref("octo-org/repo name"), "https://github.com/octo-org/repo%20name");
});

test("getRepoHref falls back to the original string when the repo has extra segments", () => {
  assert.equal(getRepoHref("owner/repo/subpath"), "https://github.com/owner/repo/subpath");
});

test("getRepoHref falls back to the original string when owner or repo is missing", () => {
  assert.equal(getRepoHref("owner"), "https://github.com/owner");
  assert.equal(getRepoHref("owner/"), "https://github.com/owner/");
  assert.equal(getRepoHref("/repo"), "https://github.com//repo");
});
