import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import type { ILogger } from '../types/logger';
import {
	loadProjectConfig,
	resolveAnalysisPaths,
	resolveMacroPaths,
	resolveModelPaths,
	resolveSeedPaths,
	resolveSnapshotPaths,
	resolveTargetPath,
	resolveTestPaths,
} from './project-config';
import type { DbtProjectConfig } from './manifest-types';

// ---------------------------------------------------------------------------
// Connection types (canonical home — not in the database provider layer)
// ---------------------------------------------------------------------------

/** Connection details extracted from a dbt profile target. */
export interface ProfileConnection {
	type: string;
	[key: string]: unknown;
}

/** Databricks-specific connection fields from profiles.yml. */
export interface DatabricksConnection extends ProfileConnection {
	type: 'databricks';
	host: string;
	http_path: string;
	token: string;
	catalog?: string;
	schema?: string;
}

/** DuckDB-specific connection fields from profiles.yml. */
export interface DuckdbConnection extends ProfileConnection {
	type: 'duckdb';
	path: string;
	schema?: string;
}

// ---------------------------------------------------------------------------
// DbtProjectService
// ---------------------------------------------------------------------------

/**
 * Single authoritative service for dbt_project.yml and profiles.yml.
 *
 * Owns:
 *  - All project path resolution (model-paths, target-path, etc.)
 *  - Profile name (from dbt_project.yml `profile:` field)
 *  - Profiles directory resolution (DBT_PROFILES_DIR env var > project-local > ~/.dbt)
 *  - Active connection config (parsed + env_var interpolated, synchronously)
 *  - Adapter type (from active connection — available before manifest exists)
 *  - File watchers for both dbt_project.yml and profiles.yml
 */
export class DbtProjectService {
	private _projectConfig: DbtProjectConfig | undefined;
	private _profilesDir: string;
	private _activeConnection: ProfileConnection | undefined;
	private _projectWatcher: vscode.FileSystemWatcher | null = null;
	private _profilesWatcher: vscode.FileSystemWatcher | null = null;
	private readonly _onProjectChanged = new vscode.EventEmitter<void>();
	private readonly _onConnectionChanged = new vscode.EventEmitter<void>();

	readonly onProjectChanged = this._onProjectChanged.event;
	readonly onConnectionChanged = this._onConnectionChanged.event;

	constructor(
		readonly projectDir: string,
		private readonly logger: ILogger,
	) {
		this._projectConfig = loadProjectConfig(projectDir);
		this._profilesDir = this._resolveProfilesDir();
		this._activeConnection = this._loadConnection();
	}

	// ---- Project paths ------------------------------------------------

	get projectConfig(): DbtProjectConfig | undefined {
		return this._projectConfig;
	}

	get targetPath(): string {
		return resolveTargetPath(this._projectConfig, this.projectDir);
	}

	get modelPaths(): string[] {
		return resolveModelPaths(this._projectConfig, this.projectDir);
	}

	get seedPaths(): string[] {
		return resolveSeedPaths(this._projectConfig, this.projectDir);
	}

	get macroPaths(): string[] {
		return resolveMacroPaths(this._projectConfig, this.projectDir);
	}

	get analysisPaths(): string[] {
		return resolveAnalysisPaths(this._projectConfig, this.projectDir);
	}

	get snapshotPaths(): string[] {
		return resolveSnapshotPaths(this._projectConfig, this.projectDir);
	}

	get testPaths(): string[] {
		return resolveTestPaths(this._projectConfig, this.projectDir);
	}

	// ---- Profile ---------------------------------------------------

	/** Profile name from dbt_project.yml `profile:`, defaulting to `'default'`. */
	get profileName(): string {
		return this._projectConfig?.profile ?? 'default';
	}

	/** Resolved profiles directory. */
	get profilesDir(): string {
		return this._profilesDir;
	}

	/** Active connection config from profiles.yml, or undefined if unresolvable. */
	get activeConnection(): ProfileConnection | undefined {
		return this._activeConnection;
	}

	/** Adapter type from the active connection (pre-manifest fallback). */
	get adapterType(): string | undefined {
		return typeof this._activeConnection?.type === 'string'
			? this._activeConnection.type.toLowerCase()
			: undefined;
	}

	/** All configured target names for the active profile (groundwork for target-picker UI). */
	allTargets(): string[] {
		const filePath = path.join(this._profilesDir, 'profiles.yml');
		const doc = this._parseProfilesFile(filePath);
		if (!doc) return [];
		const profile = doc[this.profileName];
		if (!isRecord(profile)) return [];
		const outputs = profile['outputs'];
		if (!isRecord(outputs)) return [];
		return Object.keys(outputs);
	}

	// ---- Lifecycle -------------------------------------------------

	/**
	 * Re-read both dbt_project.yml and profiles.yml from disk.
	 * Call when either file changes.
	 */
	reload(): void {
		this._projectConfig = loadProjectConfig(this.projectDir);
		this._profilesDir = this._resolveProfilesDir();
		this._activeConnection = this._loadConnection();
	}

	/**
	 * Start file watchers for dbt_project.yml and profiles.yml.
	 * Fires `onProjectChanged` when dbt_project.yml changes.
	 * Fires `onConnectionChanged` when profiles.yml changes and the active connection differs.
	 */
	startWatching(): void {
		const projectPattern = new vscode.RelativePattern(this.projectDir, 'dbt_project.yml');
		this._projectWatcher = vscode.workspace.createFileSystemWatcher(projectPattern);
		this._projectWatcher.onDidChange(() => {
			this.reload();
			this._onProjectChanged.fire();
		});
		this._startProfilesWatcher();
	}

	/**
	 * @deprecated Use `startWatching()` + `onProjectChanged` / `onConnectionChanged` instead.
	 */
	watch(onProjectChanged: () => void, onConnectionChanged: () => void): void {
		const projectPattern = new vscode.RelativePattern(this.projectDir, 'dbt_project.yml');
		this._projectWatcher = vscode.workspace.createFileSystemWatcher(projectPattern);
		this._projectWatcher.onDidChange(() => {
			this.reload();
			onProjectChanged();
		});
		this._startProfilesWatcher(onConnectionChanged);
	}

	dispose(): void {
		this._projectWatcher?.dispose();
		this._projectWatcher = null;
		this._profilesWatcher?.dispose();
		this._profilesWatcher = null;
		this._onProjectChanged.dispose();
		this._onConnectionChanged.dispose();
	}

	// ---- Private helpers -------------------------------------------

	/**
	 * Resolve the profiles directory using the same precedence as dbt:
	 *  1. DBT_PROFILES_DIR environment variable
	 *  2. Project-local profiles.yml
	 *  3. ~/.dbt
	 */
	private _resolveProfilesDir(): string {
		const envDir = process.env['DBT_PROFILES_DIR'];
		if (envDir) return envDir;
		if (fs.existsSync(path.join(this.projectDir, 'profiles.yml'))) return this.projectDir;
		return path.join(os.homedir(), '.dbt');
	}

	private _loadConnection(): ProfileConnection | undefined {
		const filePath = path.join(this._profilesDir, 'profiles.yml');
		const doc = this._parseProfilesFile(filePath);
		if (!doc) return undefined;

		const profile = doc[this.profileName];
		if (!isRecord(profile)) return undefined;

		const outputs = profile['outputs'];
		if (!isRecord(outputs)) return undefined;

		const targetName = typeof profile['target'] === 'string'
			? profile['target']
			: Object.keys(outputs)[0];
		if (!targetName) return undefined;

		const target = outputs[targetName];
		if (!isRecord(target)) return undefined;

		return target as ProfileConnection;
	}

	private _parseProfilesFile(filePath: string): Record<string, unknown> | undefined {
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, 'utf-8');
		} catch {
			return undefined;
		}
		const interpolated = interpolateEnvVars(raw);
		try {
			const doc = yaml.load(interpolated);
			return isRecord(doc) ? doc : undefined;
		} catch {
			return undefined;
		}
	}

	private _startProfilesWatcher(onConnectionChanged?: () => void): void {
		this._profilesWatcher?.dispose();
		const profilesFilePath = path.join(this._profilesDir, 'profiles.yml');
		const pattern = new vscode.RelativePattern(this._profilesDir, 'profiles.yml');
		this._profilesWatcher = vscode.workspace.createFileSystemWatcher(pattern);
		const handler = () => {
			const prev = JSON.stringify(this._activeConnection);
			this._activeConnection = this._loadConnection();
			const next = JSON.stringify(this._activeConnection);
			if (prev !== next) {
				this.logger.info(`[DbtProjectService] profiles.yml changed, connection updated (${profilesFilePath})`);
				onConnectionChanged?.();
				this._onConnectionChanged.fire();
			}
		};
		this._profilesWatcher.onDidChange(handler);
		this._profilesWatcher.onDidCreate(handler);
		this._profilesWatcher.onDidDelete(handler);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Interpolate {{ env_var('NAME') }} and {{ env_var('NAME', 'default') }} expressions. */
function interpolateEnvVars(raw: string): string {
	return raw.replace(
		/{{\s*env_var\(\s*'([^']+)'(?:\s*,\s*'([^']*)')?\s*\)\s*}}/g,
		(_match, name: string, defaultValue?: string) => {
			const value = process.env[name];
			if (value !== undefined) return value;
			if (defaultValue !== undefined) return defaultValue;
			return `__UNRESOLVED_ENV_VAR_${name}__`;
		},
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
