/**
 * Vitest global setup — ensures the sample projects' manifest.json artifacts
 * exist before test collection. sample-projects-document-model.test.ts sources
 * macro SQL (shapeOf) from these manifests at module scope, and samples/x/target/
 * is gitignored, so a fresh clone or CI runner must generate them once.
 *
 * Requires uv (the samples are uv projects); `uv run` bootstraps each sample's
 * venv from its committed lockfile. Subsequent runs skip instantly.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SAMPLES = ['jaffle_shop', 'nba-monte-carlo'];

export default function setup(): void {
	for (const name of SAMPLES) {
		const dir = path.resolve(import.meta.dirname, '..', '..', 'samples', name);
		if (fs.existsSync(path.join(dir, 'target', 'manifest.json'))) continue;
		if (fs.existsSync(path.join(dir, 'packages.yml'))) {
			runDbt(dir, 'deps');
		}
		runDbt(dir, 'parse');
	}
}

function runDbt(dir: string, command: string): void {
	const result = spawnSync(
		'uv',
		['run', 'dbt', command, '--project-dir', dir, '--profiles-dir', dir],
		{ cwd: dir, encoding: 'utf-8', timeout: 300_000 },
	);
	if (result.error) {
		throw new Error(`uv run dbt ${command} spawn failed in ${dir}: ${result.error.message} (is uv installed?)`);
	}
	if (result.status !== 0) {
		throw new Error(`dbt ${command} exited ${result.status} in ${dir}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
	}
}
