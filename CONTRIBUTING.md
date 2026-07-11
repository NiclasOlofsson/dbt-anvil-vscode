# Contributing to dbt Anvil for VS Code

## Development Setup

1. **Install Node.js** (v20+ recommended)

2. **Clone the repository:**
   ```bash
   git clone https://github.com/NiclasOlofsson/dbt-anvil-vscode.git
   cd dbt-anvil
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Open in VS Code and press F5** to launch the Extension Development Host.

## Development Workflow

### Build

```bash
# Single build (development mode, with source maps)
npm run compile

# Watch mode (rebuilds on save)
npm run watch
```

`npm run watch` runs the esbuild watcher only — it rebuilds `dist/` on save. Type errors show inline in the editor (via the TS language server); run `npm run typecheck` before committing, or start `npm run watch:types` for a continuous whole-project check. `npm run watch:lint` runs ESLint on save. Both type and lint watchers are opt-in separate processes.

### Lint

```bash
# Check for lint errors
npm run lint

# Auto-fix lint errors
npm run lint:fix
```

### Type Checking

```bash
npm run typecheck
```

### Tests

```bash
# Run all tests (vitest)
npm test
```

Always run `npm test` directly in the terminal — do not use the vitest task runner or `npx vitest run`.

### Pre-commit Checklist

Before committing:

```bash
npm run lint
npm run typecheck
npm test
```

All three must pass with no errors.

## Release Process

Releases are built and published by the **Release** GitHub Actions workflow, not from a local machine.

1. **Update `CHANGELOG.md`** — add a `## X.Y.Z` section for the version the release will produce; the workflow bumps the current `package.json` version by your chosen patch, minor, or major. Review `git log --oneline` since the last release for reference. The workflow lifts this section into the GitHub release notes, and the Marketplace renders the changelog on the listing.

2. **Trigger the workflow** — GitHub → Actions → Release → Run workflow, and choose the version bump (`patch`, `minor`, `major`, or `none` to publish the version already in `package.json`). The run:
   - re-runs the CI gates (lint, typecheck, full test suite); a release never skips them
   - bumps the version and tags via `npm version`
   - packages the `.vsix` and publishes it to the VS Code Marketplace
   - pushes the version commit + tag back to `main` and creates a GitHub release with the `.vsix` attached

   A failed publish leaves the repository untouched. Fix the problem and re-run.

> **Note:** Publishing requires the `VSCE_PAT` repository secret: an Azure DevOps personal access token with the *Marketplace: Manage* scope for the `nickeolofsson` publisher. Only the maintainer holds this; external contributors open a PR and the maintainer releases.

> **Note:** Publishing passes `--allow-proposed-apis contribLanguageModelToolSets` because the toolset feature is still a proposed VS Code API. The toolset grouping only works in VS Code Insiders; core features (syntax highlighting, model explorer, individual tools) work in stable VS Code.

### Local packaging (testing only)

```bash
npm run package:marketplace
```

Produces a `.vsix` locally without touching the version. Install it via **Extensions: Install from VSIX...** to test a build before releasing.

## Quick Reference

| Command | Description |
|---------|-------------|
| `npm run compile` | One-off development build |
| `npm run watch` | Watch mode (esbuild rebuild-on-save) |
| `npm run watch:types` | Optional continuous `tsc --noEmit` |
| `npm run lint` | Lint with ESLint |
| `npm run lint:fix` | Lint and auto-fix |
| `npm run typecheck` | TypeScript type-check only |
| `npm test` | Run all tests |
| `npm run package:marketplace` | Package a local `.vsix` (no version bump) |
