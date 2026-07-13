# Contributing to nexus-oc-plugins

Thank you for your interest in contributing to the Nexus OpenCode plugins.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/nexus-oc-plugins.git`
3. Create a branch: `git checkout -b feature/my-change`

## Requirements

- Node.js >= 22
- TypeScript >= 5.8
- Each plugin is a standalone `.ts` file — no build step required for development

## Development Workflow

```bash
# Install tooling dependencies (typecheck, lint)
npm install

# Type-check all plugins
npm run typecheck

# Lint
npm run lint

# Format check
npm run fmt
```

## Plugin Structure

Each plugin lives in its own numbered directory:

```
<NNN>-<plugin-name>/
  nexus-<plugin-name>.ts   -- plugin source (standalone, no build)
  README.md                -- plugin documentation
```

Plugins are standalone `.ts` files that import from `@opencode-ai/plugin`.
They are loaded directly by OpenCode without a compilation step.

## Adding a New Plugin

1. Create a new directory following the `<NNN>-<name>` convention
2. Implement the plugin as a single `.ts` file exporting a `Plugin` default
3. Write a `README.md` with version header, requirements, and usage
4. Add an entry to the root `README.md` plugin table
5. Add an entry to `CHANGELOG.md`

## Pull Request Guidelines

- Keep PRs focused on a single change
- Ensure `npm run typecheck` and `npm run lint` pass
- Write clear commit messages following [Conventional Commits](https://www.conventionalcommits.org/)
- Update `CHANGELOG.md` under an `[Unreleased]` section

## Reporting Bugs

Open an issue on GitHub with:

- OpenCode version (`opencode --version`)
- Plugin version (from the plugin's `PLUGIN_META.version`)
- Steps to reproduce
- Expected vs. actual behavior

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
