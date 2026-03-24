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
		macros: {
			'macro.project.my_custom_macro': {
				unique_id: 'macro.project.my_custom_macro',
				name: 'my_custom_macro',
				package_name: 'project',
				description: 'A custom macro for testing',
				arguments: [
					{ name: 'relation', type: 'string', description: 'The relation to operate on' },
					{ name: 'columns', description: 'List of columns' },
				],
			},
			'macro.project.generate_schema_name': {
				unique_id: 'macro.project.generate_schema_name',
				name: 'generate_schema_name',
				package_name: 'project',
				description: 'Custom schema name generator',
				arguments: [],
			},
			'macro.dbt.run_query': {
				unique_id: 'macro.dbt.run_query',
				name: 'run_query',
				package_name: 'dbt',
				description: 'Built-in dbt macro',
				arguments: [],
			},
			'macro.dbt_utils.star': {
				unique_id: 'macro.dbt_utils.star',
				name: 'star',
				package_name: 'dbt_utils',
				description: 'Generates a star of columns',
				arguments: [{ name: 'from' }],
			},
		},
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
		expect(index.adapterType).toBe('duckdb');
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

	it('should index user macros and exclude dbt built-ins', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		const index = indexer.build();

		// Project macros should be indexed
		expect(index.macros.has('macro.project.my_custom_macro')).toBe(true);
		expect(index.macros.has('macro.project.generate_schema_name')).toBe(true);

		// dbt built-in macros should be excluded
		expect(index.macros.has('macro.dbt.run_query')).toBe(false);

		// dbt_utils is a user package, should be included
		expect(index.macros.has('macro.dbt_utils.star')).toBe(true);
	});

	it('should find macros by prefix', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const myMacros = indexer.findMacrosByPrefix('my_');
		expect(myMacros).toHaveLength(1);
		expect(myMacros[0].name).toBe('my_custom_macro');
		expect(myMacros[0].arguments).toHaveLength(2);
	});

	it('should return empty array for unknown macro prefix', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		expect(indexer.findMacrosByPrefix('zzz_')).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// Column store
	// -----------------------------------------------------------------------

	it('should store and retrieve columns', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		expect(indexer.getColumns('model.project.my_model')).toBeUndefined();
		indexer.setColumns('model.project.my_model', ['id', 'name']);
		expect(indexer.getColumns('model.project.my_model')).toEqual(['id', 'name']);
	});

	it('should clear column store on full rebuild', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		indexer.setColumns('model.project.my_model', ['id', 'name']);
		indexer.build(true);
		expect(indexer.getColumns('model.project.my_model')).toBeUndefined();
	});

	it('should invalidate model and all downstream dependents', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		indexer.setColumns('model.project.my_model', ['id', 'name']);
		indexer.setColumns('model.project.downstream', ['id', 'total']);
		indexer.setColumns('seed.project.my_seed', ['col1']);

		const evicted = indexer.invalidateModel('model.project.my_model');
		expect(evicted).toContain('model.project.my_model');
		expect(evicted).toContain('model.project.downstream');
		expect(evicted).not.toContain('seed.project.my_seed');

		expect(indexer.getColumns('model.project.my_model')).toBeUndefined();
		expect(indexer.getColumns('model.project.downstream')).toBeUndefined();
		expect(indexer.getColumns('seed.project.my_seed')).toEqual(['col1']);
	});

	it('should not evict upstream when invalidating downstream', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		indexer.setColumns('model.project.my_model', ['id', 'name']);
		indexer.setColumns('model.project.downstream', ['id', 'total']);

		const evicted = indexer.invalidateModel('model.project.downstream');
		expect(evicted).toContain('model.project.downstream');
		expect(evicted).not.toContain('model.project.my_model');

		expect(indexer.getColumns('model.project.my_model')).toEqual(['id', 'name']);
		expect(indexer.getColumns('model.project.downstream')).toBeUndefined();
	});

	it('should find model by file path', () => {
		const loader = new ManifestLoader(TEST_DIR);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const modelPath = path.join(TEST_DIR, 'models', 'my_model.sql');
		expect(indexer.findModelByFilePath(modelPath)).toBe('model.project.my_model');
		expect(indexer.findModelByFilePath('/nonexistent/file.sql')).toBeUndefined();
	});
});
