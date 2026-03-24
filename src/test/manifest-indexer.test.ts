import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ManifestLoader } from '../dbt/manifest-loader';
import { ManifestIndexer } from '../indexing/manifest-indexer';
import { createMockLogger } from './helpers';

const TEST_DIR = path.join(__dirname, '..', 'fixtures', 'test-project-indexer');

const mockLogger = createMockLogger();

function writeManifest(manifest: Record<string, unknown>) {
	fs.mkdirSync(path.join(TEST_DIR, 'target'), { recursive: true });
	fs.writeFileSync(
		path.join(TEST_DIR, 'target', 'manifest.json'),
		JSON.stringify(manifest),
	);
}

function createTestManifest() {
	return {
		metadata: { dbt_version: '1.8.0', adapter_type: 'duckdb' },
		nodes: {
			'model.project.my_model': {
				unique_id: 'model.project.my_model',
				name: 'my_model',
				resource_type: 'model',
				package_name: 'project',
				original_file_path: 'models/my_model.sql',
				schema: 'main',
				config: { materialized: 'table' },
				description: 'A test model',
				tags: ['daily'],
				columns: { id: { name: 'id', description: 'Primary key' } },
			},
			'model.project.downstream': {
				unique_id: 'model.project.downstream',
				name: 'downstream',
				resource_type: 'model',
				package_name: 'project',
				original_file_path: 'models/downstream.sql',
				schema: 'main',
				config: { materialized: 'view' },
				description: 'Downstream model',
				tags: [],
				columns: {},
			},
			'seed.project.my_seed': {
				unique_id: 'seed.project.my_seed',
				name: 'my_seed',
				resource_type: 'seed',
				package_name: 'project',
				original_file_path: 'seeds/my_seed.csv',
				schema: 'main',
				config: { materialized: 'seed' },
				description: '',
				tags: [],
				columns: {},
			},
		},
		sources: {
			'source.project.raw.orders': {
				unique_id: 'source.project.raw.orders',
				name: 'orders',
				resource_type: 'source',
				source_name: 'raw',
				schema: 'raw_data',
				database: 'warehouse',
				description: 'Raw orders table',
				tags: [],
			},
		},
		exposures: {},
		metrics: {},
		macros: {},
		child_map: {
			'model.project.my_model': ['model.project.downstream'],
		},
		parent_map: {
			'model.project.downstream': ['model.project.my_model'],
		},
	};
}

describe('ManifestIndexer', () => {
	beforeEach(() => {
		writeManifest(createTestManifest());
	});

	afterEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it('should build an index from manifest', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		const index = indexer.build();

		expect(index.models.size).toBe(3); // 2 models + 1 seed
		expect(index.sources.size).toBe(1);
		expect(index.dbtVersion).toBe('1.8.0');
	});

	it('should find models by name', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const found = indexer.findModelsByName('my_model');
		expect(found).toHaveLength(1);
		expect(found[0].name).toBe('my_model');
		expect(found[0].materialisation).toBe('table');
	});

	it('should return empty for unknown model name', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		expect(indexer.findModelsByName('nonexistent')).toHaveLength(0);
	});

	it('should compute lineage', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const lineage = indexer.getLineage('model.project.my_model', 2);
		expect(lineage.downstream).toContain('model.project.downstream');
	});

	it('should find models by tag', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const tagged = indexer.findByTag('daily');
		expect(tagged).toHaveLength(1);
		expect(tagged[0].name).toBe('my_model');
	});

	it('should get raw node by unique id', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const node = indexer.getRawNode('model.project.my_model');
		expect(node).toBeDefined();
		expect(node?.name).toBe('my_model');
	});

	it('should include sources in index', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		const index = indexer.build();

		const source = index.sources.get('source.project.raw.orders');
		expect(source).toBeDefined();
		expect(source?.sourceName).toBe('raw');
		expect(source?.schema).toBe('raw_data');
	});

	it('should cache index unless force rebuild', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		const first = indexer.build();
		const second = indexer.build();
		expect(first).toBe(second);

		const forced = indexer.build(true);
		expect(forced).not.toBe(first);
	});
});
