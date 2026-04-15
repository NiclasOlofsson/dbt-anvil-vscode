import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DbtManifest, DbtProjectConfig } from './manifest-types';
import { loadProjectConfig, resolveTargetPath } from './project-config';

export interface ManifestLoadResult {
	manifest: DbtManifest;
	manifestPath: string;
	loadedAt: Date;
}

export class ManifestLoader {
	private _cached: ManifestLoadResult | null = null;
	private _manifestPath: string;
	private _projectConfig: DbtProjectConfig | undefined;
	private _lastMtimeMs: number | null = null;
	private readonly _extensionTargetDir: string | undefined;

	constructor(private readonly _projectDir: string, extensionTargetDir?: string) {
		this._extensionTargetDir = extensionTargetDir;
		this._projectConfig = loadProjectConfig(_projectDir);
		this._manifestPath = path.join(
			this._extensionTargetDir ?? resolveTargetPath(this._projectConfig, _projectDir),
			'manifest.json',
		);
	}

	/**
	 * Resolve the actual manifest path based on dbt_project.yml target-path setting.
	 */
	static resolveManifestPath(projectDir: string): string {
		const config = loadProjectConfig(projectDir);
		return path.join(resolveTargetPath(config, projectDir), 'manifest.json');
	}

	/**
	 * Reload the project config from disk and update the manifest path.
	 */
	reloadProjectConfig(): void {
		this._projectConfig = loadProjectConfig(this._projectDir);
		if (!this._extensionTargetDir) {
			this._manifestPath = path.join(
				resolveTargetPath(this._projectConfig, this._projectDir),
				'manifest.json',
			);
		}
	}

	get projectConfig(): DbtProjectConfig | undefined {
		return this._projectConfig;
	}

	get manifestPath(): string {
		return this._manifestPath;
	}

	get projectDir(): string {
		return this._projectDir;
	}

	manifestExists(): boolean {
		return fs.existsSync(this._manifestPath);
	}

	/**
	 * Load (or return cached) manifest. Pass force=true to reload from disk.
	 */
	load(force = false): ManifestLoadResult {
		if (!force && this._cached) {
			return this._cached;
		}

		if (!fs.existsSync(this._manifestPath)) {
			throw new Error(
				`manifest.json not found at ${this._manifestPath}. Run 'dbt parse' or 'dbt compile' to generate it.`,
			);
		}

		// Skip expensive re-read if the file hasn't actually been modified
		const stat = fs.statSync(this._manifestPath);
		if (!force && this._cached && this._lastMtimeMs === stat.mtimeMs) {
			return this._cached;
		}

		const raw = fs.readFileSync(this._manifestPath, 'utf-8');
		const manifest = JSON.parse(raw) as DbtManifest;

		this._lastMtimeMs = stat.mtimeMs;
		this._cached = {
			manifest,
			manifestPath: this._manifestPath,
			loadedAt: new Date(),
		};

		return this._cached;
	}

	/**
	 * Invalidate the cache — next call to load() will re-read from disk.
	 */
	invalidate(): void {
		this._cached = null;
		this._lastMtimeMs = null;
	}

	/**
	 * Get the manifest's dbt version.
	 */
	getDbtVersion(): string | undefined {
		try {
			return this.load().manifest.metadata.dbt_version;
		} catch {
			return undefined;
		}
	}

	/**
	 * Resolve the SQL dialect to use for parsing.
	 * Returns the adapter type from the manifest, or undefined if the manifest
	 * is not available. Callers that need a pre-manifest fallback should use
	 * DbtProjectService.adapterType (from profiles.yml).
	 */
	resolveDialect(): string | undefined {
		try {
			return this.load().manifest.metadata.adapter_type?.toLowerCase();
		} catch {
			return undefined;
		}
	}
}
