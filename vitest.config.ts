import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['node_modules', 'dist', 'temp_auto'],
		alias: {
			vscode: resolve(import.meta.dirname, './src/test/__mocks__/vscode.ts'),
		},
	},
});
