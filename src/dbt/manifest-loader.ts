import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DbtManifest } from './manifest-types';

export interface ManifestLoadResult {
	manifest: DbtManifest;
	manifestPath: string;
	loadedAt: Date;
}

export class ManifestLoader {
	private _cached: ManifestLoadResult | null = null;
	private _manifestPath: string;

	constructor(private readonly _projectDir: string) {
		this._manifestPath = path.join(this._projectDir, 'target', 'manifest.json');
	}

	/**
	 * Resolve the actual manifest path based on dbt_project.yml target-path setting.
	 */
	static resolveManifestPath(projectDir: string): string {
		const projectFile = path.join(projectDir, 'dbt_project.yml');
		if (fs.existsSync(projectFile)) {
			try {
				const content = fs.readFileSync(projectFile, 'utf-8');
				const targetMatch = /^target-path:\s*['"]?([^'"#\n]+)['"]?/m.exec(content);
				if (targetMatch) {
					const targetPath = targetMatch[1].trim();
					return path.join(projectDir, targetPath, 'manifest.json');
				}
			} catch {
				// Fall through to default
			}
		}
		return path.join(projectDir, 'target', 'manifest.json');
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

		const raw = fs.readFileSync(this._manifestPath, 'utf-8');
		const manifest = JSON.parse(raw) as DbtManifest;

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
}
