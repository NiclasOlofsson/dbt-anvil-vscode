import * as esbuild from 'esbuild';

const isDev = process.argv.includes('--dev');
const isWatch = process.argv.includes('--watch');

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
	external: ['vscode', '@duckdb/*', '*.node', 'pyodide'],
	// sqllens is consumed as TS source from the sibling repo (no build/emit there).
	// Its src/generated/ (ANTLR output) is gitignored — run `npm run gen` in
	// ../sql-dialect-grammars before building here.
	alias: { sqllens: '../sql-dialect-grammars/src/index.ts' },
};

async function main(): Promise<void> {
	const extensionContext = await esbuild.context({
		...commonOptions,
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		sourcemap: isDev,
		minify: !isDev,
	});

	const workerContext = await esbuild.context({
		...commonOptions,
		entryPoints: ['src/ftl/pyodide-worker.ts'],
		outfile: 'dist/pyodide-worker.js',
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
		entryPoints: ['src/mcp/proxy/index.ts'],
		outfile: 'dist/mcp-proxy.js',
		sourcemap: isDev,
		minify: !isDev,
	});

	if (isWatch) {
		await extensionContext.watch();
		await workerContext.watch();
		await mcpProxyContext.watch();
		process.on('SIGINT', async () => {
			await extensionContext.dispose();
			await workerContext.dispose();
			await mcpProxyContext.dispose();
			process.exit(0);
		});
	} else {
		await extensionContext.rebuild();
		await extensionContext.dispose();
		await workerContext.rebuild();
		await workerContext.dispose();
		await mcpProxyContext.rebuild();
		await mcpProxyContext.dispose();
	}
}

main().catch((err: unknown) => {
	console.error('Build failed:', err);
	process.exit(1);
});
