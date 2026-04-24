import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import App from "./tui/App";
import { createTestRuntime } from "./tui/testRuntime";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("tui ask-agent flow queues a question from the context pane", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    ui.stdin.write("a");
    await flush();
    ui.stdin.write("\r");
    await flush();
    ui.stdin.write("Status?");
    await flush();
    ui.stdin.write("\r");
    await flush();

    assert.match(ui.lastFrame() ?? "", /Q Status\?/);
  } finally {
    ui.unmount();
  }
});

test("tui repo management can add a watched repository and a PR URL", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    ui.stdin.write("o");
    await flush();

    ui.stdin.write("\u001B[B");
    await flush();
    ui.stdin.write("\r");
    await flush();
    ui.stdin.write("acme/another");
    await flush();
    ui.stdin.write("\r");
    await flush();
    assert.match(ui.lastFrame() ?? "", /acme\/another/);

    ui.stdin.write("\u001B[B");
    await flush();
    ui.stdin.write("\r");
    await flush();
    ui.stdin.write("https://github.com/acme/widgets/pull/9");
    await flush();
    ui.stdin.write("\r");
    await flush();
    const prs = await runtime.listPRs();
    assert.equal(prs.length, 3);
    assert.match(prs[2]?.title ?? "", /tracked https:\/\/github.com\/acme\/widgets\/pull\/9/);
  } finally {
    ui.unmount();
  }
});

test("tui repo management mirrors web repo watch scope and auto-release controls", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={180} screenHeight={28} refreshMs={0} />);

  try {
    await flush();
    ui.stdin.write("o");
    await flush();

    assert.match(ui.lastFrame() ?? "", /Track[\s\S]*automatically/);
    assert.match(ui.lastFrame() ?? "", /acme\/widgets/);
    assert.match(ui.lastFrame() ?? "", /My PRs[\s\S]*only/);
    assert.match(ui.lastFrame() ?? "", /Auto-release[\s\S]*on/);

    ui.stdin.write("\u001B[B");
    ui.stdin.write("\u001B[B");
    ui.stdin.write("\u001B[B");
    await flush();
    ui.stdin.write("\r");
    await flush();
    assert.equal((await runtime.listRepoSettings())[0]?.ownPrsOnly, false);
    assert.match(ui.lastFrame() ?? "", /My PRs[\s\S]*\+ teammates/);

    ui.stdin.write("\u001B[B");
    await flush();
    ui.stdin.write("\r");
    await flush();
    assert.equal((await runtime.listRepoSettings())[0]?.autoCreateReleases, false);
    assert.match(ui.lastFrame() ?? "", /Auto-release[\s\S]*off/);
  } finally {
    ui.unmount();
  }
});

test("tui settings and watch controls mutate the runtime", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    ui.stdin.write("w");
    await flush();
    assert.match(ui.lastFrame() ?? "", /paused/);

    ui.stdin.write("s");
    await flush();
    ui.stdin.write("\r");
    await flush();
    assert.match(ui.lastFrame() ?? "", /codex/);

    for (let i = 0; i < 5; i += 1) {
      ui.stdin.write("\u001B[B");
    }
    await flush();
    ui.stdin.write("\r");
    await flush();
    assert.match(ui.lastFrame() ?? "", /Repo links/);
    assert.match(ui.lastFrame() ?? "", /Repo links[\s\S]*off/);
  } finally {
    ui.unmount();
  }
});

test("tui settings mirrors web GitHub token and automation controls", async () => {
  const baseConfig = await createTestRuntime().getConfig();
  const runtime = createTestRuntime({
    config: {
      ...baseConfig,
      githubTokens: ["***1111", "***2222"],
      autoHealCI: false,
      autoCreateReleases: true,
    },
  });
  const ui = render(<App runtime={runtime} screenWidth={180} screenHeight={30} refreshMs={0} />);

  try {
    await flush();
    ui.stdin.write("s");
    await flush();

    assert.match(ui.lastFrame() ?? "", /CI healing/);
    assert.match(ui.lastFrame() ?? "", /Auto release/);
    assert.match(ui.lastFrame() ?? "", /GitHub tokens/);
    assert.match(ui.lastFrame() ?? "", /Token 1[\s\S]*\*\*\*1111[\s\S]*p1/);
    assert.match(ui.lastFrame() ?? "", /Token 2[\s\S]*\*\*\*2222[\s\S]*p2/);

    for (let i = 0; i < 6; i += 1) {
      ui.stdin.write("\u001B[B");
    }
    await flush();
    ui.stdin.write("\r");
    await flush();
    ui.stdin.write("ghp_newtoken");
    await flush();
    ui.stdin.write("\r");
    await flush();

    assert.deepEqual((await runtime.getConfig()).githubTokens, ["***1111", "***2222", "ghp_newtoken"]);
  } finally {
    ui.unmount();
  }
});
