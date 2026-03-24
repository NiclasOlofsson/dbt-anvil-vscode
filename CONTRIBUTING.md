# Contributing to dbt Studio for VS Code

## Development Setup

1. **Install Node.js** (v20+ recommended)

2. **Clone the repository:**
   ```bash
   git clone https://github.com/NiclasOlofsson/dbt-studio-vscode.git
   cd dbt-studio-vscode
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

# Watch mode (rebuilds on save + type-checks + lints continuously)
npm run watch
```

`npm run watch` runs three parallel watchers: esbuild, TypeScript type-checking, and ESLint. This is the normal working mode during active development.

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

### Package (without publishing)

```bash
npm run package:marketplace
```

This bumps the patch version and produces a `.vsix` file locally. Useful for manual testing before publishing.

### Publish

> **Note:** Publishing is restricted to the maintainer (`nickeolofsson`). External contributors should open a PR — the maintainer handles releases.

```bash
npm run publish:marketplace
```

This bumps the patch version and publishes directly to the VS Code Marketplace. Requires marketplace publisher access and a valid `vsce` token (`npx vsce login nickeolofsson`).

> **Note:** Both commands pass `--allow-proposed-apis contribLanguageModelToolSets` because the toolset feature is still a proposed VS Code API. This means the toolset grouping only works in VS Code Insiders; core features (syntax highlighting, model explorer, individual tools) work in stable VS Code.

After publishing, commit the version bump:

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to x.x.x"
git push
```

## Quick Reference

| Command | Description |
|---------|-------------|
| `npm run compile` | One-off development build |
| `npm run watch` | Watch mode (build + typecheck + lint) |
| `npm run lint` | Lint with ESLint |
| `npm run lint:fix` | Lint and auto-fix |
| `npm run typecheck` | TypeScript type-check only |
| `npm test` | Run all tests |
| `npm run package:marketplace` | Bump version + package `.vsix` |
| `npm run publish:marketplace` | Bump version + publish to Marketplace |
