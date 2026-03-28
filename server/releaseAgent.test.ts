import assert from "node:assert/strict";
import test from "node:test";
import { buildReleaseDecisionPrompt, parseReleaseDecisionOutput } from "./releaseAgent";

test("parseReleaseDecisionOutput normalizes a release-worthy decision", () => {
  const parsed = parseReleaseDecisionOutput(`
    {
      "shouldRelease": true,
      "reason": "User-visible release automation was added.",
      "bump": "minor",
      "title": "Automated release management",
      "notes": "## Highlights\\n- Adds release automation."
    }
  `);

  assert.deepEqual(parsed, {
    shouldRelease: true,
    reason: "User-visible release automation was added.",
    bump: "minor",
    title: "Automated release management",
    notes: "## Highlights\n- Adds release automation.",
  });
});

test("parseReleaseDecisionOutput allows surrounding text and normalizes skipped decisions", () => {
  const parsed = parseReleaseDecisionOutput(`
    Here is the result:
    {
      "shouldRelease": false,
      "reason": "Internal maintenance only.",
      "bump": "patch",
      "title": "ignored",
      "notes": "ignored"
    }
  `);

  assert.deepEqual(parsed, {
    shouldRelease: false,
    reason: "Internal maintenance only.",
    bump: null,
    title: null,
    notes: null,
  });
});

test("parseReleaseDecisionOutput rejects release decisions with invalid bumps", () => {
  assert.throws(
    () =>
      parseReleaseDecisionOutput(`
        {
          "shouldRelease": true,
          "reason": "Important change",
          "bump": "feature",
          "title": "Bad bump",
          "notes": "notes"
        }
      `),
    /invalid 'bump'/i,
  );
});

test("buildReleaseDecisionPrompt includes trigger and included PR context", () => {
  const prompt = buildReleaseDecisionPrompt({
    repo: "yungookim/oh-my-pr",
    baseBranch: "main",
    latestTag: "v1.2.3",
    triggerPr: {
      number: 71,
      title: "Add release automation",
      url: "https://github.com/yungookim/oh-my-pr/pull/71",
      author: "octocat",
      repo: "yungookim/oh-my-pr",
      mergedAt: "2026-03-28T15:00:00.000Z",
      mergeSha: "abc123",
    },
    includedPulls: [
      {
        number: 70,
        title: "Improve changelog generation",
        url: "https://github.com/yungookim/oh-my-pr/pull/70",
        author: "octocat",
        repo: "yungookim/oh-my-pr",
        mergedAt: "2026-03-28T14:00:00.000Z",
        mergeSha: "def456",
      },
    ],
  });

  assert.match(prompt, /Latest release tag: v1\.2\.3/);
  assert.match(prompt, /Trigger PR: #71 "Add release automation"/);
  assert.match(prompt, /1\. PR #70 by @octocat/);
});
