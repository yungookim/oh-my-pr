import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../../..");

function walk(sourceFile: ts.SourceFile, callback: (node: ts.Node) => void) {
  const visit = (node: ts.Node) => {
    callback(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function getClassName(sourceFile: ts.SourceFile, node: ts.JsxOpeningElement) {
  const classAttribute = node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "className",
  );

  if (!classAttribute?.initializer || !ts.isStringLiteral(classAttribute.initializer)) {
    return undefined;
  }

  return classAttribute.initializer.text;
}

async function parseUpdateBanner() {
  const relativePath = "client/src/components/UpdateBanner.tsx";
  const source = await readFile(path.join(projectRoot, relativePath), "utf-8");
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

test("UpdateBanner styles update steps as a numbered ordered list", async () => {
  const sourceFile = await parseUpdateBanner();
  let orderedListClassName: string | undefined;
  const listItemClassNames: string[] = [];

  walk(sourceFile, (node) => {
    if (!ts.isJsxOpeningElement(node)) {
      return;
    }

    const tagName = node.tagName.getText(sourceFile);
    if (tagName === "ol") {
      orderedListClassName = getClassName(sourceFile, node);
    }
    if (tagName === "li") {
      const className = getClassName(sourceFile, node);
      if (className) {
        listItemClassNames.push(className);
      }
    }
  });

  assert.ok(orderedListClassName, "Expected UpdateBanner to render an ordered list");

  const orderedListClasses = orderedListClassName.split(/\s+/);
  assert.ok(
    orderedListClasses.includes("list-decimal"),
    "Expected list-decimal on the ordered list so browser markers render",
  );
  assert.ok(
    !orderedListClasses.includes("flex") && !orderedListClasses.includes("flex-wrap"),
    "Expected the ordered list not to use flex classes that suppress browser markers",
  );
  assert.ok(
    listItemClassNames.every((className) => !className.split(/\s+/).includes("list-decimal")),
    "Expected decimal marker styling to live on the ordered list parent",
  );
});
