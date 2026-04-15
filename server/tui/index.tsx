#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import App from "./App";
import { createAppRuntime } from "../appRuntime";

async function main() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("oh-my-pr tui requires an interactive TTY.");
    process.exit(1);
  }

  const runtime = createAppRuntime();
  await runtime.start();

  const ink = render(
    <App
      runtime={runtime}
      onExit={() => {
        runtime.stop();
      }}
    />,
  );

  try {
    await ink.waitUntilExit();
  } finally {
    runtime.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
