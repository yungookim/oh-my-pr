import { readFile, access } from "fs/promises";
import path from "path";
import type { DeploymentPlatform } from "@shared/schema";

export type PlatformDetection = {
  platform: DeploymentPlatform;
  configPath: string;
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectVercel(repoPath: string): Promise<PlatformDetection | null> {
  if (await fileExists(path.join(repoPath, "vercel.json"))) {
    return { platform: "vercel", configPath: "vercel.json" };
  }
  if (await fileExists(path.join(repoPath, ".vercel", "project.json"))) {
    return { platform: "vercel", configPath: ".vercel/project.json" };
  }
  const pkgPath = path.join(repoPath, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      const scripts = pkg.scripts ?? {};
      const hasVercel = Object.values(scripts).some(
        (script) => typeof script === "string" && script.includes("vercel"),
      );
      if (hasVercel) {
        return { platform: "vercel", configPath: "package.json" };
      }
    } catch { /* malformed package.json */ }
  }
  return null;
}

async function detectRailway(repoPath: string): Promise<PlatformDetection | null> {
  if (await fileExists(path.join(repoPath, "railway.toml"))) {
    return { platform: "railway", configPath: "railway.toml" };
  }
  if (await fileExists(path.join(repoPath, "railway.json"))) {
    return { platform: "railway", configPath: "railway.json" };
  }
  if (await fileExists(path.join(repoPath, "nixpacks.toml"))) {
    return { platform: "railway", configPath: "nixpacks.toml" };
  }
  return null;
}

export async function detectDeploymentPlatform(repoPath: string): Promise<PlatformDetection | null> {
  return await detectVercel(repoPath) ?? await detectRailway(repoPath);
}
