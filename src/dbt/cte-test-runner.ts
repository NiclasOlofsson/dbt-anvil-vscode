/**
 * CteTestRunner — orchestrates the full lifecycle of a single CTE unit test:
 *   1. Read the unit-test YAML and locate the model SQL file
 *   2. Generate a trimmed model SQL file  (cte-test-generator.generateModelSql)
 *   3. Generate a unit-test YAML targeting the trimmed model  (cte-test-generator.buildTestYaml)
 *   4. Submit `dbt test -s <genModel>` via the execution service
 *   5. Clean up generated files in a finally block
 */

import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { loadProjectConfig } from './project-config';
import { generateModelSql, buildTestYaml } from './cte-test-generator';
import type { UnitTestFile } from './cte-test-generator';
import { type DbtExecutionService, type DbtCommandResult, Priority } from './execution-service';

export class CteTestRunner {
	constructor(
		private readonly projectDir: string,
		private readonly executionService: DbtExecutionService,
	) {}

	async runCteTest(yamlFile: string, testName: string): Promise<DbtCommandResult> {
		const projDir = this.projectDir;
		const config = loadProjectConfig(projDir) ?? {};
		const modelPaths: string[] = (config as Record<string, unknown>)['model-paths'] as string[] ?? ['models'];
		const testPaths: string[] = (config as Record<string, unknown>)['test-paths'] as string[] ?? ['tests'];

		// Determine output dirs for generated files
		const genModelsDir = path.join(projDir, modelPaths[0], '__cte_tests');
		const unitTestsRoot = path.join(projDir, 'unit_tests');
		const genTestsDir = fsSync.existsSync(unitTestsRoot)
			? path.join(unitTestsRoot, '__cte_tests')
			: path.join(projDir, testPaths[0], '__cte_tests');

		// Clean up any leftovers from a previous interrupted run
		await removeDir(genModelsDir);
		await removeDir(genTestsDir);

		try {
			return await this._generate(
				yamlFile, testName, projDir, modelPaths, testPaths,
				genModelsDir, genTestsDir,
			);
		} finally {
			await removeDir(genModelsDir);
			await removeDir(genTestsDir);
		}
	}

	private async _generate(
		yamlFile: string,
		testName: string,
		projDir: string,
		modelPaths: string[],
		testPaths: string[],
		genModelsDir: string,
		genTestsDir: string,
	): Promise<DbtCommandResult> {
		// Load the unit-test YAML
		let testData: UnitTestFile;
		try {
			const raw = await fs.readFile(yamlFile, 'utf-8');
			testData = yaml.load(raw) as UnitTestFile;
		} catch (err) {
			return errorResult(`Failed to read YAML file: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Find the target test
		const targetTest = testData?.unit_tests?.find(t => t.name === testName);
		if (!targetTest) {
			return errorResult(`Test '${testName}' not found in ${yamlFile}`);
		}

		// Parse model spec: "base_model::cte_name"
		const modelSpec: string = targetTest.model ?? '';
		if (!modelSpec.includes('::')) {
			return errorResult(`model field '${modelSpec}' missing '::' separator`);
		}
		const colonIdx = modelSpec.indexOf('::');
		const baseModel = modelSpec.slice(0, colonIdx);
		const cteName = modelSpec.slice(colonIdx + 2);

		// Build generated model name using 6-char MD5 of testName (matches Python)
		const testHash = crypto.createHash('md5').update(testName).digest('hex').slice(0, 6);
		const genModelName = `${baseModel}__${cteName}__${testHash}`;

		// Derive output file paths
		const genModelPath = path.join(genModelsDir, `${genModelName}.sql`);
		const genTestPath = path.join(genTestsDir, `${genModelName}_unit_tests.yml`);

		// Locate the model SQL file
		const modelFile = findModelFile(baseModel, yamlFile, projDir, modelPaths, testPaths);
		if (!modelFile) {
			return errorResult(`Model file for '${baseModel}' not found`);
		}

		// Generate the trimmed model SQL
		let rawSql: string;
		try {
			rawSql = await fs.readFile(modelFile, 'utf-8');
		} catch (err) {
			return errorResult(`Failed to read model file: ${err instanceof Error ? err.message : String(err)}`);
		}

		const modelSql = generateModelSql(rawSql, cteName, targetTest.given ?? []);
		if (!modelSql) {
			return errorResult(`CTE '${cteName}' not found in ${modelFile}`);
		}

		// Write generated model SQL
		await fs.mkdir(genModelsDir, { recursive: true });
		await fs.writeFile(genModelPath, modelSql, 'utf-8');

		// Generate the unit-test YAML
		const testYaml = buildTestYaml(testData, testName, genModelName, modelSql);
		if (!testYaml) {
			return errorResult(`Failed to generate test YAML for '${testName}'`);
		}

		// Write generated test YAML
		await fs.mkdir(genTestsDir, { recursive: true });
		await fs.writeFile(genTestPath, testYaml, 'utf-8');

		// Submit dbt test to the execution service
		return this.executionService.submit({
			type: 'test',
			args: ['test', '-s', genModelName],
			priority: Priority.User,
			origin: 'user',
			label: `CTE test ${testName}`,
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Locate the SQL model file for `baseModel`, mirroring the test-path directory
 * structure onto model-paths (same logic as Python's `_cte_find_model_file`).
 */
export function findModelFile(
	baseModel: string,
	yamlPath: string,
	projDir: string,
	modelPaths: string[],
	testPaths: string[],
): string | null {
	const testRoots: string[] = testPaths.map(tp => path.join(projDir, tp));
	const unitTestsDir = path.join(projDir, 'unit_tests');
	if (fsSync.existsSync(unitTestsDir) && !testRoots.includes(unitTestsDir)) {
		testRoots.push(unitTestsDir);
	}

	const modelsBase = path.join(projDir, modelPaths[0]);
	const yamlDir = path.dirname(yamlPath);

	// Try to mirror the yaml parent relative to a test root onto the models dir
	for (const testRoot of testRoots) {
		if (yamlDir.startsWith(testRoot)) {
			const rel = path.relative(testRoot, yamlDir);
			const candidate = path.join(modelsBase, rel, `${baseModel}.sql`);
			if (fsSync.existsSync(candidate)) return candidate;
		}
	}

	// Fallback: recursive scan under models base
	return findRecursive(modelsBase, `${baseModel}.sql`);
}

/** Recursively search for a file by name under `dir`. Returns first match or null. */
function findRecursive(dir: string, filename: string): string | null {
	if (!fsSync.existsSync(dir)) return null;
	const entries = fsSync.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const found = findRecursive(full, filename);
			if (found) return found;
		} else if (entry.name === filename) {
			return full;
		}
	}
	return null;
}

async function removeDir(dir: string): Promise<void> {
	try {
		await fs.rm(dir, { recursive: true, force: true });
	} catch {
		// ignore errors — dir may not exist
	}
}

function errorResult(msg: string): DbtCommandResult {
	return { success: false, stdout: '', stderr: msg };
}
