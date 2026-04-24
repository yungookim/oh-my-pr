import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import App from "./tui/App";
import { createTestRuntime } from "./tui/testRuntime";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function typeText(ui: ReturnType<typeof render>, value: string) {
  for (const character of value) {
    ui.stdin.write(character);
    await flush();
  }
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

test("tui blocks on onboarding when no watched repos or tracked PRs exist", async () => {
  const runtime = createTestRuntime({
    prs: [],
    repos: [],
    config: {
      ...(await createTestRuntime().getConfig()),
      watchedRepos: [],
    },
  });
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    assert.match(ui.lastFrame() ?? "", /First-time setup/);
    assert.match(ui.lastFrame() ?? "", /owner\/repo/);
    assert.doesNotMatch(ui.lastFrame() ?? "", /Pull Requests/);
  } finally {
    ui.unmount();
  }
});

test("tui onboarding shows inline validation errors for invalid repo slugs", async () => {
  const runtime = createTestRuntime({
    prs: [],
    repos: [],
    config: {
      ...(await createTestRuntime().getConfig()),
      watchedRepos: [],
    },
  });
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    await typeText(ui, "not a slug");
    ui.stdin.write("\r");
    await flush();

    assert.match(ui.lastFrame() ?? "", /Invalid repository/);
    assert.match(ui.lastFrame() ?? "", /First-time setup/);
  } finally {
    ui.unmount();
  }
});

test("tui onboarding transitions into the main UI after adding a repo", async () => {
  const runtime = createTestRuntime({
    prs: [],
    repos: [],
    config: {
      ...(await createTestRuntime().getConfig()),
      watchedRepos: [],
    },
  });
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    await typeText(ui, "acme/widgets");
    ui.stdin.write("\r");
    await flush();
    await flush();

    assert.match(ui.lastFrame() ?? "", /Pull Requests/);
    assert.match(ui.lastFrame() ?? "", /No tracked PRs\./);
  } finally {
    ui.unmount();
  }
});

test("tui skips onboarding when tracked PRs already exist even without watched repos", async () => {
  const config = await createTestRuntime().getConfig();
  const runtime = createTestRuntime({
    repos: [],
    config: {
      ...config,
      watchedRepos: [],
    },
  });
  const ui = render(<App runtime={runtime} screenWidth={160} screenHeight={24} refreshMs={0} />);

  try {
    await flush();
    assert.match(ui.lastFrame() ?? "", /Pull Requests/);
    assert.doesNotMatch(ui.lastFrame() ?? "", /First-time setup/);
  } finally {
    ui.unmount();
  }
});
