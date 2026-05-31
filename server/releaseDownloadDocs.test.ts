import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type CargoLockPackage = {
  name?: string;
  version?: string;
};

function parseCargoLockToml(content: string): { package: CargoLockPackage[] } {
  const packages: CargoLockPackage[] = [];
  let currentPackage: CargoLockPackage | undefined;

  for (const rawLine of content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    const line = rawLine.trim();
    if (line === "[[package]]") {
      currentPackage = {};
      packages.push(currentPackage);
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      currentPackage = undefined;
      continue;
    }

    if (!currentPackage || !line.includes("=")) continue;

    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (key !== "name" && key !== "version") continue;

    const value = line.slice(separator + 1).trim();
    if (!value.startsWith("\"") || !value.endsWith("\"")) continue;

    const parsed = JSON.parse(value);
    if (typeof parsed === "string") {
      currentPackage[key] = parsed;
    }
  }

  return { package: packages };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tauriMinorVersionRangePattern(tauriVersion: string): RegExp {
  const expectedMinor = tauriVersion.split(".").slice(0, 2).join(".");
  return new RegExp(`\\^${escapeRegExp(expectedMinor)}\\.`);
}

test("Tauri release workflow uploads desktop assets to the published GitHub release", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/tauri-build.yml"), "utf8");

  assert.match(workflow, /release:\s*\n\s+types:\s*\[published\]/);
  assert.match(workflow, /uses:\s*tauri-apps\/tauri-action@v0/);
  assert.match(workflow, /releaseId:\s*\$\{\{\s*github\.event\.release\.id\s*\}\}/);
  assert.match(workflow, /tagName:\s*\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/);
  assert.match(workflow, /releaseAssetNamePattern:\s*"oh-my-pr-\[version\]-\[platform\]-\[arch\]\[setup\]\.\[ext\]"/);
  assert.doesNotMatch(workflow, /^\s+assetNamePattern:/m);
  assert.match(workflow, /Upload stable macOS Apple Silicon DMG link/);
  assert.match(workflow, /oh-my-pr-macos-arm64\.dmg/);
  assert.match(workflow, /dmg_path="\$\(find "\$dmg_dir" -name '\*\.dmg' -type f -print -quit\)"/);
  assert.match(workflow, /gh release upload "\$\{\{\s*github\.event\.release\.tag_name\s*\}\}" stable-assets\/oh-my-pr-macos-arm64\.dmg --clobber/);
});

test("Tauri release workflow removes cached DMGs before building the stable macOS asset", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/tauri-build.yml"), "utf8");
  const cleanupStepIndex = workflow.indexOf("Remove stale macOS Apple Silicon DMG artifacts");
  const buildStepIndex = workflow.indexOf("Build and upload Tauri release assets");

  assert.ok(cleanupStepIndex > -1, "workflow must remove stale cached arm64 DMGs before building");
  assert.ok(cleanupStepIndex < buildStepIndex, "stale DMG cleanup must run before tauri-action builds new assets");
  assert.match(workflow, /if:\s*matrix\.target == 'aarch64-apple-darwin'/);
  assert.match(workflow, /dmg_dir="src-tauri\/target\/\$\{\{\s*matrix\.target\s*\}\}\/release\/bundle\/dmg"/);
  assert.match(workflow, /find "\$dmg_dir" -name '\*\.dmg' -type f -exec rm -f \{\} \+/);
});

test("README links users to desktop release downloads and names the macOS signing caveat", () => {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /https:\/\/github\.com\/yungookim\/oh-my-pr\/releases\/latest\/download\/oh-my-pr-macos-arm64\.dmg/);
  assert.match(readme, /not notarized/i);
});

test("Tauri JavaScript and Rust packages stay on the same minor version", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const cargoLock = readFileSync(path.join(repoRoot, "src-tauri/Cargo.lock"), "utf8");
  const cargo = parseCargoLockToml(cargoLock);
  const apiVersion = packageJson.dependencies["@tauri-apps/api"];
  const cliVersion = packageJson.devDependencies["@tauri-apps/cli"];
  const tauriVersion = cargo.package.find((pkg) => pkg.name === "tauri")?.version;

  assert.ok(tauriVersion, "Cargo.lock must include the tauri crate");

  const minorVersionPattern = tauriMinorVersionRangePattern(tauriVersion);
  assert.match(apiVersion, minorVersionPattern);
  assert.match(cliVersion, minorVersionPattern);
});

test("Tauri minor version matcher treats dots literally", () => {
  const minorVersionPattern = tauriMinorVersionRangePattern("2.11.4");

  assert.match("^2.11.0", minorVersionPattern);
  assert.doesNotMatch("^2x11.0", minorVersionPattern);
});

test("macOS DMG uses a custom install instruction background", () => {
  const config = JSON.parse(readFileSync(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"));
  const dmg = config.bundle.macOS.dmg;
  const background = path.join(repoRoot, "src-tauri", dmg.background);

  assert.equal(dmg.background, "assets/dmg-background.png");
  assert.deepEqual(dmg.windowSize, { width: 660, height: 400 });
  assert.deepEqual(dmg.appPosition, { x: 190, y: 235 });
  assert.deepEqual(dmg.applicationFolderPosition, { x: 470, y: 235 });
  assert.equal(existsSync(background), true);

  const png = readFileSync(background);
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), 660);
  assert.equal(png.readUInt32BE(20), 400);
});
