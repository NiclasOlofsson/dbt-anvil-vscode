import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ManifestLoader } from '../dbt/manifest-loader';

const TEST_DIR = path.join(__dirname, '..', 'fixtures', 'test-project');

function createMinimalManifest() {
	return {
		metadata: { dbt_version: '1.8.0', adapter_type: 'duckdb' },
		nodes: {},
		sources: {},
		exposures: {},
		metrics: {},
		macros: {},
		child_map: {},
		parent_map: {},
	};
}

describe('ManifestLoader', () => {
	beforeEach(() => {
		fs.mkdirSync(path.join(TEST_DIR, 'target'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it('should return the default manifest path', () => {
		const loader = new ManifestLoader(TEST_DIR);
		expect(loader.manifestPath).toBe(path.join(TEST_DIR, 'target', 'manifest.json'));
	});

	it('should report manifestExists=false when no file', () => {
		const loader = new ManifestLoader(TEST_DIR);
		expect(loader.manifestExists()).toBe(false);
	});

	it('should report manifestExists=true when file exists', () => {
		fs.writeFileSync(
			path.join(TEST_DIR, 'target', 'manifest.json'),
			JSON.stringify(createMinimalManifest()),
		);
		const loader = new ManifestLoader(TEST_DIR);
		expect(loader.manifestExists()).toBe(true);
	});

	it('should load manifest from disk', () => {
		const manifest = createMinimalManifest();
		fs.writeFileSync(
			path.join(TEST_DIR, 'target', 'manifest.json'),
			JSON.stringify(manifest),
		);
		const loader = new ManifestLoader(TEST_DIR);
		const result = loader.load();
		expect(result.manifest.metadata.dbt_version).toBe('1.8.0');
		expect(result.manifestPath).toContain('manifest.json');
	});

	it('should cache on subsequent loads', () => {
		const manifest = createMinimalManifest();
		fs.writeFileSync(
			path.join(TEST_DIR, 'target', 'manifest.json'),
			JSON.stringify(manifest),
		);
		const loader = new ManifestLoader(TEST_DIR);
		const first = loader.load();
		const second = loader.load();
		expect(first).toBe(second);
	});

	it('should reload after invalidate', () => {
		const manifest = createMinimalManifest();
		fs.writeFileSync(
			path.join(TEST_DIR, 'target', 'manifest.json'),
			JSON.stringify(manifest),
		);
		const loader = new ManifestLoader(TEST_DIR);
		const first = loader.load();
		loader.invalidate();
		const second = loader.load();
		expect(first).not.toBe(second);
	});

	it('should throw when manifest does not exist', () => {
		const loader = new ManifestLoader(TEST_DIR);
		expect(() => loader.load()).toThrow('manifest.json not found');
	});

	it('should respect custom target-path from dbt_project.yml', () => {
		fs.writeFileSync(
			path.join(TEST_DIR, 'dbt_project.yml'),
			'name: test\ntarget-path: build\n',
		);
		const resolved = ManifestLoader.resolveManifestPath(TEST_DIR);
		expect(resolved).toBe(path.join(TEST_DIR, 'build', 'manifest.json'));
	});

	it('should return dbt version', () => {
		const manifest = createMinimalManifest();
		fs.writeFileSync(
			path.join(TEST_DIR, 'target', 'manifest.json'),
			JSON.stringify(manifest),
		);
		const loader = new ManifestLoader(TEST_DIR);
		expect(loader.getDbtVersion()).toBe('1.8.0');
	});
});
