import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';

export interface Fixture {
	/** The rule id this fixture exercises, taken from the directory name. */
	ruleId: string;
	/** Subdirectory name for shape variants, or undefined for the bare fixture. */
	variantName?: string;
	/** Absolute path of the fixture's leaf directory. */
	dir: string;
	/** Raw text of violation.sql. */
	violation: string;
	/** Raw text of expected.sql. */
	expected: string;
	/** DEFAULT_CONFIG deep-merged with any config.json present. */
	config: NinjaConfig;
}

/**
 * Read a single fixture from a leaf directory. The directory MUST contain
 * `violation.sql` and `expected.sql`; `config.json` is optional.
 *
 * `ruleId` defaults to `path.basename(dir)` when not provided. `variantName`
 * defaults to undefined. Both fields are normally supplied by
 * {@link discoverFixtures}, which has already walked the tree and knows the
 * rule/variant distinction; callers loading a single fixture by absolute
 * path can pass them explicitly or accept the basename default.
 */
export function loadFixture(dir: string, ruleId?: string, variantName?: string): Fixture {
	const violationPath = path.join(dir, 'violation.sql');
	const expectedPath  = path.join(dir, 'expected.sql');
	const configPath    = path.join(dir, 'config.json');

	if (!fs.existsSync(violationPath)) {
		throw new Error(`fixture ${dir}: missing violation.sql`);
	}
	if (!fs.existsSync(expectedPath)) {
		throw new Error(`fixture ${dir}: missing expected.sql`);
	}

	const violation = fs.readFileSync(violationPath, 'utf8');
	const expected  = fs.readFileSync(expectedPath,  'utf8');

	let config = DEFAULT_CONFIG;
	if (fs.existsSync(configPath)) {
		const override = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<NinjaConfig>;
		config = deepMerge(DEFAULT_CONFIG, override) as NinjaConfig;
	}

	const inferredRuleId = ruleId ?? path.basename(dir);
	return { ruleId: inferredRuleId, variantName, dir, violation, expected, config };
}

/**
 * Walk `rootDir` for fixture leaves. A child directory of `rootDir` is either
 * a bare fixture (contains violation.sql at top) or a shape-variant container
 * (each subdirectory is its own fixture), or both (a bare fixture beside
 * shape subdirectories — the loader emits one bare entry and one per variant).
 */
export function discoverFixtures(rootDir: string): Fixture[] {
	if (!fs.existsSync(rootDir)) return [];
	const out: Fixture[] = [];
	for (const ruleName of fs.readdirSync(rootDir).sort()) {
		const ruleDir = path.join(rootDir, ruleName);
		if (!fs.statSync(ruleDir).isDirectory()) continue;

		const hasBareViolation = fs.existsSync(path.join(ruleDir, 'violation.sql'));
		if (hasBareViolation) {
			out.push(loadFixture(ruleDir, ruleName, undefined));
		}
		for (const child of fs.readdirSync(ruleDir).sort()) {
			const childDir = path.join(ruleDir, child);
			if (!fs.statSync(childDir).isDirectory()) continue;
			if (!fs.existsSync(path.join(childDir, 'violation.sql'))) continue;
			out.push(loadFixture(childDir, ruleName, child));
		}
	}
	return out;
}

/**
 * Recursive deep merge for plain JSON objects. Override wins on scalars and
 * arrays; objects are merged key-by-key. Sufficient for NinjaConfig shape.
 */
function deepMerge(base: unknown, override: unknown): unknown {
	if (override === undefined) return base;
	if (override === null) return base;
	if (typeof base !== 'object' || base === null || Array.isArray(base)) return override;
	if (typeof override !== 'object' || override === null || Array.isArray(override)) return override;
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const key of Object.keys(override as Record<string, unknown>)) {
		result[key] = deepMerge((base as Record<string, unknown>)[key], (override as Record<string, unknown>)[key]);
	}
	return result;
}
