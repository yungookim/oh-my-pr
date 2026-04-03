import path from "path";
import { runCommand } from "./agentRunner";
import type { CommandResult } from "./agentRunner";
import { getCodeFactoryPaths } from "./paths";
import { sanitizeRepoName } from "./repoWorkspace";

export type DeploymentState = "building" | "deploying" | "ready" | "error" | "not_found";

export type DeploymentStatus = {
  state: DeploymentState;
  deploymentId: string | null;
  url: string | null;
  error: string | null;
};

type RunCommand = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }) => Promise<CommandResult>;

export interface DeploymentPlatformAdapter {
  platform: string;
  getDeploymentStatus(params: { repo: string; sha: string }): Promise<DeploymentStatus>;
  getDeploymentLogs(params: { repo: string; deploymentId: string }): Promise<string>;
}

function mapVercelState(state: string): DeploymentState {
  switch (state.toUpperCase()) {
    case "READY":
      return "ready";
    case "BUILDING":
      return "building";
    case "DEPLOYING":
    case "QUEUED":
    case "INITIALIZING":
      return "deploying";
    case "ERROR":
    case "CANCELED":
      return "error";
    default:
      return "error";
  }
}

function mapRailwayStatus(status: string): DeploymentState {
  switch (status.toUpperCase()) {
    case "SUCCESS":
      return "ready";
    case "BUILDING":
      return "building";
    case "DEPLOYING":
      return "deploying";
    case "INITIALIZING":
    case "QUEUED":
      return "deploying";
    case "FAILED":
    case "CRASHED":
    case "REMOVED":
      return "error";
    default:
      return "error";
  }
}

function getRepoCacheDir(repo: string): string {
  return path.join(getCodeFactoryPaths().repoRootDir, sanitizeRepoName(repo));
}

export class VercelAdapter implements DeploymentPlatformAdapter {
  readonly platform = "vercel";

  private run: RunCommand;

  constructor(run?: RunCommand) {
    this.run = run ?? runCommand;
  }

  async getDeploymentStatus(params: { repo: string; sha: string }): Promise<DeploymentStatus> {
    const { sha } = params;

    const result = await this.run("vercel", [
      "list",
      "--meta",
      `githubCommitSha=${sha}`,
      "--json",
    ]);

    if (result.code !== 0) {
      return { state: "error", deploymentId: null, url: null, error: result.stderr || "vercel list failed" };
    }

    let parsed: { deployments?: Array<{ uid: string; state: string; url?: string | null; errorMessage?: string; meta?: Record<string, string> }> };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { state: "error", deploymentId: null, url: null, error: "Failed to parse vercel list output" };
    }

    const deployments = parsed.deployments ?? [];
    if (deployments.length === 0) {
      return { state: "not_found", deploymentId: null, url: null, error: null };
    }

    const deployment = deployments[0];
    const normalizedState = deployment.state.toUpperCase();
    return {
      state: mapVercelState(deployment.state),
      deploymentId: deployment.uid,
      url: deployment.url ?? null,
      error: normalizedState === "ERROR" ? (deployment.errorMessage ?? "Deployment failed") : null,
    };
  }

  async getDeploymentLogs(params: { repo: string; deploymentId: string }): Promise<string> {
    const { deploymentId } = params;

    const inspectResult = await this.run("vercel", ["inspect", deploymentId, "--json"]);
    let url = deploymentId;

    if (inspectResult.code === 0) {
      try {
        const inspected = JSON.parse(inspectResult.stdout) as { url?: string };
        if (inspected.url) {
          url = inspected.url;
        }
      } catch {
        // fall through with deploymentId as url
      }
    }

    const logsResult = await this.run("vercel", ["logs", url]);
    return logsResult.stdout || logsResult.stderr;
  }
}

export class RailwayAdapter implements DeploymentPlatformAdapter {
  readonly platform = "railway";

  private run: RunCommand;

  constructor(run?: RunCommand) {
    this.run = run ?? runCommand;
  }

  async getDeploymentStatus(params: { repo: string; sha: string }): Promise<DeploymentStatus> {
    const result = await this.run("railway", ["status", "--json"], {
      cwd: getRepoCacheDir(params.repo),
    });

    if (result.code !== 0) {
      return { state: "error", deploymentId: null, url: null, error: result.stderr || "railway status failed" };
    }

    let parsed: { deploymentId?: string; status?: string; url?: string | null };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { state: "error", deploymentId: null, url: null, error: "Failed to parse railway status output" };
    }

    return {
      state: mapRailwayStatus(parsed.status ?? ""),
      deploymentId: parsed.deploymentId ?? null,
      url: parsed.url ?? null,
      error: null,
    };
  }

  async getDeploymentLogs(params: { repo: string; deploymentId: string }): Promise<string> {
    const { repo, deploymentId } = params;

    const result = await this.run("railway", ["logs", "--deployment", deploymentId], {
      cwd: getRepoCacheDir(repo),
    });
    return result.stdout || result.stderr;
  }
}

export function createAdapter(platform: string, run?: RunCommand): DeploymentPlatformAdapter {
  switch (platform.toLowerCase()) {
    case "vercel":
      return new VercelAdapter(run);
    case "railway":
      return new RailwayAdapter(run);
    default:
      throw new Error(`Unsupported deployment platform: ${platform}`);
  }
}
