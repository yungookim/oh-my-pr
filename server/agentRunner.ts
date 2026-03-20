import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { spawn } from "child_process";

export type CodingAgent = "codex" | "claude";

export type EvaluationResult = {
  needsFix: boolean;
  reason: string;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
};

const AGENTS: CodingAgent[] = ["codex", "claude"];

function modelArgs(model?: string): string[] {
  return model ? ["--model", model] : [];
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand("which", [command], {
    timeoutMs: 4000,
  });

  return result.code === 0;
}

export async function resolveAgent(preferred: CodingAgent): Promise<CodingAgent> {
  if (!AGENTS.includes(preferred)) {
    preferred = "codex";
  }

  if (await commandExists(preferred)) {
    return preferred;
  }

  const fallback = preferred === "codex" ? "claude" : "codex";
  if (await commandExists(fallback)) {
    return fallback;
  }

  throw new Error("Neither codex nor claude CLI is installed");
}

export async function evaluateFixNecessityWithAgent(params: {
  agent: CodingAgent;
  cwd: string;
  prompt: string;
  model?: string;
}): Promise<EvaluationResult> {
  const { agent, cwd, prompt, model } = params;

  const extractionPrompt = [
    "Respond with ONLY valid JSON and nothing else.",
    "Schema: {\"needsFix\": boolean, \"reason\": string}",
    prompt,
  ].join("\n\n");

  if (agent === "codex") {
    const tempDir = await mkdtemp(path.join(tmpdir(), "codex-eval-"));
    const outputFile = path.join(tempDir, "output.txt");

    try {
      const result = await runCommand(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "-o",
          outputFile,
          extractionPrompt,
        ],
        { cwd, timeoutMs: 180000 },
      );

      if (result.code !== 0) {
        throw new Error(`codex evaluation failed (${result.code}): ${result.stderr || result.stdout}`);
      }

      let raw: string;
      try {
        raw = await readFile(outputFile, "utf8");
      } catch (error) {
        if (isMissingFileError(error)) {
          const suffix = result.stderr ? `: ${result.stderr}` : "";
          throw new Error(
            `codex evaluation completed without writing expected output file ${outputFile}${suffix}`,
            { cause: error },
          );
        }
        throw error;
      }
      return parseEvaluationOutput(raw);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const claudeArgs = [
    "-p",
    "--output-format",
    "text",
    ...modelArgs(model),
    extractionPrompt,
  ];

  const result = await runCommand(
    "claude",
    claudeArgs,
    { cwd, timeoutMs: 180000 },
  );

  if (result.code !== 0) {
    throw new Error(`claude evaluation failed (${result.code}): ${result.stderr || result.stdout}`);
  }

  return parseEvaluationOutput(result.stdout);
}

export async function applyFixesWithAgent(params: {
  agent: CodingAgent;
  cwd: string;
  prompt: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}): Promise<CommandResult> {
  const { agent, cwd, prompt, model, env, onStdoutChunk, onStderrChunk } = params;

  if (agent === "codex") {
    const result = await runCommand(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--full-auto",
        "--sandbox",
        "workspace-write",
        prompt,
      ],
      { cwd, env, timeoutMs: 900000, onStdoutChunk, onStderrChunk },
    );

    return result;
  }

  return runCommand(
    "claude",
    [
      "-p",
      "--permission-mode",
      "auto",
      ...modelArgs(model),
      prompt,
    ],
    { cwd, env, timeoutMs: 900000, onStdoutChunk, onStderrChunk },
  );
}

function parseEvaluationOutput(output: string): EvaluationResult {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("Agent returned empty output for evaluation");
  }

  const parsed = tryParseJsonFromText(trimmed);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Could not parse evaluation JSON from output: ${trimmed.slice(0, 500)}`);
  }

  const candidate = parsed as { needsFix?: unknown; reason?: unknown };

  if (typeof candidate.needsFix !== "boolean") {
    throw new Error("Evaluation output missing boolean 'needsFix'");
  }

  return {
    needsFix: candidate.needsFix,
    reason: typeof candidate.reason === "string" ? candidate.reason : "No reason provided",
  };
}

function tryParseJsonFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // ignore and attempt extraction below
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const candidate = text.slice(firstBrace, lastBrace + 1);

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
  },
): Promise<CommandResult> {
  const timeoutMs = options?.timeoutMs ?? 120000;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options?.onStdoutChunk?.(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      options?.onStderrChunk?.(text);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stderrParts = [stderr.trim()];
      if (timedOut) {
        stderrParts.push(`Command timed out after ${timeoutMs}ms`);
      } else if (signal) {
        stderrParts.push(`Command terminated by signal ${signal}`);
      }

      resolve({
        stdout,
        stderr: stderrParts.filter(Boolean).join("\n"),
        code: timedOut ? 124 : (code ?? 1),
        signal,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        code: 1,
      });
    });
  });
}
