/**
 * Converts Markdown files in docs/public/ to beautifully styled HTML pages.
 *
 * Each .md file becomes a standalone .html file in docs/public/_site/.
 * An index.html is also generated listing all available documents.
 *
 * Usage: npx tsx script/build-public-docs.ts
 */

import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

const DOCS_DIR = path.resolve(import.meta.dirname, "../docs/public");
const OUT_DIR = path.join(DOCS_DIR, "_site");
const SHARED_STYLESHEET = "styles.css";

/** HTML template that wraps rendered markdown content */
function htmlTemplate(title: string, content: string, isIndex: boolean): string {
  const navBackLink = isIndex
    ? `<a href="../../index.html" class="nav-back">← Back to CodeFactory</a>`
    : `<a href="./index.html" class="nav-back">← All Documentation</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="CodeFactory Documentation — ${title}" />
  <title>${title} | CodeFactory Docs</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="${SHARED_STYLESHEET}" />
</head>
<body>
  <nav class="top-nav">
    <div class="nav-inner">
      <a href="../../index.html" class="brand">CodeFactory</a>
      <span class="nav-separator">/</span>
      <span class="nav-section">Documentation</span>
    </div>
  </nav>
  <div class="layout">
    <main class="content">
      <div class="breadcrumb">${navBackLink}</div>
      <article class="prose">
        ${content}
      </article>
    </main>
  </div>
</body>
</html>`;
}

interface DocMeta {
  slug: string;
  title: string;
  description: string;
  htmlFile: string;
}

/** Extract the first H1 and first paragraph from markdown as title and description */
function extractMeta(markdown: string, filename: string): { title: string; description: string } {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : filename.replace(/\.md$/, "");

  // Get first paragraph after the title
  const lines = markdown.split("\n");
  let description = "";
  let pastTitle = false;
  for (const line of lines) {
    if (!pastTitle) {
      if (titleMatch && line.startsWith("# ")) {
        pastTitle = true;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#") || trimmed.startsWith("```") || trimmed.startsWith("|") || trimmed.startsWith("-")) break;
    description = trimmed;
    break;
  }

  return { title, description };
}

function generateIndexPage(docs: DocMeta[]): string {
  const cards = docs
    .map(
      (doc) => `
      <a href="./${doc.htmlFile}" class="doc-card">
        <h3>${doc.title}</h3>
        <p>${doc.description}</p>
      </a>`
    )
    .join("\n");

  const content = `
    <h1>Documentation</h1>
    <p>Everything you need to know about using CodeFactory to automate your PR review workflow.</p>
    <div class="doc-grid">
      ${cards}
    </div>
  `;

  return htmlTemplate("Documentation", content, true);
}

// Rewrite .md links to .html links in the rendered HTML
function rewriteLinks(html: string): string {
  return html.replace(/href="\.\/([^"]+)\.md"/g, 'href="./$1.html"');
}

async function main() {
  // Clean output directory
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Copy the shared stylesheet so the source stays lintable and maintainable.
  fs.copyFileSync(path.join(DOCS_DIR, SHARED_STYLESHEET), path.join(OUT_DIR, SHARED_STYLESHEET));

  // Find all .md files
  const files = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));

  if (files.length === 0) {
    console.log("No markdown files found in docs/public/");
    return;
  }

  const docs: DocMeta[] = [];

  // Ordered list for the index (getting-started first)
  const orderedFiles = [
    "getting-started.md",
    ...files.filter((f) => f !== "getting-started.md").sort(),
  ].filter((f) => files.includes(f));

  for (const file of orderedFiles) {
    const markdown = fs.readFileSync(path.join(DOCS_DIR, file), "utf-8");
    const { title, description } = extractMeta(markdown, file);
    const slug = file.replace(/\.md$/, "");
    const htmlFile = `${slug}.html`;

    const rendered = rewriteLinks(await marked.parse(markdown));
    const html = htmlTemplate(title, rendered, false);

    fs.writeFileSync(path.join(OUT_DIR, htmlFile), html);
    docs.push({ slug, title, description, htmlFile });

    console.log(`  ✓ ${file} → ${htmlFile}`);
  }

  // Generate index
  const indexHtml = generateIndexPage(docs);
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), indexHtml);
  console.log(`  ✓ index.html (${docs.length} documents)`);

  console.log(`\nBuilt ${docs.length} docs → ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("Failed to build public docs:", err);
  process.exit(1);
});
