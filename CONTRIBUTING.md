# Contributing to dbt Anvil for VS Code

## Development Setup

1. **Install Node.js** (v20+ recommended)

2. **Clone the repository:**
   ```bash
   git clone https://github.com/NiclasOlofsson/dbt-anvil-vscode.git
   cd dbt-anvil-vscode
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

# Single file
npx vitest run src/path/to/file.test.ts

# Filter by test name
npx vitest run -t "test name pattern"
```

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

   A `minor` bump skips a version: 1.2.0 goes to 1.4.0, not 1.3.0. Odd minors belong to the pre-release channel (below), and the Marketplace rejects a version that has already gone out on the other channel. `patch` and `major` land on an even minor anyway.

> **Note:** Publishing requires the `VSCE_PAT` repository secret: an Azure DevOps personal access token with the *Marketplace: Manage* scope for the `nickeolofsson` publisher. Only the maintainer holds this; external contributors open a PR and the maintainer releases. Both workflows use it.

> **Note:** Publishing passes `--allow-proposed-apis contribLanguageModelToolSets` because the toolset feature is still a proposed VS Code API. The toolset grouping only works in VS Code Insiders; core features (syntax highlighting, model explorer, individual tools) work in stable VS Code.

### Pre-releases

The **Pre-release** workflow publishes a pre-release build of `main` to the Marketplace every day at 04:00 UTC. Users get it by clicking *Switch to Pre-Release Version* on the extension page.

It skips the run when `main` has not moved since the last successful pre-release, so a quiet week publishes nothing. You can also run it by hand from GitHub → Actions → Pre-release → Run workflow; the same skip check applies unless you tick **force**.

Versions follow the Marketplace convention of even minors for the stable channel and odd minors for pre-release. `main` always sits on an even minor, so a pre-release is `major.(minor+1).<run number>`: at 1.2.0 the daily builds go out as 1.3.1, 1.3.2, and so on. The version is set inside the workflow and never committed, so `main` stays on whatever the last release left there.

Pre-releases get no tag, no GitHub release, and no `CHANGELOG.md` section. The packaged `.vsix` carries the changelog as it stands on `main`, so the Marketplace shows notes through the last stable release. Write changelog entries when you cut a release, not per build.

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
| `npm run watch:lint` | Optional ESLint on save |
| `npm run lint` | Lint with ESLint |
| `npm run lint:fix` | Lint and auto-fix |
| `npm run typecheck` | TypeScript type-check only |
| `npm test` | Run all tests |
| `npm run package:marketplace` | Package a local `.vsix` (no version bump) |
