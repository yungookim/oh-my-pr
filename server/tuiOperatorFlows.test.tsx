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
  const ui = render(<App runtime={runtime} screenWidth={160} refreshMs={0} />);

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

    assert.match(ui.lastFrame() ?? "", /Q: Status\?/);
  } finally {
    ui.unmount();
  }
});

test("tui repo management can add a watched repository and a PR URL", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={160} refreshMs={0} />);

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

test("tui settings and watch controls mutate the runtime", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={160} refreshMs={0} />);

  try {
    await flush();
    ui.stdin.write("w");
    await flush();
    assert.match(ui.lastFrame() ?? "", /watch=paused/);

    ui.stdin.write("s");
    await flush();
    ui.stdin.write("\r");
    await flush();
    assert.match(ui.lastFrame() ?? "", /Coding agent: codex/);
  } finally {
    ui.unmount();
  }
});
