import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import App from "./tui/App";
import { createTestRuntime } from "./tui/testRuntime";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("tui renders the PR list, supports arrow selection, tab focus, and context switching", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={160} refreshMs={0} />);

  try {
    await flush();
    assert.match(ui.lastFrame() ?? "", /› #1 · feat: first pr/);

    ui.stdin.write("\u001B[B");
    await flush();
    assert.match(ui.lastFrame() ?? "", /› #2 · fix: second pr/);

    ui.stdin.write("\t");
    await flush();
    assert.match(ui.lastFrame() ?? "", /pane=feedback/);

    ui.stdin.write("l");
    await flush();
    assert.match(ui.lastFrame() ?? "", /context=logs/);
    assert.match(ui.lastFrame() ?? "", /No log entries/);
  } finally {
    ui.unmount();
  }
});

test("tui shows a compact warning when the terminal is too narrow", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={90} refreshMs={0} />);

  try {
    await flush();
    assert.match(ui.lastFrame() ?? "", /Window too narrow/);
  } finally {
    ui.unmount();
  }
});
