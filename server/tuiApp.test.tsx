import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import App from "./tui/App";
import { createTestRuntime } from "./tui/testRuntime";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("tui renders stable panes, moves PR selection, and switches context tabs", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    assert.match(ui.lastFrame() ?? "", /Pull Requests/);
    assert.match(ui.lastFrame() ?? "", /feat: first pr/);
    assert.match(ui.lastFrame() ?? "", /Selected feedback/);
    assert.match(ui.lastFrame() ?? "", /Please rename this variable for/);

    ui.stdin.write("\u001B[B");
    await flush();
    assert.match(ui.lastFrame() ?? "", /fix: second pr/);

    ui.stdin.write("a");
    await flush();
    assert.match(ui.lastFrame() ?? "", /Press Enter to ask about/);
    assert.match(ui.lastFrame() ?? "", /the selected PR\./);

    ui.stdin.write("l");
    await flush();
    assert.match(ui.lastFrame() ?? "", /No log entries\./);
  } finally {
    ui.unmount();
  }
});

test("tui shows a compact warning when the terminal is too narrow", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={90} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    assert.match(ui.lastFrame() ?? "", /Window too narrow/);
  } finally {
    ui.unmount();
  }
});
