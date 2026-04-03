import assert from "node:assert/strict";
import test from "node:test";
import { buildDeploymentHealingPrompt, extractDeploymentHealingSummary } from "./deploymentHealingAgent";

test("buildDeploymentHealingPrompt includes platform and log", () => {
  const prompt = buildDeploymentHealingPrompt({
    repo: "owner/repo", platform: "vercel", mergeSha: "abc123", triggerPrNumber: 42,
    triggerPrTitle: "Add feature", triggerPrUrl: "https://github.com/owner/repo/pull/42",
    deploymentLog: "Error: Cannot find module 'express'\n    at require (internal/modules/cjs/loader.js:1)",
    baseBranch: "main",
  });
  assert.ok(prompt.includes("vercel"), "should mention platform");
  assert.ok(prompt.includes("owner/repo"), "should mention repo");
  assert.ok(prompt.includes("abc123"), "should mention sha");
  assert.ok(prompt.includes("Cannot find module"), "should include log");
  assert.ok(prompt.includes("deploy-fix/"), "should mention branch naming");
  assert.ok(prompt.includes("DEPLOYMENT_FIX_SUMMARY:"), "should include summary marker");
});

test("extractDeploymentHealingSummary finds marker", () => {
  const summary = extractDeploymentHealingSummary(
    "lots of output\nDEPLOYMENT_FIX_SUMMARY: Added express to dependencies\nmore output",
  );
  assert.equal(summary, "Added express to dependencies");
});

test("extractDeploymentHealingSummary falls back to last line", () => {
  const summary = extractDeploymentHealingSummary("first\nsecond\nthird line");
  assert.equal(summary, "third line");
});

test("extractDeploymentHealingSummary handles empty output", () => {
  const summary = extractDeploymentHealingSummary("");
  assert.equal(summary, "No agent summary provided");
});
