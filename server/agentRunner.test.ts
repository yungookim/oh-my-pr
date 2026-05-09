import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyFixesWithAgent, checkAgentHealth, detectAgentUnavailability, evaluateFixNecessityWithAgent, resolveAgent, resolveCommandPath, runCommand, summarizeAgentCommandFailure } from "./agentRunner";

test("runCommand reports a timeout even when the child exits 0 after SIGTERM", async () => {
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
    ],
    { timeoutMs: 50 },
  );

  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out after 50ms/i);
});

test("runCommand escalates timed-out children that ignore SIGTERM", async () => {
  const startedAt = Date.now();
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ],
    { timeoutMs: 50, killTimeoutMs: 50 },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out after 50ms/i);
  assert.ok(elapsedMs < 1500, `expected forced cleanup, took ${elapsedMs}ms`);
});

test("evaluateFixNecessityWithAgent throws a clear error when codex writes no output file", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fake-codex-bin-"));
  const fakeCodexPath = path.join(
    tempRoot,
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  const exitHookPath = path.join(tempRoot, "exit-immediately.cjs");
  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;

  try {
    await copyFile(process.execPath, fakeCodexPath);
    await writeFile(exitHookPath, "process.exit(0);\n", "utf8");
    process.env.NODE_OPTIONS = [`--require=${exitHookPath}`, originalNodeOptions]
      .filter(Boolean)
      .join(" ");
    process.env.PATH = [tempRoot, originalPath].filter(Boolean).join(path.delimiter);

    await assert.rejects(
      () =>
        evaluateFixNecessityWithAgent({
          agent: "codex",
          cwd: process.cwd(),
          prompt: "Respond with JSON.",
        }),
      /without writing expected output file/,
    );
  } finally {
    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions;
    }
    process.env.PATH = originalPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("detectAgentUnavailability classifies session permission failures as auth failures", () => {
  assert.equal(
    detectAgentUnavailability("codex health check failed: Error: thread/start: Permission denied"),
    "auth",
  );
  assert.equal(
    detectAgentUnavailability("claude health check failed: ERROR: Failed to create session: Operation not permitted"),
    "auth",
  );
});

test("checkAgentHealth surfaces actionable codex session permission errors", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fake-codex-health-bin-"));
  const fakeCodexPath = path.join(
    tempRoot,
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  const originalPath = process.env.PATH;

  try {
    await writeFile(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "echo 'Reading additional input from stdin...' >&2",
        "echo 'ERROR codex_core::session: Failed to create session: Operation not permitted' >&2",
        "echo 'Error: thread/start: Codex cannot access session files at /Users/dgyk/.codex/sessions (permission denied)' >&2",
        "exit 1",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodexPath, 0o755);
    process.env.PATH = [tempRoot, originalPath].filter(Boolean).join(path.delimiter);

    const result = await checkAgentHealth("codex");

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /cannot access session files/i);
      assert.doesNotMatch(result.reason, /Reading additional input from stdin/);
    }
  } finally {
    process.env.PATH = originalPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("checkAgentHealth reports codex timeouts instead of stdin prelude", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fake-codex-timeout-bin-"));
  const fakeCodexPath = path.join(
    tempRoot,
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  const originalPath = process.env.PATH;

  try {
    await writeFile(
      fakeCodexPath,
      [
        "#!/bin/sh",
        "echo 'Reading additional input from stdin...' >&2",
        "echo 'Command timed out after 30000ms' >&2",
        "exit 124",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodexPath, 0o755);
    process.env.PATH = [tempRoot, originalPath].filter(Boolean).join(path.delimiter);

    const result = await checkAgentHealth("codex");

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /timed out after 30000ms/i);
      assert.doesNotMatch(result.reason, /Reading additional input from stdin/);
      assert.equal(detectAgentUnavailability(result.reason), null);
    }
  } finally {
    process.env.PATH = originalPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("summarizeAgentCommandFailure skips codex stdin prelude", () => {
  const summary = summarizeAgentCommandFailure({
    code: 124,
    stdout: "",
    stderr: [
      "Reading additional input from stdin...",
      "OpenAI Codex v0.128.0 (research preview)",
      "Command timed out after 900000ms",
    ].join("\n"),
    timedOut: true,
  });

  assert.equal(summary, "Command timed out after 900000ms");
});

test("applyFixesWithAgent runs codex without deprecated full-auto flag", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fake-codex-apply-bin-"));
  const fakeCodexPath = path.join(
    tempRoot,
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  const argsPath = path.join(tempRoot, "args.txt");
  const originalPath = process.env.PATH;

  try {
    await writeFile(
      fakeCodexPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > "${argsPath}"`,
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodexPath, 0o755);
    process.env.PATH = [tempRoot, originalPath].filter(Boolean).join(path.delimiter);

    await applyFixesWithAgent({
      agent: "codex",
      cwd: process.cwd(),
      prompt: "Fix the issue.",
    });

    const args = (await readFile(argsPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    assert.ok(args.includes("--sandbox"));
    assert.ok(args.includes("workspace-write"));
    assert.ok(!args.includes("--full-auto"), `unexpected args: ${args.join(" ")}`);
  } finally {
    process.env.PATH = originalPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolveAgent does not fall back when fallback is disabled", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fake-agent-bin-"));
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = tempRoot;

    await assert.rejects(
      () => resolveAgent("claude"),
      /Configured coding agent claude CLI is not installed/,
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolveAgent uses the next coding agent when fallback is enabled", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fake-agent-bin-"));
  const fakeCodexPath = path.join(
    tempRoot,
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  const fakeWhichPath = path.join(
    tempRoot,
    process.platform === "win32" ? "which.cmd" : "which",
  );
  const originalPath = process.env.PATH;

  try {
    await copyFile(process.execPath, fakeCodexPath);
    await chmod(fakeCodexPath, 0o755);
    await writeFile(
      fakeWhichPath,
      `#!/bin/sh\nif [ "$1" = "codex" ]; then echo "${fakeCodexPath}"; exit 0; fi\nexit 1\n`,
      "utf8",
    );
    await chmod(fakeWhichPath, 0o755);
    process.env.PATH = tempRoot;

    assert.equal(await resolveAgent("claude", { allowFallback: true }), "codex");
  } finally {
    process.env.PATH = originalPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolveAgent finds an agent available from the login shell when app PATH is narrow", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fake-login-shell-agent-"));
  const fakeCodexPath = path.join(
    tempRoot,
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  const fakeShellPath = path.join(tempRoot, "fake-shell");
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;

  try {
    await copyFile(process.execPath, fakeCodexPath);
    await chmod(fakeCodexPath, 0o755);
    await writeFile(
      fakeShellPath,
      `#!/bin/sh\nif [ "$1" = "-lc" ] && [ "$2" = "command -v codex" ]; then echo "${fakeCodexPath}"; exit 0; fi\nexit 1\n`,
      "utf8",
    );
    await chmod(fakeShellPath, 0o755);
    process.env.PATH = "/usr/bin:/bin";
    process.env.SHELL = fakeShellPath;

    assert.equal(await resolveAgent("codex"), "codex");
    assert.equal(await resolveCommandPath("codex"), fakeCodexPath);
  } finally {
    process.env.PATH = originalPath;
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runCommand basic behavior
// ---------------------------------------------------------------------------

test("runCommand with echo returns code 0 and stdout", async () => {
  const result = await runCommand("echo", ["hello"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello/);
});

test("runCommand with non-zero exit returns the exit code", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.exit(42)"]);
  assert.equal(result.code, 42);
});

test("runCommand captures stderr", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "console.error('oops')",
  ]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /oops/);
});

test("runCommand onStdoutChunk callback fires with output", async () => {
  const chunks: string[] = [];
  const result = await runCommand(process.execPath, ["-e", "console.log('chunk-test')"], {
    onStdoutChunk: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.code, 0);
  assert.ok(chunks.length > 0, "expected at least one stdout chunk");
  assert.match(chunks.join(""), /chunk-test/);
});

test("runCommand with nonexistent command returns code 1 and error in stderr", async () => {
  const result = await runCommand("__nonexistent_command_xyz__", []);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT|not found/i);
});

test("runCommand cwd option works", async () => {
  const result = await runCommand("pwd", [], { cwd: "/tmp" });
  assert.equal(result.code, 0);
  // Resolve symlinks: /tmp may be a symlink to /private/tmp on macOS
  assert.match(result.stdout.trim(), /\/tmp/);
});
