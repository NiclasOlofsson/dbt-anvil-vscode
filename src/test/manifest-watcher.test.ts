/**
 * ManifestWatcher: when a source change must queue a dbt parse. The manifest is what
 * every provider reads (model index, macro shapes), so a save the watcher wrongly dedups
 * leaves the editor on stale knowledge with no way to recover short of a manual parse.
 * Real ManifestLoader + ManifestIndexer over a temp project; only the parse request is
 * observed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Uri } from 'vscode';
import { ManifestLoader } from '../dbt/manifest-loader';
import { ManifestIndexer } from '../indexing/manifest-indexer';
import { ManifestWatcher } from '../indexing/manifest-watcher';
import { createMockLogger } from './helpers';

let projectDir: string;

function write(rel: string, content: string): string {
	const abs = path.join(projectDir, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
	return abs;
}

/** A manifest knowing one model and one macro, generated "now" (or at the given time). */
function writeManifest(generatedAt = new Date()): void {
	write('target/manifest.json', JSON.stringify({
		metadata: { dbt_version: '1.10.0', adapter_type: 'duckdb', project_name: 'p', generated_at: generatedAt.toISOString() },
		nodes: {
			'model.p.orders': {
				unique_id: 'model.p.orders', name: 'orders', resource_type: 'model', package_name: 'p',
				original_file_path: 'models/orders.sql', schema: 'main', config: { materialized: 'view' }, tags: [], columns: {},
			},
		},
		sources: {},
		macros: {
			'macro.p.clean': {
				unique_id: 'macro.p.clean', name: 'clean', package_name: 'p',
				original_file_path: 'macros/clean.sql', macro_sql: '{% macro clean(c) %}trim({{ c }}){% endmacro %}', arguments: [],
			},
			// An adapter package macro: its path is relative to the package, not the project.
			'macro.dbt_duckdb.duckdb__create_schema': {
				unique_id: 'macro.dbt_duckdb.duckdb__create_schema', name: 'duckdb__create_schema', package_name: 'dbt_duckdb',
				original_file_path: 'macros/adapters.sql', macro_sql: '{% macro duckdb__create_schema(r) %}select 1{% endmacro %}', arguments: [],
			},
		},
		exposures: {}, metrics: {}, parent_map: {}, child_map: {},
	}));
}

function makeWatcher(): { watcher: ManifestWatcher; parses: () => number; flush: () => Promise<void> } {
	const loader = new ManifestLoader(projectDir);
	const indexer = new ManifestIndexer(loader, createMockLogger());
	indexer.build();
	const watcher = new ManifestWatcher(loader, indexer, createMockLogger());
	let count = 0;
	watcher.onParseRequested(() => { count++; });
	return {
		watcher,
		parses: () => count,
		// The parse request is debounced (1s); run the timers instead of waiting.
		flush: async () => { await vi.runAllTimersAsync(); },
	};
}

beforeEach(() => {
	// Only the debounce timers are faked; Date and file mtimes stay on the real clock.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-watcher-'));
	write('dbt_project.yml', 'name: p\nversion: "1.0"\nprofile: p\nmodel-paths: ["models"]\nmacro-paths: ["macros"]\n');
	write('models/orders.sql', 'select 1 as id');
	write('macros/clean.sql', '{% macro clean(c) %}trim({{ c }}){% endmacro %}');
	writeManifest();
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('ManifestWatcher.handleSourceChange', () => {
	it('a known model: parses on a real change, dedups the same content, skips whitespace-only edits', async () => {
		const { watcher, parses, flush } = makeWatcher();
		const abs = path.join(projectDir, 'models/orders.sql');

		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(1);

		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(1);

		write('models/orders.sql', 'select  1 as id\n');
		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(1);

		write('models/orders.sql', 'select 2 as id');
		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(2);
	});

	it('a model file the manifest has never seen parses on every save, whatever the hashes say', async () => {
		const { watcher, parses, flush } = makeWatcher();
		const abs = write('models/new_model.sql', 'select 1');
		// A stale baseline from a previous session (the old bug recorded skipped saves).
		watcher.restoreHashes({ hashes: { [abs]: '' }, nonWsHashes: {} });

		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(1);

		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(2);
	});

	it('a macro file parses on change like a model does', async () => {
		const { watcher, parses, flush } = makeWatcher();
		const abs = path.join(projectDir, 'macros/clean.sql');

		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(1);

		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(1);

		write('macros/clean.sql', '{% macro clean(c) %}lower(trim({{ c }})){% endmacro %}');
		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(2);
	});

	it('a new macro file parses even though no manifest macro points at it', async () => {
		const { watcher, parses, flush } = makeWatcher();
		const abs = write('macros/filters.sql', '{% macro f(c) %}and {{ c }} = 1{% endmacro %}');
		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(1);
	});

	it('a .sql outside the model and macro paths does not parse', async () => {
		const { watcher, parses, flush } = makeWatcher();
		const abs = write('scripts/adhoc.sql', 'select 1');
		watcher.handleSourceChange(abs, Uri.file(abs));
		await flush();
		expect(parses()).toBe(0);
	});
});

describe('ManifestWatcher.reconcileSources (startup catch-up)', () => {
	it('nothing changed since the manifest: no parse (a package macro phantom path is not a deleted file)', async () => {
		const { watcher, parses, flush } = makeWatcher();
		watcher.reconcileSources();
		await flush();
		expect(parses()).toBe(0);
	});

	it('a model file added while nothing was watching queues one parse', async () => {
		write('models/added.sql', 'select 1');
		const { watcher, parses, flush } = makeWatcher();
		watcher.reconcileSources();
		await flush();
		expect(parses()).toBe(1);
	});

	it('a macro file added while nothing was watching queues one parse', async () => {
		write('macros/filters.sql', '{% macro f(c) %}and {{ c }} = 1{% endmacro %}');
		const { watcher, parses, flush } = makeWatcher();
		watcher.reconcileSources();
		await flush();
		expect(parses()).toBe(1);
	});

	it('a known file written after the manifest queues a parse; one written before does not', async () => {
		// Manifest generated in the future relative to the files: nothing is newer.
		writeManifest(new Date(Date.now() + 60_000));
		const first = makeWatcher();
		first.watcher.reconcileSources();
		await first.flush();
		expect(first.parses()).toBe(0);

		// Manifest generated in the past: the model file is newer than it.
		writeManifest(new Date(Date.now() - 60_000));
		const second = makeWatcher();
		second.watcher.reconcileSources();
		await second.flush();
		expect(second.parses()).toBe(1);
	});

	it('with a persisted baseline the hashes decide, not the mtime', async () => {
		writeManifest(new Date(Date.now() - 60_000));
		const { watcher, parses, flush } = makeWatcher();
		const seeded = makeWatcher();
		for (const rel of ['models/orders.sql', 'macros/clean.sql']) {
			const abs = path.join(projectDir, rel);
			seeded.watcher.handleSourceChange(abs, Uri.file(abs)); // records the current hashes
		}
		watcher.restoreHashes({
			hashes: Object.fromEntries(seeded.watcher.getHashes().hashes),
			nonWsHashes: Object.fromEntries(seeded.watcher.getHashes().nonWsHashes),
		});
		watcher.reconcileSources();
		await flush();
		expect(parses()).toBe(0);
	});

	it('a manifest model whose file is gone queues a parse', async () => {
		fs.rmSync(path.join(projectDir, 'models/orders.sql'));
		const { watcher, parses, flush } = makeWatcher();
		watcher.reconcileSources();
		await flush();
		expect(parses()).toBe(1);
	});
});
