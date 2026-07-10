import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		globalSetup: './src/test/global-setup.ts',
		include: ['src/**/*.test.ts'],
		exclude: ['node_modules', 'dist', 'temp_auto'],
		// sqllens ships multi-MB generated ANTLR parsers per dialect; default
		// worker counts OOM the pool and fail collection with "no tests".
		// Two workers is stable.
		maxWorkers: 2,
		alias: {
			vscode: resolve(import.meta.dirname, './src/test/__mocks__/vscode.ts'),
		},
	},
});
