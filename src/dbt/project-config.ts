import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { DbtProjectConfig } from './manifest-types';

/**
 * Load and parse dbt_project.yml using js-yaml.
 * Returns undefined if the file does not exist or cannot be parsed.
 */
export function loadProjectConfig(projectDir: string): DbtProjectConfig | undefined {
	const configPath = path.join(projectDir, 'dbt_project.yml');
	if (!fs.existsSync(configPath)) {
		return undefined;
	}
	try {
		const raw = fs.readFileSync(configPath, 'utf-8');
		return yaml.load(raw) as DbtProjectConfig;
	} catch {
		return undefined;
	}
}

export function resolveTargetPath(config: DbtProjectConfig | undefined, projectDir: string): string {
	const target = config?.['target-path'] ?? 'target';
	return path.join(projectDir, target);
}

export function resolveModelPaths(config: DbtProjectConfig | undefined, projectDir: string): string[] {
	const dirs = config?.['model-paths'] ?? ['models'];
	return dirs.map(p => path.join(projectDir, p));
}

export function resolveSeedPaths(config: DbtProjectConfig | undefined, projectDir: string): string[] {
	const dirs = config?.['seed-paths'] ?? ['seeds'];
	return dirs.map(p => path.join(projectDir, p));
}

export function resolveMacroPaths(config: DbtProjectConfig | undefined, projectDir: string): string[] {
	const dirs = config?.['macro-paths'] ?? ['macros'];
	return dirs.map(p => path.join(projectDir, p));
}

export function resolveAnalysisPaths(config: DbtProjectConfig | undefined, projectDir: string): string[] {
	const dirs = config?.['analysis-paths'] ?? ['analyses'];
	return dirs.map(p => path.join(projectDir, p));
}

export function resolveSnapshotPaths(config: DbtProjectConfig | undefined, projectDir: string): string[] {
	const dirs = config?.['snapshot-paths'] ?? ['snapshots'];
	return dirs.map(p => path.join(projectDir, p));
}

export function resolveTestPaths(config: DbtProjectConfig | undefined, projectDir: string): string[] {
	const dirs = config?.['test-paths'] ?? ['tests'];
	return dirs.map(p => path.join(projectDir, p));
}

export function resolveFunctionPaths(config: DbtProjectConfig | undefined, projectDir: string): string[] {
	const dirs = config?.['function-paths'] ?? ['functions'];
	return dirs.map(p => path.join(projectDir, p));
}
