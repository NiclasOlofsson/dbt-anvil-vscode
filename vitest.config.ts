import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['node_modules', 'dist', 'temp_auto'],
		// The sqllens test files each transform the sibling repo's generated
		// ANTLR parsers (multi-MB per dialect); default worker counts OOM the
		// pool and fail collection with "no tests". Two workers is stable.
		maxWorkers: 2,
		alias: {
			vscode: resolve(import.meta.dirname, './src/test/__mocks__/vscode.ts'),
			// Subpath first: vite alias keys prefix-match in order, so the longer
			// specifier must win before the bare `sqllens` entry rewrites it.
			'sqllens/minijinja': resolve(import.meta.dirname, '../sql-dialect-grammars/src/minijinja/index.ts'),
			sqllens: resolve(import.meta.dirname, '../sql-dialect-grammars/src/index.ts'),
		},
	},
});
