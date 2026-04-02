import test from "node:test";
import assert from "node:assert/strict";
import { getOnboardingPanelState } from "../client/src/components/OnboardingPanel";

test("getOnboardingPanelState keeps the panel visible for inaccessible repos after GitHub connects", () => {
  const state = getOnboardingPanelState({
    githubConnected: true,
    repos: [
      { repo: "octo/accessible", accessible: true },
      { repo: "octo/inaccessible", accessible: false, error: "Resource not accessible by integration" },
    ],
  });

  assert.equal(state.hasIssues, true);
  assert.equal(state.summary, "1 inaccessible repo");
  assert.deepEqual(state.inaccessibleRepos, [
    { repo: "octo/inaccessible", accessible: false, error: "Resource not accessible by integration" },
  ]);
});

test("getOnboardingPanelState hides the panel when GitHub is connected and watched repos are accessible", () => {
  const state = getOnboardingPanelState({
    githubConnected: true,
    repos: [{ repo: "octo/accessible", accessible: true }],
  });

  assert.equal(state.hasIssues, false);
  assert.equal(state.summary, "0 inaccessible repos");
  assert.deepEqual(state.inaccessibleRepos, []);
});
