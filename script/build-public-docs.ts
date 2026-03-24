/**
 * Converts Markdown files in docs/public/ to beautifully styled HTML pages.
 *
 * Each .md file becomes a standalone .html file in docs/public/_site/.
 * An index.html is also generated listing all available documents.
 * All pages share the same header + sidebar navigation as the main docs landing page.
 *
 * Usage: npx tsx script/build-public-docs.ts
 */

import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

const DOCS_DIR = path.resolve(import.meta.dirname, "../docs/public");
const OUT_DIR = path.join(DOCS_DIR, "_site");
const SHARED_STYLESHEET = "styles.css";

/** Sidebar navigation items — mirrors the main docs/index.html sidebar */
interface SidebarLink {
  href: string;
  icon: string;
  label: string;
  slug?: string;
  external?: boolean;
}

interface SidebarSection {
  title: string;
  links: SidebarLink[];
}

/** Returns the sidebar sections. `activeSlug` is used to highlight the current page. */
function getSidebarSections(): SidebarSection[] {
  const docLink = (slug: string, icon: string, label: string): SidebarLink => ({
    href: `./${slug}.html`,
    icon,
    label,
    slug,
  });

  return [
    {
      title: "Getting Started",
      links: [
        { href: "../../index.html", icon: "home", label: "Introduction" },
        docLink("getting-started", "rocket_launch", "Quickstart"),
        docLink("configuration", "settings", "Configuration"),
      ],
    },
    {
      title: "Core Concepts",
      links: [
        docLink("pr-babysitter", "visibility", "PR Babysitter"),
        docLink("agent-dispatch", "smart_toy", "Agent Dispatch"),
        docLink("pr-questions", "chat_bubble", "PR Q&A"),
      ],
    },
    {
      title: "Guides",
      links: [
        { href: "https://github.com/yungookim/codefactory/blob/main/CONTRIBUTING.md", icon: "handshake", label: "Contributing", external: true },
        { href: "https://github.com/yungookim/codefactory/blob/main/LOCAL_API.md", icon: "api", label: "API Reference", external: true },
        { href: "https://github.com/yungookim/codefactory/blob/main/AGENTS.md", icon: "tune", label: "Agent Config", external: true },
      ],
    },
    {
      title: "Resources",
      links: [
        { href: "https://github.com/yungookim/codefactory/releases", icon: "new_releases", label: "Changelog", external: true },
        { href: "https://github.com/yungookim/codefactory/issues", icon: "bug_report", label: "Report an Issue", external: true },
        { href: "https://github.com/yungookim/codefactory", icon: "code", label: "Source Code", external: true },
      ],
    },
  ];
}

/** Generate sidebar HTML, highlighting the link matching `activeSlug` */
function renderSidebar(activeSlug: string): string {
  const sections = getSidebarSections();
  const sectionHtml = sections
    .map((section) => {
      const links = section.links
        .map((link) => {
          const isActive = link.slug === activeSlug;
          const activeClass = isActive ? " active" : "";
          const target = link.external ? ' target="_blank"' : "";
          return `          <a class="sidebar-link${activeClass}" href="${link.href}"${target}>
            <span class="material-symbols-outlined">${link.icon}</span>
            ${link.label}
          </a>`;
        })
        .join("\n");

      return `        <div class="sidebar-section">
          <div class="sidebar-section-title">${section.title}</div>
${links}
        </div>`;
    })
    .join("\n\n");

  return `    <aside class="doc-sidebar">
      <nav>
${sectionHtml}
      </nav>
    </aside>`;
}

/** GitHub SVG icon used in header */
const GITHUB_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>`;

/** HTML template that wraps rendered markdown content with header + sidebar */
function htmlTemplate(title: string, content: string, activeSlug: string): string {
  const isIndex = activeSlug === "__index__";
  const navBackLink = isIndex
    ? `<a href="../../index.html" class="nav-back">← Back to CodeFactory</a>`
    : `<a href="./index.html" class="nav-back">← All Documentation</a>`;

  return `<!DOCTYPE html>
<html class="dark" lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="CodeFactory Documentation — ${title}" />
  <title>${title} | CodeFactory Docs</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="${SHARED_STYLESHEET}" />
  <style>${getStyles()}</style>
</head>
<body>

  <!-- ── Header ── -->
  <header class="doc-header">
    <div class="header-left">
      <a href="../../index.html" class="header-logo">
        <div class="logo-icon">
          <span class="material-symbols-outlined">bolt</span>
        </div>
        CodeFactory
      </a>
      <span class="header-badge">Docs</span>
    </div>

    <div class="header-center">
      <div class="search-trigger" tabindex="0" role="button">
        <span class="material-symbols-outlined">search</span>
        <span>Search documentation...</span>
        <span class="shortcut">
          <kbd>Ctrl</kbd>
          <kbd>K</kbd>
        </span>
      </div>
    </div>

    <div class="header-right">
      <a class="header-link" href="https://github.com/yungookim/codefactory" target="_blank" rel="noreferrer">
        ${GITHUB_SVG}
        <span>GitHub</span>
      </a>
      <a class="header-link" href="https://github.com/yungookim/codefactory/discussions" target="_blank" rel="noreferrer">
        <span class="material-symbols-outlined">forum</span>
        <span>Community</span>
      </a>
    </div>
  </header>

  <!-- ── Sidebar ── -->
${renderSidebar(activeSlug)}

  <!-- ── Main ── -->
  <main class="doc-main">
    <div class="doc-content">
      <div class="breadcrumb">${navBackLink}</div>
      <article class="prose">
        ${content}
      </article>
    </div>
  </main>

</body>
</html>`;
}

/** Layout styles that align generated docs pages with docs/index.html. */
function getStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0a;
      --bg-secondary: #111111;
      --bg-tertiary: #161616;
      --bg-elevated: #1a1a1a;
      --bg-hover: #1f1f1f;
      --bg-code: #161616;
      --border: #1e1e1e;
      --border-hover: #2a2a2a;
      --border-subtle: rgba(30, 30, 30, 0.8);
      --text-primary: #ececec;
      --text-secondary: #a0a0a0;
      --text-tertiary: #6b6b6b;
      --accent: #9ba8ff;
      --accent-dim: #7b8ae6;
      --accent-bg: rgba(155, 168, 255, 0.08);
      --accent-bg-hover: rgba(155, 168, 255, 0.12);
      --accent-border: rgba(155, 168, 255, 0.2);
      --sidebar-w: 260px;
      --header-h: 56px;
    }

    html { scroll-behavior: smooth; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text-primary);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    a { color: inherit; text-decoration: none; }

    /* ── Header ── */
    .doc-header {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: var(--header-h);
      background: rgba(10, 10, 10, 0.8);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
      z-index: 100;
      display: flex;
      align-items: center;
      padding: 0 24px;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 16px;
      width: var(--sidebar-w);
      flex-shrink: 0;
    }

    .header-logo {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
      letter-spacing: -0.02em;
    }

    .header-logo .logo-icon {
      width: 24px;
      height: 24px;
      background: linear-gradient(135deg, #4963ff, #9ba8ff);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .header-logo .logo-icon span {
      font-size: 14px;
      color: #fff;
      font-variation-settings: 'FILL' 1, 'wght' 600;
    }

    .header-badge {
      font-size: 10px;
      font-weight: 600;
      color: var(--accent);
      background: var(--accent-bg);
      border: 1px solid var(--accent-border);
      padding: 2px 8px;
      border-radius: 9999px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .header-center {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 24px;
    }

    .search-trigger {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      max-width: 480px;
      padding: 7px 12px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-tertiary);
      font-size: 13px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }

    .search-trigger:hover {
      border-color: var(--border-hover);
      background: var(--bg-tertiary);
    }

    .search-trigger .material-symbols-outlined { font-size: 16px; }

    .search-trigger .shortcut {
      margin-left: auto;
      display: flex;
      gap: 4px;
    }

    .search-trigger .shortcut kbd {
      font-family: 'Inter', sans-serif;
      font-size: 11px;
      font-weight: 500;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 5px;
      color: var(--text-tertiary);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .header-link {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      transition: color 0.15s, background 0.15s;
    }

    .header-link:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
    }

    .header-link .material-symbols-outlined { font-size: 18px; }

    /* ── Sidebar ── */
    .doc-sidebar {
      position: fixed;
      top: var(--header-h);
      left: 0;
      bottom: 0;
      width: var(--sidebar-w);
      background: var(--bg);
      border-right: 1px solid var(--border);
      overflow-y: auto;
      padding: 16px 12px 32px;
      z-index: 50;
    }

    .doc-sidebar::-webkit-scrollbar { width: 4px; }
    .doc-sidebar::-webkit-scrollbar-track { background: transparent; }
    .doc-sidebar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

    .sidebar-section { margin-bottom: 24px; }

    .sidebar-section-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 0 12px;
      margin-bottom: 6px;
    }

    .sidebar-link {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 450;
      color: var(--text-secondary);
      transition: all 0.12s;
      line-height: 1.4;
    }

    .sidebar-link:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
    }

    .sidebar-link.active {
      color: var(--accent);
      background: var(--accent-bg);
    }

    .sidebar-link .material-symbols-outlined {
      font-size: 18px;
      font-variation-settings: 'FILL' 0, 'wght' 300;
      opacity: 0.7;
    }

    .sidebar-link.active .material-symbols-outlined { opacity: 1; }

    /* ── Main Content ── */
    .doc-main {
      margin-left: var(--sidebar-w);
      margin-top: var(--header-h);
      min-height: calc(100vh - var(--header-h));
    }

    .doc-content {
      max-width: 860px;
      margin: 0 auto;
      padding: 48px 48px 96px;
    }

    /* ── Prose ── */
    .prose h1 {
      font-size: 2.25rem;
      font-weight: 900;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 1.5rem;
      background: linear-gradient(to bottom, #fff 0%, #a0a0a0 100%);
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
      border-bottom: 1px solid var(--border);
    }

    .prose h3 {
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      margin-top: 2rem;
      margin-bottom: 0.75rem;
      color: var(--accent);
    }

    .prose p {
      margin-bottom: 1rem;
      color: var(--text-secondary);
    }

    .prose strong { color: var(--text-primary); font-weight: 600; }

    .prose a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.15s;
    }
    .prose a:hover { border-bottom-color: var(--accent); }

    .prose ul, .prose ol {
      margin-bottom: 1rem;
      padding-left: 1.5rem;
      color: var(--text-secondary);
    }
    .prose li { margin-bottom: 0.35rem; }
    .prose li strong { color: var(--text-primary); }

    .prose code {
      font-family: "JetBrains Mono", monospace;
      font-size: 0.85em;
      background: var(--bg-code);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0.15em 0.4em;
      color: var(--accent);
    }

    .prose pre {
      background: var(--bg-code);
      border: 1px solid var(--border);
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
      border-left: 3px solid var(--accent);
      margin: 1.5rem 0;
      padding: 0.75rem 1.25rem;
      background: var(--accent-bg);
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
      color: var(--accent);
    }

    .prose td {
      padding: 0.65rem 1rem;
      border-bottom: 1px solid var(--border);
      color: var(--text-secondary);
    }

    .prose tr:last-child td { border-bottom: none; }

    .prose hr {
      border: none;
      border-top: 1px solid var(--border);
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
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      text-decoration: none;
      transition: border-color 0.2s, transform 0.15s;
    }
    .doc-card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
    }
    .doc-card h3 {
      color: var(--text-primary);
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    .doc-card p {
      color: var(--text-tertiary);
      font-size: 0.875rem;
      line-height: 1.5;
    }

    /* ── Material Symbols ── */
    .material-symbols-outlined {
      font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24;
    }

    /* ── Scrollbar (global) ── */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--border-hover); }

    /* ── Responsive ── */
    @media (max-width: 900px) {
      .doc-sidebar { display: none; }
      .doc-main { margin-left: 0; }
      .header-left { width: auto; }
    }

    @media (max-width: 600px) {
      .doc-content { padding: 32px 20px 64px; }
      .prose h1 { font-size: 1.75rem; }
      .header-center { display: none; }
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

  return htmlTemplate("Documentation", content, "__index__");
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
    const html = htmlTemplate(title, rendered, slug);

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
