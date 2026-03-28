/**
 * Builds the docs landing page plus standalone HTML pages for Markdown docs in docs/public/.
 *
 * Usage: npx tsx script/build-public-docs.ts
 */

import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

const DOCS_DIR = path.resolve(import.meta.dirname, "../docs/public");
const ROOT_DOCS_INDEX = path.resolve(import.meta.dirname, "../docs/index.html");
const OUT_DIR = path.join(DOCS_DIR, "_site");
const SHARED_STYLESHEET = "styles.css";
const REPO_URL = "https://github.com/yungookim/oh-my-pr";
const COMMUNITY_URL = "https://github.com/yungookim/oh-my-pr/discussions";
const CHANGELOG_URL = "https://github.com/yungookim/oh-my-pr/releases";
const ISSUES_URL = "https://github.com/yungookim/oh-my-pr/issues";
const API_REFERENCE_URL = "https://github.com/yungookim/oh-my-pr/blob/main/LOCAL_API.md";
const CONTRIBUTING_URL = "https://github.com/yungookim/oh-my-pr/blob/main/CONTRIBUTING.md";
const AGENT_CONFIG_URL = "https://github.com/yungookim/oh-my-pr/blob/main/AGENTS.md";

interface DocMeta {
  slug: string;
  title: string;
  description: string;
  htmlFile: string;
}

interface DocDefinition {
  slug: string;
  section: "Getting Started" | "Core Concepts";
  navLabel: string;
  cardTitle: string;
  icon: IconName;
  fallbackDescription: string;
}

type IconName =
  | "logo"
  | "github"
  | "community"
  | "home"
  | "search"
  | "quickstart"
  | "settings"
  | "eye"
  | "package"
  | "chat"
  | "code"
  | "doc"
  | "sliders"
  | "clock"
  | "warning"
  | "source"
  | "info"
  | "plus"
  | "server"
  | "shield";

interface RenderContext {
  kind: "root" | "site";
  stylesheetHref: string;
  introHref: string;
  docsIndexHref: string;
  docHref: (slug: string) => string;
}

interface BottomNav {
  href: string;
  label: string;
  title: string;
}

const DOC_DEFINITIONS: DocDefinition[] = [
  {
    slug: "getting-started",
    section: "Getting Started",
    navLabel: "Quickstart",
    cardTitle: "Quickstart",
    icon: "quickstart",
    fallbackDescription: "Install CodeFactory, connect a repository, and let the agents handle your first PR in minutes.",
  },
  {
    slug: "configuration",
    section: "Getting Started",
    navLabel: "Configuration",
    cardTitle: "Configuration",
    icon: "settings",
    fallbackDescription: "Environment variables, storage options, database setup, and activity logging.",
  },
  {
    slug: "pr-babysitter",
    section: "Core Concepts",
    navLabel: "PR Babysitter",
    cardTitle: "PR Babysitter",
    icon: "eye",
    fallbackDescription: "Autonomous monitoring, review sync, and feedback triage for your pull requests.",
  },
  {
    slug: "agent-dispatch",
    section: "Core Concepts",
    navLabel: "Agent Dispatch",
    cardTitle: "Agent Dispatch",
    icon: "package",
    fallbackDescription: "How CodeFactory dispatches Claude Code and OpenAI Codex agents in isolated worktrees.",
  },
  {
    slug: "pr-questions",
    section: "Core Concepts",
    navLabel: "PR Q&A",
    cardTitle: "PR Q&A",
    icon: "chat",
    fallbackDescription: "Ask natural-language questions about any pull request and get AI-powered answers.",
  },
];

const WORKFLOW_STEPS = [
  {
    number: "1.",
    title: "Watch Repositories",
    description: "Add any GitHub repository. CodeFactory polls for open PRs and new review activity.",
  },
  {
    number: "2.",
    title: "Sync Reviews",
    description: "Review comments, inline feedback, and threaded conversations are captured and stored locally.",
  },
  {
    number: "3.",
    title: "Triage Feedback",
    description: "Feedback is classified into blocking, suggestions, and nitpicks for prioritized action.",
  },
  {
    number: "4.",
    title: "Dispatch Agents",
    description: "Local AI agents work in isolated git worktrees to fix issues without touching your active checkout.",
  },
  {
    number: "5.",
    title: "Resolve Conflicts",
    description: "Automated merge handling keeps agent branches clean before fixes are pushed back upstream.",
  },
  {
    number: "6.",
    title: "Commit & Push",
    description: "Validated fixes are committed and pushed back to the PR branch automatically.",
  },
];

function createContext(kind: "root" | "site"): RenderContext {
  return {
    kind,
    stylesheetHref: kind === "root" ? "./public/styles.css" : "styles.css",
    introHref: kind === "root" ? "./index.html" : "../../index.html",
    docsIndexHref: kind === "root" ? "./public/_site/index.html" : "./index.html",
    docHref: (slug) => (kind === "root" ? `./public/_site/${slug}.html` : `./${slug}.html`),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function icon(name: IconName, className: string): string {
  switch (name) {
    case "logo":
      return `<svg class="${className}" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg>`;
    case "github":
      return `<svg class="${className}" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"></path></svg>`;
    case "community":
      return `<svg class="${className}" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15H9v-2h2v2zm0-4H9V7h2v6z"></path></svg>`;
    case "home":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12l2-2m0 0 7-7 7 7M5 10v10a1 1 0 0 0 1 1h3m10-11 2 2m-2-2v10a1 1 0 0 1-1 1h-3m-6 0a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1m-6 0h6" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "search":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "quickstart":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 10V3L4 14h7v7l9-11h-7z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "settings":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "eye":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "package":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a2 2 0 0 0-2-2M5 11V9a2 2 0 0 1 2-2m0 0V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2M7 7h10" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "chat":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-5l-5 5v-5z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "code":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 20 14 4m4 4 4 4-4 4M6 16l-4-4 4-4" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "doc":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "sliders":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6V4m0 2a2 2 0 1 0 0 4m0-4a2 2 0 1 1 0 4m-6 8a2 2 0 1 0 0-4m0 4a2 2 0 1 1 0-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 1 0 0-4m0 4a2 2 0 1 1 0-4m0 4v2m0-6V4" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "clock":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "warning":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "source":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 20 14 4m4 4 4 4-4 4M6 16l-4-4 4-4" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "info":
      return `<svg class="${className}" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM9 9a1 1 0 0 0 0 2v3a1 1 0 0 0 1 1h1a1 1 0 1 0 0-2v-3a1 1 0 0 0-1-1H9z"></path></svg>`;
    case "plus":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v6m0 0v6m0-6h6m-6 0H6" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "server":
      return `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M5 12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2M5 12a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2m-2-4h.01M17 16h.01" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>`;
    case "shield":
      return `<svg class="${className}" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`;
  }
}

function buildHead(title: string, description: string, stylesheetHref: string): string {
  return `<!DOCTYPE html>
<html class="dark" lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="${escapeHtml(description)}" />
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=Fira+Code:wght@400;500;600&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  <script>
    tailwind.config = {
      darkMode: "class",
      theme: {
        extend: {
          colors: {
            brand: {
              400: "#60a5fa",
              500: "#3b82f6",
              600: "#2563eb",
            },
            dark: {
              900: "#0f1115",
              800: "#1e2128",
              700: "#2c313c",
            }
          },
          fontFamily: {
            sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
            mono: ["Fira Code", "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "Courier New", "monospace"],
          }
        }
      }
    };
  </script>
  <link rel="stylesheet" href="${stylesheetHref}" />
</head>`;
}

function navItemMarkup(label: string, href: string, iconName: IconName, active: boolean, external = false): string {
  const baseClasses = active
    ? "bg-dark-800 text-white"
    : "text-slate-400 hover:bg-dark-800 hover:text-slate-200";
  const target = external ? ` target="_blank" rel="noreferrer"` : "";
  const iconColor = active ? "text-slate-400" : "text-slate-500";

  return `<li>
  <a class="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${baseClasses}" href="${href}"${target}>
    ${icon(iconName, `h-4 w-4 ${iconColor}`)}
    <span>${escapeHtml(label)}</span>
  </a>
</li>`;
}

function renderSidebar(context: RenderContext, activeKey: string | null, docs: DocMeta[]): string {
  const docsBySlug = new Map(docs.map((doc) => [doc.slug, doc]));
  const groupedDocItems = new Map<DocDefinition["section"], string[]>();

  for (const section of ["Getting Started", "Core Concepts"] as const) {
    groupedDocItems.set(section, []);
  }

  for (const definition of DOC_DEFINITIONS) {
    if (!docsBySlug.has(definition.slug)) {
      continue;
    }

    groupedDocItems.get(definition.section)?.push(
      navItemMarkup(
        definition.navLabel,
        context.docHref(definition.slug),
        definition.icon,
        activeKey === definition.slug,
      ),
    );
  }

  return `<aside class="hidden h-screen w-64 flex-shrink-0 flex-col overflow-y-auto border-r border-dark-800 bg-dark-900 md:flex" data-purpose="sidebar">
  <div class="sticky top-0 z-10 border-b border-dark-800 bg-dark-900/95 p-4 backdrop-blur">
    <div class="mb-4 flex items-center gap-2">
      ${icon("logo", "h-6 w-6 text-white")}
      <span class="text-base font-semibold text-white">CodeFactory</span>
      <span class="ml-auto rounded bg-dark-700 px-1.5 py-0.5 text-[10px] text-gray-300">DOCS</span>
    </div>
    <div class="relative mb-4">
      ${icon("search", "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500")}
      <input class="doc-search-input w-full rounded-md border border-dark-700 bg-dark-800 py-1.5 pl-9 pr-3 text-sm text-gray-300 placeholder-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Search documents..." type="text" />
    </div>
    <div class="flex gap-4 text-sm text-gray-400">
      <a class="flex items-center gap-1.5 transition-colors hover:text-gray-200" href="${REPO_URL}" target="_blank" rel="noreferrer">
        ${icon("github", "h-4 w-4")}
        <span>GitHub</span>
      </a>
      <a class="flex items-center gap-1.5 transition-colors hover:text-gray-200" href="${COMMUNITY_URL}" target="_blank" rel="noreferrer">
        ${icon("community", "h-4 w-4")}
        <span>Community</span>
      </a>
    </div>
  </div>

  <nav class="flex-1 space-y-6 px-3 pb-8 pt-6">
    <div>
      <h4 class="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Getting Started</h4>
      <ul class="space-y-0.5">
        ${navItemMarkup("Introduction", context.introHref, "home", activeKey === "intro")}
        ${groupedDocItems.get("Getting Started")?.join("\n") ?? ""}
      </ul>
    </div>

    <div>
      <h4 class="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Core Concepts</h4>
      <ul class="space-y-0.5">
        ${groupedDocItems.get("Core Concepts")?.join("\n") ?? ""}
      </ul>
    </div>

    <div>
      <h4 class="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Guides</h4>
      <ul class="space-y-0.5">
        ${navItemMarkup("Contributing", CONTRIBUTING_URL, "code", false, true)}
        ${navItemMarkup("API Reference", API_REFERENCE_URL, "doc", false, true)}
        ${navItemMarkup("Agent Config", AGENT_CONFIG_URL, "sliders", false, true)}
      </ul>
    </div>

    <div>
      <h4 class="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Resources</h4>
      <ul class="space-y-0.5">
        ${navItemMarkup("Changelog", CHANGELOG_URL, "clock", false, true)}
        ${navItemMarkup("Report an Issue", ISSUES_URL, "warning", false, true)}
        ${navItemMarkup("Source Code", REPO_URL, "source", false, true)}
      </ul>
    </div>
  </nav>
</aside>`;
}

function renderMobileHeader(context: RenderContext): string {
  return `<div class="mb-8 flex items-center justify-between rounded-xl border border-dark-800 bg-dark-800/60 px-4 py-3 md:hidden">
  <a class="flex items-center gap-2 text-white" href="${context.introHref}">
    ${icon("logo", "h-5 w-5")}
    <span class="font-semibold">CodeFactory</span>
  </a>
  <span class="rounded bg-dark-700 px-2 py-1 text-[10px] uppercase tracking-wider text-gray-300">Docs</span>
</div>`;
}

function renderBottomNav(bottomNav?: BottomNav): string {
  if (!bottomNav) {
    return "";
  }

  return `<div class="pointer-events-none sticky bottom-0 left-0 right-0 mx-auto flex w-full max-w-4xl justify-end bg-gradient-to-t from-dark-900 via-dark-900 to-transparent px-6 pb-8 pt-16 sm:px-8">
  <a class="pointer-events-auto flex w-full min-w-[220px] flex-col items-end rounded-lg bg-brand-500 px-6 py-4 text-white shadow-lg shadow-brand-500/20 transition-colors hover:bg-brand-400 sm:w-auto" href="${bottomNav.href}">
    <span class="mb-1 text-xs font-semibold uppercase tracking-wider text-blue-100">${escapeHtml(bottomNav.label)}</span>
    <span class="flex items-center gap-2 text-lg font-medium">
      ${escapeHtml(bottomNav.title)}
      <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5l7 7m0 0-7 7m7-7H3" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>
    </span>
  </a>
</div>`;
}

function renderShell(
  context: RenderContext,
  title: string,
  description: string,
  activeKey: string | null,
  bodyContent: string,
  docs: DocMeta[],
  bottomNav?: BottomNav,
): string {
  return `${buildHead(title, description, context.stylesheetHref)}
<body class="antialiased text-sm">
  <div class="flex min-h-screen overflow-hidden">
    ${renderSidebar(context, activeKey, docs)}
    <main class="relative w-full flex-1 overflow-y-auto" data-purpose="main-content">
      <div class="mx-auto max-w-4xl px-6 py-10 pb-28 sm:px-8 sm:py-12 sm:pb-32">
        ${renderMobileHeader(context)}
        ${bodyContent}
      </div>
      ${renderBottomNav(bottomNav)}
    </main>
  </div>
</body>
</html>`;
}

function getDocMeta(docs: DocMeta[], slug: string): DocMeta | undefined {
  return docs.find((doc) => doc.slug === slug);
}

function getDocDefinition(slug: string): DocDefinition | undefined {
  return DOC_DEFINITIONS.find((definition) => definition.slug === slug);
}

function renderLandingCard(context: RenderContext, docs: DocMeta[], slug: string): string {
  const definition = getDocDefinition(slug);
  const doc = getDocMeta(docs, slug);

  if (!definition || !doc) {
    return "";
  }

  const description = definition.fallbackDescription;

  return `<a class="group block rounded-xl border border-dark-700 bg-dark-800/50 p-6 transition-colors hover:bg-dark-800" href="${context.docHref(doc.slug)}">
  <div class="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-dark-700 text-brand-400 transition-colors group-hover:text-blue-300">
    ${icon(definition.icon, "h-5 w-5")}
  </div>
  <h3 class="mb-2 text-lg font-semibold text-white">${escapeHtml(definition.cardTitle)}</h3>
  <p class="text-sm leading-relaxed text-gray-400">${escapeHtml(description)}</p>
</a>`;
}

function renderLandingPage(context: RenderContext, docs: DocMeta[]): string {
  const getStartedCards = ["getting-started", "configuration", "pr-babysitter", "agent-dispatch"]
    .map((slug) => renderLandingCard(context, docs, slug))
    .filter(Boolean)
    .join("\n");
  const questionsDoc = getDocMeta(docs, "pr-questions");
  const questionsDefinition = getDocDefinition("pr-questions");
  const questionsDescription =
    questionsDefinition?.fallbackDescription ?? questionsDoc?.description ?? "Ask natural-language questions about any pull request and get AI-powered answers.";

  const bodyContent = `<header class="mb-12">
  <div class="mb-6 inline-flex items-center gap-2 rounded-full bg-blue-500/10 px-3 py-1 text-sm font-medium text-blue-400">
    ${icon("plus", "h-4 w-4")}
    <span>Welcome to CodeFactory</span>
  </div>
  <h1 class="mb-6 text-4xl font-bold tracking-tight text-white sm:text-5xl">The Autonomous PR Babysitter</h1>
  <p class="mb-8 max-w-3xl text-lg leading-relaxed text-gray-400">
    CodeFactory watches your GitHub repositories, triages review feedback, and dispatches local AI agents to fix code so you can focus on building instead of babysitting pull requests.
  </p>

  <div class="mb-8 flex flex-wrap gap-3">
    <span class="inline-flex items-center gap-1.5 rounded border border-dark-700 bg-dark-800 px-3 py-1 text-sm text-gray-300">
      ${icon("github", "h-4 w-4 text-gray-500")}
      <span>Open Source (MIT)</span>
    </span>
    <span class="inline-flex items-center gap-1.5 rounded border border-dark-700 bg-dark-800 px-3 py-1 text-sm text-gray-300">
      ${icon("server", "h-4 w-4 text-gray-500")}
      <span>Runs Locally</span>
    </span>
    <span class="inline-flex items-center gap-1.5 rounded border border-dark-700 bg-dark-800 px-3 py-1 text-sm text-gray-300">
      ${icon("quickstart", "h-4 w-4 text-gray-500")}
      <span>Claude Code &amp; OpenAI Codex</span>
    </span>
    <span class="inline-flex items-center gap-1.5 rounded border border-dark-700 bg-dark-800 px-3 py-1 text-sm text-gray-300">
      ${icon("shield", "h-4 w-4 text-green-500")}
      <span>Node.js 22+</span>
    </span>
  </div>

  <div class="flex gap-3 rounded-lg border border-blue-500/20 bg-blue-900/20 p-4">
    ${icon("info", "mt-0.5 h-5 w-5 flex-shrink-0 text-blue-400")}
    <p class="text-sm leading-relaxed text-blue-100/80">
      CodeFactory runs entirely on your machine. Your code never leaves your environment. Get started in under 2 minutes with our
      <a class="text-blue-400 hover:underline" href="${context.docHref("getting-started")}">quickstart guide</a>.
    </p>
  </div>
</header>

<section class="mb-16">
  <h2 class="mb-4 text-2xl font-bold text-white">Get Started</h2>
  <p class="mb-6 text-gray-400">Everything you need to set up CodeFactory and start automating your PR workflow.</p>
  <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
    ${getStartedCards}
  </div>
</section>

<section class="mb-16">
  <h2 class="mb-4 text-2xl font-bold text-white">Installation</h2>
  <div class="overflow-hidden rounded-xl border border-dark-700 bg-dark-800">
    <div class="flex items-center gap-2 border-b border-dark-700 bg-dark-800 px-4 py-2">
      <div class="flex gap-1.5">
        <div class="h-3 w-3 rounded-full bg-dark-700"></div>
        <div class="h-3 w-3 rounded-full bg-dark-700"></div>
        <div class="h-3 w-3 rounded-full bg-dark-700"></div>
      </div>
    </div>
    <div class="overflow-x-auto p-6">
      <pre class="font-mono text-sm leading-relaxed text-gray-300"><code><span class="text-gray-500"># Clone and install</span>
<span class="text-white">git clone https://github.com/yungookim/oh-my-pr.git</span>
<span class="text-white">cd codefactory</span>
<span class="text-white">npm install</span>

<span class="text-gray-500"># Start the dashboard</span>
<span class="text-white">npm run dev</span></code></pre>
    </div>
  </div>
</section>

<section class="mb-16">
  <h2 class="mb-4 text-2xl font-bold text-white">How It Works</h2>
  <p class="mb-8 text-gray-400">CodeFactory follows a six-step autonomous workflow to handle PR feedback end-to-end.</p>
  <div class="space-y-0">
    ${WORKFLOW_STEPS.map(
      (step) => `<div class="flex gap-6 border-b border-dark-700/50 py-6">
      <div class="w-8 flex-shrink-0 text-3xl font-bold text-blue-500/50">${step.number}</div>
      <div>
        <h3 class="mb-1 text-lg font-semibold text-white">${escapeHtml(step.title)}</h3>
        <p class="text-gray-400">${escapeHtml(step.description)}</p>
      </div>
    </div>`,
    ).join("\n")}
  </div>
</section>

<section class="mb-8">
  <h2 class="mb-4 text-2xl font-bold text-white">Explore</h2>
  <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
    <a class="group block rounded-xl border border-dark-700 bg-dark-800/50 p-6 transition-colors hover:bg-dark-800" href="${context.docHref("pr-questions")}">
      <div class="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-dark-700 text-brand-400 transition-colors group-hover:text-blue-300">
        ${icon("chat", "h-5 w-5")}
      </div>
      <h3 class="mb-2 text-lg font-semibold text-white">${escapeHtml(questionsDefinition?.cardTitle ?? "PR Q&A")}</h3>
      <p class="text-sm leading-relaxed text-gray-400">${escapeHtml(questionsDescription)}</p>
    </a>

    <a class="group block rounded-xl border border-dark-700 bg-dark-800/50 p-6 transition-colors hover:bg-dark-800" href="${API_REFERENCE_URL}" target="_blank" rel="noreferrer">
      <div class="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-dark-700 text-brand-400 transition-colors group-hover:text-blue-300">
        ${icon("doc", "h-5 w-5")}
      </div>
      <h3 class="mb-2 text-lg font-semibold text-white">API Reference</h3>
      <p class="text-sm leading-relaxed text-gray-400">Full REST API documentation for programmatic control of CodeFactory.</p>
    </a>
  </div>
</section>`;

  return renderShell(
    context,
    "CodeFactory Documentation",
    "CodeFactory documentation for the autonomous PR babysitter that watches repositories, triages review feedback, and dispatches local AI agents to fix code.",
    "intro",
    bodyContent,
    docs,
    {
      href: context.docHref("getting-started"),
      label: "Next",
      title: "Quickstart Guide",
    },
  );
}

function stripLeadingTitleAndDescription(html: string): string {
  let content = html.replace(/^\s*<h1[^>]*>.*?<\/h1>\s*/is, "");
  content = content.replace(/^\s*<p>.*?<\/p>\s*/is, "");
  return content;
}

function renderDocPage(context: RenderContext, doc: DocMeta, docs: DocMeta[], renderedHtml: string): string {
  const bodyContent = `<header class="mb-12 border-b border-dark-800/60 pb-8">
  <a class="mb-6 inline-flex items-center gap-2 text-sm text-gray-400 transition-colors hover:text-gray-200" href="${context.docsIndexHref}">
    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 19l-7-7 7-7" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path></svg>
    <span>All docs</span>
  </a>
  <div class="mb-5 inline-flex items-center gap-2 rounded-full bg-blue-500/10 px-3 py-1 text-sm font-medium text-blue-400">
    ${icon("doc", "h-4 w-4")}
    <span>Documentation</span>
  </div>
  <h1 class="text-4xl font-bold tracking-tight text-white sm:text-5xl">${escapeHtml(doc.title)}</h1>
  <p class="mt-4 max-w-3xl text-lg leading-relaxed text-gray-400">${escapeHtml(doc.description)}</p>
</header>

<article class="doc-prose">
  ${stripLeadingTitleAndDescription(renderedHtml)}
</article>`;

  const orderedDocs = DOC_DEFINITIONS.map((definition) => definition.slug).filter((slug) =>
    docs.some((entry) => entry.slug === slug),
  );
  const currentIndex = orderedDocs.indexOf(doc.slug);
  const nextSlug = currentIndex >= 0 ? orderedDocs[currentIndex + 1] : undefined;
  const nextDoc = nextSlug ? getDocMeta(docs, nextSlug) : undefined;
  const bottomNav =
    nextDoc && getDocDefinition(nextDoc.slug)
      ? {
          href: context.docHref(nextDoc.slug),
          label: "Next",
          title: getDocDefinition(nextDoc.slug)?.cardTitle ?? nextDoc.title,
        }
      : {
          href: context.introHref,
          label: "Overview",
          title: "Documentation Overview",
        };

  return renderShell(
    context,
    `${doc.title} | CodeFactory Docs`,
    `${doc.title} - CodeFactory documentation`,
    doc.slug,
    bodyContent,
    docs,
    bottomNav,
  );
}

function extractMeta(markdown: string, filename: string): { title: string; description: string } {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : filename.replace(/\.md$/, "");

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
    if (trimmed === "") {
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith("```") || trimmed.startsWith("|") || trimmed.startsWith("-")) {
      break;
    }
    description = trimmed;
    break;
  }

  return { title, description };
}

function rewriteLinks(html: string): string {
  return html.replace(/href="\.\/([^"]+)\.md"/g, 'href="./$1.html"');
}

async function main() {
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(path.join(DOCS_DIR, SHARED_STYLESHEET), path.join(OUT_DIR, SHARED_STYLESHEET));

  const files = fs.readdirSync(DOCS_DIR).filter((file) => file.endsWith(".md"));

  if (files.length === 0) {
    console.log("No markdown files found in docs/public/");
    return;
  }

  const preferredOrder = DOC_DEFINITIONS.map((definition) => `${definition.slug}.md`);
  const orderedFiles = [
    ...preferredOrder.filter((file) => files.includes(file)),
    ...files.filter((file) => !preferredOrder.includes(file)).sort(),
  ];

  const docs: DocMeta[] = [];
  const renderedDocs = new Map<string, string>();

  for (const file of orderedFiles) {
    const markdown = fs.readFileSync(path.join(DOCS_DIR, file), "utf-8");
    const { title, description } = extractMeta(markdown, file);
    const slug = file.replace(/\.md$/, "");
    const htmlFile = `${slug}.html`;
    const definition = getDocDefinition(slug);

    docs.push({
      slug,
      title,
      description: description || definition?.fallbackDescription || title,
      htmlFile,
    });

    renderedDocs.set(slug, rewriteLinks(await marked.parse(markdown)));
  }

  const siteContext = createContext("site");
  const rootContext = createContext("root");

  for (const doc of docs) {
    const rendered = renderedDocs.get(doc.slug);
    if (!rendered) {
      continue;
    }

    fs.writeFileSync(path.join(OUT_DIR, doc.htmlFile), renderDocPage(siteContext, doc, docs, rendered));
    console.log(`  ✓ ${doc.slug}.md -> ${doc.htmlFile}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, "index.html"), renderLandingPage(siteContext, docs));
  fs.writeFileSync(ROOT_DOCS_INDEX, renderLandingPage(rootContext, docs));

  console.log(`  ✓ _site/index.html`);
  console.log(`  ✓ docs/index.html`);
  console.log(`\nBuilt ${docs.length} docs -> ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("Failed to build public docs:", err);
  process.exit(1);
});
