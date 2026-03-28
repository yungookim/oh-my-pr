#!/usr/bin/env node
"use strict";

const pkg = require("../package.json");
const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

if (arg === "--help" || arg === "-h") {
  console.log(`
  oh-my-pr v${pkg.version}

  Autonomous GitHub PR babysitter — watches repos, triages review
  feedback, and dispatches AI agents to fix code locally.

  Usage:
    oh-my-pr              Start the dashboard server
    oh-my-pr --help       Show this help message
    oh-my-pr --version    Print the version

  Environment variables:
    PORT                  Server port (default: 5001)
    GITHUB_TOKEN          GitHub personal access token
    OH_MY_PR_HOME         Override config/state directory (~/.oh-my-pr)

  https://github.com/yungookim/oh-my-pr
`);
  process.exit(0);
}

process.env.NODE_ENV = process.env.NODE_ENV || "production";
require("../dist/index.cjs");
