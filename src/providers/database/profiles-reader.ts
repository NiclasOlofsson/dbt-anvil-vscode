import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

/**
 * Connection details extracted from a dbt profile target.
 * Fields are adapter-specific; only the common ones are typed here.
 */
export interface ProfileConnection {
	type: string;
	[key: string]: unknown;
}

/**
 * Databricks-specific connection fields from profiles.yml.
 */
export interface DatabricksConnection extends ProfileConnection {
	type: 'databricks';
	host: string;
	http_path: string;
	token: string;
	catalog?: string;
	schema?: string;
}

/**
 * Reads and parses a dbt profiles.yml file, resolving the active target for
 * the given profile name and interpolating {{ env_var() }} expressions.
 *
 * Profile resolution order:
 *  1. profilesDir/profiles.yml  (project-level override, already resolved by EnvDetector)
 *  2. Falls back to ~/.dbt/profiles.yml if the above doesn't exist
 *
 * The caller should pass the profilesDir returned by EnvDetector, which already
 * applies the project-config override and the home-dir fallback.
 */
export class ProfilesReader {
	constructor(
		private readonly profileName: string,
		private readonly profilesDir: string,
	) {}

	/**
	 * Load and return the resolved connection for the active target.
	 * Returns undefined if the profile or target cannot be found.
	 */
	async readConnection(): Promise<ProfileConnection | undefined> {
		const filePath = path.join(this.profilesDir, 'profiles.yml');

		let raw: string;
		try {
			raw = await fs.readFile(filePath, 'utf-8');
		} catch {
			return undefined;
		}

		const interpolated = interpolateEnvVars(raw);

		let doc: unknown;
		try {
			doc = yaml.load(interpolated);
		} catch {
			return undefined;
		}

		if (!isRecord(doc)) return undefined;

		const profile = doc[this.profileName];
		if (!isRecord(profile)) return undefined;

		const outputs = profile['outputs'];
		if (!isRecord(outputs)) return undefined;

		// Use the profile's default target; fall back to first available target
		const targetName = typeof profile['target'] === 'string'
			? profile['target']
			: Object.keys(outputs)[0];

		if (!targetName) return undefined;

		const target = outputs[targetName];
		if (!isRecord(target)) return undefined;

		return target as ProfileConnection;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Interpolate {{ env_var('NAME') }} and {{ env_var('NAME', 'default') }} expressions
 * in a YAML string before parsing, mimicking dbt's env_var() function.
 */
function interpolateEnvVars(raw: string): string {
	return raw.replace(
		/{{\s*env_var\(\s*'([^']+)'(?:\s*,\s*'([^']*)')?\s*\)\s*}}/g,
		(_match, name: string, defaultValue?: string) => {
			const value = process.env[name];
			if (value !== undefined) return value;
			if (defaultValue !== undefined) return defaultValue;
			// Leave the expression unresolved — YAML parse will likely error,
			// but the caller handles undefined gracefully.
			return `__UNRESOLVED_ENV_VAR_${name}__`;
		},
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
