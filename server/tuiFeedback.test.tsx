import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import App from "./tui/App";
import { createTestRuntime } from "./tui/testRuntime";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("tui expands feedback rows and applies accept decisions with arrow keys and Enter", async () => {
  const runtime = createTestRuntime();
  const ui = render(<App runtime={runtime} screenWidth={160} refreshMs={0} />);

  try {
    await flush();
    ui.stdin.write("\t");
    await flush();
    ui.stdin.write("\r");
    await flush();

    assert.match(ui.lastFrame() ?? "", /Please rename this variable for/);
    assert.match(ui.lastFrame() ?? "", /clarity/);
    assert.match(ui.lastFrame() ?? "", /Collaps/);

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

test("tui shows retry for failed feedback and refreshes live logs on runtime events", async () => {
  const runtime = createTestRuntime({
    prs: [
      {
        ...(await createTestRuntime().getPR("pr-1"))!,
        feedbackItems: [
          {
            ...(await createTestRuntime().getPR("pr-1"))!.feedbackItems[0]!,
            status: "failed",
          },
        ],
      },
    ],
  });
  const ui = render(<App runtime={runtime} screenWidth={160} refreshMs={0} />);

  try {
    await flush();
    ui.stdin.write("\t");
    await flush();
    ui.stdin.write("\r");
    await flush();

    assert.match(ui.lastFrame() ?? "", /Retry/);

    runtime.appendLog("pr-1", "Follow-up log line");
    await flush();
    assert.match(ui.lastFrame() ?? "", /Follow-up log line/);
  } finally {
    ui.unmount();
  }
});
