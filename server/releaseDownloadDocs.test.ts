import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

test("Tauri release workflow uploads desktop assets to the published GitHub release", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/tauri-build.yml"), "utf8");

  assert.match(workflow, /release:\s*\n\s+types:\s*\[published\]/);
  assert.match(workflow, /uses:\s*tauri-apps\/tauri-action@v0/);
  assert.match(workflow, /releaseId:\s*\$\{\{\s*github\.event\.release\.id\s*\}\}/);
  assert.match(workflow, /tagName:\s*\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/);
  assert.match(workflow, /assetNamePattern:\s*"oh-my-pr-\[version\]-\[platform\]-\[arch\]\[setup\]\.\[ext\]"/);
  assert.match(workflow, /Upload stable macOS Apple Silicon DMG link/);
  assert.match(workflow, /oh-my-pr-macos-arm64\.dmg/);
  assert.match(workflow, /gh release upload "\$\{\{\s*github\.event\.release\.tag_name\s*\}\}" stable-assets\/oh-my-pr-macos-arm64\.dmg --clobber/);
});

test("README links users to desktop release downloads and names the macOS signing caveat", () => {
  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");

  assert.match(readme, /https:\/\/github\.com\/yungookim\/oh-my-pr\/releases\/latest\/download\/oh-my-pr-macos-arm64\.dmg/);
  assert.match(readme, /not notarized/i);
});

test("Tauri JavaScript and Rust packages stay on the same minor version", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const cargoLock = readFileSync(path.join(repoRoot, "src-tauri/Cargo.lock"), "utf8");
  const apiVersion = packageJson.dependencies["@tauri-apps/api"];
  const cliVersion = packageJson.devDependencies["@tauri-apps/cli"];
  const tauriVersion = cargoLock.match(/name = "tauri"\nversion = "([^"]+)"/)?.[1];

  assert.ok(tauriVersion, "Cargo.lock must include the tauri crate");

  const expectedMinor = tauriVersion.split(".").slice(0, 2).join(".");
  assert.match(apiVersion, new RegExp(`\\^${expectedMinor}\\.`));
  assert.match(cliVersion, new RegExp(`\\^${expectedMinor}\\.`));
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
