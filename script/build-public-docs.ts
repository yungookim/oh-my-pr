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

/** HTML template that wraps rendered markdown content */
function htmlTemplate(title: string, content: string, isIndex: boolean): string {
  const navBackLink = isIndex
    ? `<a href="../index.html" class="nav-back">← Back to CodeFactory</a>`
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
  <style>${getStyles()}</style>
</head>
<body>
  <nav class="top-nav">
    <div class="nav-inner">
      <a href="../index.html" class="brand">CodeFactory</a>
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

function getStyles(): string {
  return `
    :root {
      --bg: #0e0e0e;
      --bg-elevated: #1a1919;
      --bg-card: #201f1f;
      --bg-code: #161616;
      --text: #ffffff;
      --text-secondary: #adaaaa;
      --text-muted: #777575;
      --primary: #9ba8ff;
      --primary-dim: #4963ff;
      --border: #494847;
      --border-subtle: rgba(73, 72, 71, 0.3);
      --accent-gradient: linear-gradient(135deg, #4963ff 0%, #9ba8ff 100%);
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: "Inter", system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
    }

    .top-nav {
      position: sticky;
      top: 0;
      z-index: 50;
      background: rgba(14, 14, 14, 0.85);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border-subtle);
      padding: 0.875rem 2rem;
    }

    .nav-inner {
      max-width: 56rem;
      margin: 0 auto;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .brand {
      font-weight: 800;
      font-size: 1.1rem;
      color: var(--primary);
      text-decoration: none;
      letter-spacing: -0.02em;
    }

    .nav-separator { color: var(--text-muted); }
    .nav-section { color: var(--text-secondary); font-size: 0.875rem; }

    .layout {
      max-width: 56rem;
      margin: 0 auto;
      padding: 2rem;
    }

    .breadcrumb { margin-bottom: 2rem; }

    .nav-back {
      color: var(--primary);
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      transition: opacity 0.15s;
    }
    .nav-back:hover { opacity: 0.8; }

    /* Prose styles */
    .prose h1 {
      font-size: 2.5rem;
      font-weight: 900;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 1.5rem;
      background: linear-gradient(to bottom, #fff 0%, #adaaaa 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .prose h2 {
      font-size: 1.5rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-top: 3rem;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border-subtle);
    }

    .prose h3 {
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      margin-top: 2rem;
      margin-bottom: 0.75rem;
      color: var(--primary);
    }

    .prose p {
      margin-bottom: 1rem;
      color: var(--text-secondary);
    }

    .prose strong { color: var(--text); font-weight: 600; }

    .prose a {
      color: var(--primary);
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.15s;
    }
    .prose a:hover { border-bottom-color: var(--primary); }

    .prose ul, .prose ol {
      margin-bottom: 1rem;
      padding-left: 1.5rem;
      color: var(--text-secondary);
    }
    .prose li { margin-bottom: 0.35rem; }
    .prose li strong { color: var(--text); }

    .prose code {
      font-family: "JetBrains Mono", monospace;
      font-size: 0.85em;
      background: var(--bg-code);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 0.15em 0.4em;
      color: var(--primary);
    }

    .prose pre {
      background: var(--bg-code);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
      overflow-x: auto;
    }

    .prose pre code {
      background: none;
      border: none;
      padding: 0;
      font-size: 0.875rem;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .prose blockquote {
      border-left: 3px solid var(--primary-dim);
      margin: 1.5rem 0;
      padding: 0.75rem 1.25rem;
      background: rgba(73, 99, 255, 0.05);
      border-radius: 0 8px 8px 0;
    }
    .prose blockquote p { color: var(--text-secondary); margin-bottom: 0; }

    .prose table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 1.5rem;
      font-size: 0.9rem;
    }

    .prose th {
      text-align: left;
      padding: 0.75rem 1rem;
      background: var(--bg-elevated);
      border-bottom: 2px solid var(--border);
      font-weight: 700;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--primary);
    }

    .prose td {
      padding: 0.65rem 1rem;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-secondary);
    }

    .prose tr:last-child td { border-bottom: none; }

    .prose hr {
      border: none;
      border-top: 1px solid var(--border-subtle);
      margin: 2rem 0;
    }

    /* Index page doc cards */
    .doc-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
      margin-top: 1.5rem;
    }

    .doc-card {
      display: block;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 1.5rem;
      text-decoration: none;
      transition: border-color 0.2s, transform 0.15s;
    }
    .doc-card:hover {
      border-color: var(--primary);
      transform: translateY(-2px);
    }
    .doc-card h3 {
      color: var(--text);
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    .doc-card p {
      color: var(--text-muted);
      font-size: 0.875rem;
      line-height: 1.5;
    }

    @media (max-width: 640px) {
      .layout { padding: 1rem; }
      .prose h1 { font-size: 1.75rem; }
      .prose h2 { font-size: 1.25rem; }
      .doc-grid { grid-template-columns: 1fr; }
    }
  `;
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
