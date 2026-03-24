import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { ManifestLoader } from '../dbt/manifest-loader';
import { ManifestIndexer } from '../indexing/manifest-indexer';
import { createMockLogger } from './helpers';

const JAFFLE_SHOP = path.join(__dirname, '..', '..', 'samples', 'jaffle_shop');
const mockLogger = createMockLogger();

describe('jaffle_shop integration', () => {
	it('should load the real jaffle_shop manifest', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		expect(loader.manifestExists()).toBe(true);

		const result = loader.load();
		expect(result.manifest.metadata.dbt_version).toBe('1.10.13');
		expect(result.manifest.metadata.project_name).toBe('jaffle_shop');
	});

	it('should build an index from the real manifest', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		const indexer = new ManifestIndexer(loader, mockLogger);
		const index = indexer.build();

		// 3 models + 2 seeds + 1 snapshot = 6 indexable nodes (tests are not indexed)
		expect(index.models.size).toBeGreaterThanOrEqual(6);
		expect(index.sources.size).toBe(2);
		expect(index.dbtVersion).toBe('1.10.13');
	});

	it('should find the customers model by name', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const found = indexer.findModelsByName('customers');
		expect(found.length).toBeGreaterThanOrEqual(1);
		expect(found[0].uniqueId).toBe('model.jaffle_shop.customers');
		expect(found[0].packageName).toBe('jaffle_shop');
	});

	it('should find stg_orders by name', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const found = indexer.findModelsByName('stg_orders');
		expect(found).toHaveLength(1);
		expect(found[0].materialisation).toBe('view');
	});

	it('should resolve lineage for customers model', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const lineage = indexer.getLineage('model.jaffle_shop.customers', 1);
		// customers depends on stg_customers and stg_orders
		expect(lineage.upstream.length).toBeGreaterThanOrEqual(1);
	});

	it('should find models by tag', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		// Even if no models have tags, the method should return an array
		const tagged = indexer.findByTag('nonexistent-tag');
		expect(Array.isArray(tagged)).toBe(true);
	});

	it('should retrieve raw node data', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const raw = indexer.getRawNode('model.jaffle_shop.customers');
		expect(raw).toBeDefined();
		expect(raw?.name).toBe('customers');
		expect(raw?.resource_type).toBe('model');
	});

	it('should resolve the manifest path with custom target-path', () => {
		const resolved = ManifestLoader.resolveManifestPath(JAFFLE_SHOP);
		// jaffle_shop uses default target path
		expect(resolved).toBe(path.join(JAFFLE_SHOP, 'target', 'manifest.json'));
	});

	it('should return dbt version from the manifest', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		expect(loader.getDbtVersion()).toBe('1.10.13');
	});

	it('should index sources correctly', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		const indexer = new ManifestIndexer(loader, mockLogger);
		const index = indexer.build();

		const source = index.sources.get('source.jaffle_shop.jaffle_shop.orders');
		expect(source).toBeDefined();
		expect(source?.name).toBe('orders');
		expect(source?.sourceName).toBe('jaffle_shop');
	});

	it('should build schema mapping from documented columns', () => {
		const loader = new ManifestLoader(JAFFLE_SHOP);
		const indexer = new ManifestIndexer(loader, mockLogger);
		indexer.build();

		const mapping = indexer.buildSchemaMapping();

		// Sources have documented columns (jaffle_shop.customers has id, first_name, last_name)
		const hasSourceColumns = Object.values(mapping).some(db =>
			Object.values(db).some(schema =>
				Object.keys(schema).some(table =>
					table === 'customers' && Object.keys(schema[table]).length > 0,
				),
			),
		);
		expect(hasSourceColumns).toBe(true);

		// customers model has 6 documented columns
		const hasModelColumns = Object.values(mapping).some(db =>
			Object.values(db).some(schema => {
				const cols = schema['customers'];
				return cols && Object.keys(cols).length >= 6;
			}),
		);
		expect(hasModelColumns).toBe(true);
	});
});
