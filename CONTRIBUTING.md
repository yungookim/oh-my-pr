# Contributing to Code Factory

Thanks for your interest in contributing to Code Factory! This document provides guidelines and information for contributors.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies with `npm install`
4. Create a feature branch from `main`
5. Make your changes
6. Run checks before submitting:

```bash
npm run check    # TypeScript typecheck
npm run lint     # ESLint
npm run test     # Tests
```

## Code Style

- **TypeScript strict mode** — no `any` types without justification
- **2-space indentation**, double quotes, semicolons
- **camelCase** for server helper functions
- **kebab-case** for API route paths
- Tests are colocated with source files in `server/` (e.g., `foo.ts` → `foo.test.ts`)

See [AGENTS.md](AGENTS.md) for more detailed repository guidelines and development practices.

## Commit Messages

Use short imperative commit messages with a prefix:

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation changes
- `test:` — adding or updating tests
- `refactor:` — code refactoring without behavior change

## Pull Requests

- Keep PRs focused and narrow — one feature or fix per PR
- Include a clear description of what changed and why
- Make sure CI passes (lint, typecheck, tests)

## Reporting Issues

When reporting bugs, include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
