import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { CompileCache } from '../dbt/compile-cache';
import { ManifestLoader } from '../dbt/manifest-loader';
import type { DbtExecutionService } from '../dbt/execution-service';
import { createMockLogger } from './helpers';

const TEST_DIR = path.join(__dirname, '..', 'fixtures', 'test-project-compile-cache');

function sha256(s: string): string {
	return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

interface FixtureOpts {
	source: string;
	rawCode: string;
	compiledCode?: string;
	checksum: string;
}

function writeFixture(opts: FixtureOpts) {
	fs.mkdirSync(path.join(TEST_DIR, 'models'), { recursive: true });
	fs.writeFileSync(path.join(TEST_DIR, 'models', 'foo.sql'), opts.source);
	fs.mkdirSync(path.join(TEST_DIR, 'target'), { recursive: true });
	const manifest = {
		metadata: { dbt_version: '1.8.0', adapter_type: 'duckdb' },
		nodes: {
			'model.p.foo': {
				unique_id: 'model.p.foo',
				name: 'foo',
				resource_type: 'model',
				package_name: 'p',
				original_file_path: 'models/foo.sql',
				schema: 'main',
				config: { materialized: 'view' },
				tags: [],
				columns: {},
				raw_code: opts.rawCode,
				compiled_code: opts.compiledCode,
				checksum: { name: 'sha256', checksum: opts.checksum },
			},
		},
		sources: {},
		exposures: {},
		metrics: {},
		macros: {},
		docs: {},
		parent_map: {},
		child_map: {},
	};
	fs.writeFileSync(path.join(TEST_DIR, 'target', 'manifest.json'), JSON.stringify(manifest));
}

describe('CompileCache warm-path freshness gate', () => {
	beforeEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});
	afterEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it('takes warm path when manifest checksum matches disk content', async () => {
		const source = 'select 1 as a';
		writeFixture({
			source,
			rawCode: source,
			compiledCode: 'select 1 as a /* compiled */',
			checksum: sha256(source),
		});
		const loader = new ManifestLoader(TEST_DIR);
		const submit = vi.fn();
		const service = { submit } as unknown as DbtExecutionService;
		const cache = new CompileCache(service, loader, createMockLogger());

		const compiled = await cache.ensureCompiled('model.p.foo', 'foo', TEST_DIR, 'models/foo.sql');

		expect(compiled).toBe('select 1 as a /* compiled */');
		expect(submit).not.toHaveBeenCalled();
	});

	it('skips warm path and falls through to compile when disk content has been edited since the manifest was written', async () => {
		const original = 'select 1 as a';
		const edited = 'select 1 as a, 2 as b';
		writeFixture({
			source: edited,
			rawCode: original,
			compiledCode: 'select 1 as a /* stale compiled */',
			checksum: sha256(original),
		});
		const loader = new ManifestLoader(TEST_DIR);
		const submit = vi.fn().mockResolvedValue({ success: false, stderr: 'compile attempted', stdout: '' });
		const service = { submit } as unknown as DbtExecutionService;
		const cache = new CompileCache(service, loader, createMockLogger());

		const compiled = await cache.ensureCompiled('model.p.foo', 'foo', TEST_DIR, 'models/foo.sql');

		// Warm path was rejected (checksum mismatch) and the stub compile failed,
		// so the stale manifest.compiled_code never reaches the caller.
		expect(submit).toHaveBeenCalledTimes(1);
		expect(compiled).toBeUndefined();
	});

	it('accepts a checksum computed against stripped content (older dbt versions)', async () => {
		const stripped = 'select 1 as a';
		const source = `\n\n${stripped}\n`;
		writeFixture({
			source,
			rawCode: stripped,
			compiledCode: 'select 1 as a /* compiled */',
			checksum: sha256(stripped),
		});
		const loader = new ManifestLoader(TEST_DIR);
		const submit = vi.fn();
		const service = { submit } as unknown as DbtExecutionService;
		const cache = new CompileCache(service, loader, createMockLogger());

		const compiled = await cache.ensureCompiled('model.p.foo', 'foo', TEST_DIR, 'models/foo.sql');

		expect(compiled).toBe('select 1 as a /* compiled */');
		expect(submit).not.toHaveBeenCalled();
	});

	it('skips warm path when the manifest node has no checksum recorded', async () => {
		const source = 'select 1 as a';
		writeFixture({
			source,
			rawCode: source,
			compiledCode: 'select 1 as a /* compiled */',
			checksum: '',
		});
		// Remove the checksum field entirely so we exercise the "no checksum" branch
		const manifestPath = path.join(TEST_DIR, 'target', 'manifest.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
		const nodes = manifest.nodes as Record<string, Record<string, unknown>>;
		delete nodes['model.p.foo'].checksum;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));

		const loader = new ManifestLoader(TEST_DIR);
		const submit = vi.fn().mockResolvedValue({ success: false, stderr: '', stdout: '' });
		const service = { submit } as unknown as DbtExecutionService;
		const cache = new CompileCache(service, loader, createMockLogger());

		await cache.ensureCompiled('model.p.foo', 'foo', TEST_DIR, 'models/foo.sql');

		// No checksum to verify against → can't trust the warm path → must compile.
		expect(submit).toHaveBeenCalledTimes(1);
	});
});
