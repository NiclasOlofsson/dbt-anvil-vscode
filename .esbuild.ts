import * as esbuild from 'esbuild';
import { resolve } from 'node:path';

const isDev = process.argv.includes('--dev');
const isWatch = process.argv.includes('--watch');

/** Anchor every path to THIS FILE's directory, not process.cwd() — esbuild
 *  resolves relative entry points, outfiles, and alias targets against the
 *  working directory, so a build invoked from anywhere else (VS Code task,
 *  packaging pipeline, another agent's tooling) silently breaks otherwise.
 *  `__dirname`, not `import.meta.dirname`: tsx compiles this file as CJS. */
const here = (p: string): string => resolve(__dirname, p);

/** Mark the `vscode` module as external so esbuild doesn't bundle it. */
const vscodeExternalPlugin: esbuild.Plugin = {
	name: 'vscode-external',
	setup(build) {
		build.onResolve({ filter: /^vscode$/ }, () => ({
			path: 'vscode',
			external: true,
		}));
	},
};

const commonOptions: esbuild.BuildOptions = {
	bundle: true,
	platform: 'node',
	target: 'node18',
	format: 'cjs',
	keepNames: true,
	// Prefer ESM entries: some deps (e.g. jsonc-parser) ship a UMD `main` that
	// wraps `require()` in a factory arg, which esbuild can't statically follow
	// and leaves as a runtime require that fails at load time.
	mainFields: ['module', 'main'],
	plugins: [vscodeExternalPlugin],
	external: ['vscode', '@duckdb/*', '*.node'],
};

async function main(): Promise<void> {
	const extensionContext = await esbuild.context({
		...commonOptions,
		entryPoints: [here('src/extension.ts')],
		outfile: here('dist/extension.js'),
		sourcemap: isDev,
		minify: !isDev,
	});

	// MCP stdio proxy — spawned by Claude Code as a subprocess. Intentionally
	// self-contained (no externals, no vscode) so it works outside the
	// extension host where the vscode module is unavailable.
	const mcpProxyContext = await esbuild.context({
		bundle: true,
		platform: 'node',
		target: 'node18',
		format: 'cjs',
		keepNames: true,
		entryPoints: [here('src/mcp/proxy/index.ts')],
		outfile: here('dist/mcp-proxy.js'),
		sourcemap: isDev,
		minify: !isDev,
	});

	if (isWatch) {
		await extensionContext.watch();
		await mcpProxyContext.watch();
		process.on('SIGINT', async () => {
			await extensionContext.dispose();
			await mcpProxyContext.dispose();
			process.exit(0);
		});
	} else {
		await extensionContext.rebuild();
		await extensionContext.dispose();
		await mcpProxyContext.rebuild();
		await mcpProxyContext.dispose();
	}
}

main().catch((err: unknown) => {
	console.error('Build failed:', err);
	process.exit(1);
});
