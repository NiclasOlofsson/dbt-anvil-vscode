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
	plugins: [vscodeExternalPlugin],
	external: ['vscode'],
};

async function main(): Promise<void> {
	const extensionContext = await esbuild.context({
		...commonOptions,
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		sourcemap: isDev,
		minify: !isDev,
	});

	if (isWatch) {
		await extensionContext.watch();
		process.on('SIGINT', async () => {
			await extensionContext.dispose();
			process.exit(0);
		});
	} else {
		await extensionContext.rebuild();
		await extensionContext.dispose();
	}
}

main().catch((err: unknown) => {
	console.error('Build failed:', err);
	process.exit(1);
});
