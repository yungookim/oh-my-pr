import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { detectDeploymentPlatform } from "./deploymentPlatformDetector";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = path.join(tmpdir(), `deploy-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detects vercel.json", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "vercel.json"), "{}");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "vercel");
    assert.equal(result!.configPath, "vercel.json");
  });
});

test("detects .vercel/project.json", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, ".vercel"), { recursive: true });
    await writeFile(path.join(dir, ".vercel", "project.json"), "{}");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "vercel");
    assert.equal(result!.configPath, ".vercel/project.json");
  });
});

test("detects vercel in package.json scripts", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      scripts: { deploy: "vercel --prod" },
    }));
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "vercel");
    assert.equal(result!.configPath, "package.json");
  });
});

test("detects railway.toml", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "railway.toml"), "[build]");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "railway");
    assert.equal(result!.configPath, "railway.toml");
  });
});

test("detects railway.json", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "railway.json"), "{}");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "railway");
    assert.equal(result!.configPath, "railway.json");
  });
});

test("detects nixpacks.toml as railway", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "nixpacks.toml"), "[phases.build]");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "railway");
    assert.equal(result!.configPath, "nixpacks.toml");
  });
});

test("returns null when no platform detected", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      scripts: { start: "node index.js" },
    }));
    const result = await detectDeploymentPlatform(dir);
    assert.equal(result, null);
  });
});

test("vercel takes priority over railway when both present", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "vercel.json"), "{}");
    await writeFile(path.join(dir, "railway.toml"), "[build]");
    const result = await detectDeploymentPlatform(dir);
    assert.ok(result);
    assert.equal(result!.platform, "vercel");
  });
});
