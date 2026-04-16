import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import App from "./tui/App";
import { createTestRuntime } from "./tui/testRuntime";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("tui shows selected feedback in a preview and applies accept decisions with Enter", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    assert.match(ui.lastFrame() ?? "", /Selected feedback/);
    assert.match(ui.lastFrame() ?? "", /Please rename this variable for/);

    ui.stdin.write("\t");
    await flush();
    ui.stdin.write("\r");
    await flush();

    assert.match(ui.lastFrame() ?? "", /Collapse/);

    ui.stdin.write("\u001B[C");
    await flush();
    ui.stdin.write("\r");
    await flush();

    assert.match(ui.lastFrame() ?? "", /Marked feedback as/);
    assert.match(ui.lastFrame() ?? "", /accept/);
    const pr = await runtime.getPR("pr-1");
    assert.equal(pr?.feedbackItems[0]?.status, "queued");
  } finally {
    ui.unmount();
  }
});

test("tui keeps long feedback collections inside a viewport and truncates long row metadata", async () => {
  const baseRuntime = createTestRuntime();
  const basePr = (await baseRuntime.getPR("pr-1"))!;
  const runtime = createTestRuntime({
    prs: [
      {
        ...basePr,
        feedbackItems: Array.from({ length: 12 }, (_, index) => ({
          ...basePr.feedbackItems[0]!,
          id: `feedback-${index}`,
          author: `reviewer-${index}`,
          body: index === 0
            ? "A".repeat(140)
            : `Feedback item ${index} body text that should stay in the preview pane.`,
          file: `frontend/src/really/long/path/that/keeps/going/component-${index}.ts`,
          line: 100 + index,
        })),
      },
    ],
  });
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={22} refreshMs={0} />);

  try {
    await flush();
    assert.match(ui.lastFrame() ?? "", /3\/12/);
    assert.match(ui.lastFrame() ?? "", /↓9/);
    assert.match(ui.lastFrame() ?? "", /frontend\/sr…/);
    assert.match(ui.lastFrame() ?? "", /…/);

    ui.stdin.write("\t");
    await flush();
    ui.stdin.write("\u001B[B");
    ui.stdin.write("\u001B[B");
    ui.stdin.write("\u001B[B");
    ui.stdin.write("\u001B[B");
    await flush();

    assert.match(ui.lastFrame() ?? "", /↑3/);
    assert.match(ui.lastFrame() ?? "", /reviewer-4/);
  } finally {
    ui.unmount();
  }
});
