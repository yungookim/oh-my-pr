import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const optionalPackageRequires = new Set([
  // debug probes this in a try/catch for terminal colors; it is not required
  // for the packaged server to start.
  "supports-color",
]);

function isPackageRequire(specifier: string) {
  return !specifier.startsWith(".")
    && !specifier.startsWith("/")
    && !builtins.has(specifier);
}

test("production server bundle is self-contained for desktop resources", async (t) => {
  const bundlePath = path.resolve("dist/index.cjs");
  if (!existsSync(bundlePath)) {
    t.skip("run npm run build before checking the packaged server bundle");
    return;
  }

  const bundle = await readFile(bundlePath, "utf-8");
  const packageRequires = Array.from(bundle.matchAll(/require\(["']([^"']+)["']\)/g))
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined
      && isPackageRequire(specifier)
      && !optionalPackageRequires.has(specifier));

  assert.deepEqual([...new Set(packageRequires)].sort(), []);
});
