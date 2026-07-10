import typescriptEslint from '@typescript-eslint/eslint-plugin';
import stylisticEslint from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import jsdocEslint from 'eslint-plugin-jsdoc';

export default [
	{
		ignores: [
			'dist/**',
			'out/**',
			'node_modules/**',
			'temp_auto/**',
			'**/*.d.ts',
			'.vscode/**',
			'media/**',
			'resources/**',
			'src/fixtures/**',
		],
	},
	{
		files: ['src/**/*.ts'],
		ignores: ['**/*.test.ts', '**/test/**/*.ts', '**/__mocks__/**'],
		plugins: {
			'@typescript-eslint': typescriptEslint,
			'@stylistic': stylisticEslint,
			'import-x': importX,
			jsdoc: jsdocEslint,
		},
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: 'module',
			},
		},
		settings: {
			'import-x/resolver-next': [
				createTypeScriptImportResolver({ alwaysTryTypes: true }),
			],
		},
		rules: {
			// TypeScript rules
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/naming-convention': [
				'error',
				{
					selector: 'interface',
					format: ['PascalCase'],
				},
				{
					selector: 'class',
					format: ['PascalCase'],
				},
				{
					selector: 'enum',
					format: ['PascalCase'],
				},
			],

			// Stylistic rules
			'@stylistic/indent': ['error', 'tab'],
			'@stylistic/quotes': ['error', 'single'],
			'@stylistic/semi': ['error', 'always'],
			'@stylistic/comma-dangle': ['error', 'always-multiline'],
			'@stylistic/no-trailing-spaces': 'error',
			'@stylistic/eol-last': 'error',

			// Import rules
			'import-x/no-unresolved': 'error',
			'import-x/no-duplicates': 'error',

			// JsDoc rules
			'jsdoc/no-types': 'error',

			// General
			'no-console': 'warn',
			eqeqeq: ['error', 'always'],
		},
	},
	{
		files: ['**/*.test.ts', '**/test/**/*.ts', '**/__mocks__/**/*.ts'],
		plugins: {
			'@typescript-eslint': typescriptEslint,
			'@stylistic': stylisticEslint,
		},
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: 'module',
			},
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'no-unused-expressions': 'off',
			'@stylistic/indent': ['error', 'tab'],
			'@stylistic/quotes': ['error', 'single'],
			'@stylistic/semi': ['error', 'always'],
		},
	},
];
