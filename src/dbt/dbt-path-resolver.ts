import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DbtProjectConfig } from './manifest-types';
import {
	resolveModelPaths,
	resolveSeedPaths,
	resolveMacroPaths,
	resolveAnalysisPaths,
	resolveSnapshotPaths,
	resolveTestPaths,
} from './project-config';

export type DbtFileCategory = 'model' | 'seed' | 'analysis' | 'snapshot' | 'test' | 'macro' | 'unknown';

export interface ResolvedPaths {
	model: string[];
	seed: string[];
	analysis: string[];
	snapshot: string[];
	test: string[];
	macro: string[];
}

export class DbtPathResolver {
	private _paths: ResolvedPaths = { model: [], seed: [], analysis: [], snapshot: [], test: [], macro: [] };
	private readonly _onPathsChanged = new vscode.EventEmitter<ResolvedPaths>();
	readonly onPathsChanged = this._onPathsChanged.event;

	constructor(
		private readonly _projectDir: string,
	) {}

	get paths(): ResolvedPaths {
		return this._paths;
	}

	refresh(config: DbtProjectConfig | undefined): void {
		const next: ResolvedPaths = {
			model: resolveModelPaths(config, this._projectDir),
			seed: resolveSeedPaths(config, this._projectDir),
			analysis: resolveAnalysisPaths(config, this._projectDir),
			snapshot: resolveSnapshotPaths(config, this._projectDir),
			test: resolveTestPaths(config, this._projectDir),
			macro: resolveMacroPaths(config, this._projectDir),
		};

		const changed = (Object.keys(next) as (keyof ResolvedPaths)[]).some(
			k => next[k].join('\0') !== this._paths[k].join('\0'),
		);

		this._paths = next;
		if (changed) {
			this._onPathsChanged.fire(next);
		}
	}

	classifyFile(filePath: string): DbtFileCategory {
		const normalised = path.normalize(filePath);
		// Order matters: more specific paths first. analysis before model because
		// analysis-paths could theoretically be a subdirectory of model-paths.
		const checks: [DbtFileCategory, string[]][] = [
			['analysis', this._paths.analysis],
			['snapshot', this._paths.snapshot],
			['test', this._paths.test],
			['macro', this._paths.macro],
			['seed', this._paths.seed],
			['model', this._paths.model],
		];
		for (const [category, dirs] of checks) {
			for (const dir of dirs) {
				const normDir = path.normalize(dir);
				if (normalised.startsWith(normDir + path.sep) || normalised === normDir) {
					return category;
				}
			}
		}
		return 'unknown';
	}

	buildSqlSelector(): vscode.DocumentFilter[] {
		const allDirs = [
			...this._paths.model,
			...this._paths.seed,
			...this._paths.analysis,
			...this._paths.snapshot,
			...this._paths.test,
			...this._paths.macro,
		];
		return allDirs.map(dir => ({
			language: 'jinja-sql' as const,
			pattern: new vscode.RelativePattern(dir, '**/*.sql'),
		}));
	}

	buildModelSelector(): vscode.DocumentFilter[] {
		return [...this._paths.model, ...this._paths.snapshot, ...this._paths.seed].map(dir => ({
			language: 'jinja-sql' as const,
			pattern: new vscode.RelativePattern(dir, '**/*.sql'),
		}));
	}

	buildAnalysisSelector(): vscode.DocumentFilter[] {
		return this._paths.analysis.map(dir => ({
			language: 'jinja-sql' as const,
			pattern: new vscode.RelativePattern(dir, '**/*.sql'),
		}));
	}

	buildMacroSelector(): vscode.DocumentFilter[] {
		return this._paths.macro.map(dir => ({
			language: 'jinja-sql' as const,
			pattern: new vscode.RelativePattern(dir, '**/*.sql'),
		}));
	}

	buildTestSelector(): vscode.DocumentFilter[] {
		return this._paths.test.map(dir => ({
			language: 'jinja-sql' as const,
			pattern: new vscode.RelativePattern(dir, '**/*.sql'),
		}));
	}

	buildYamlSelector(): vscode.DocumentFilter[] {
		const allDirs = [
			...this._paths.model,
			...this._paths.seed,
			...this._paths.analysis,
			...this._paths.snapshot,
			...this._paths.test,
			...this._paths.macro,
		];
		const filters: vscode.DocumentFilter[] = [];
		for (const dir of allDirs) {
			filters.push(
				{ language: 'yaml', pattern: new vscode.RelativePattern(dir, '**/*.{yml,yaml}') },
				{ language: 'jinja-yaml', pattern: new vscode.RelativePattern(dir, '**/*.{yml,yaml}') },
			);
		}
		// Also include dbt_project.yml at project root
		filters.push(
			{ language: 'yaml', pattern: new vscode.RelativePattern(this._projectDir, 'dbt_project.yml') },
			{ language: 'jinja-yaml', pattern: new vscode.RelativePattern(this._projectDir, 'dbt_project.yml') },
		);
		return filters;
	}
}
