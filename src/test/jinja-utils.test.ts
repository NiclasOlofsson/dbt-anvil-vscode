import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripJinja } from '../providers/jinja-utils';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ManifestIndex } from '../indexing/manifest-indexer';

function createMockIndexer(overrides?: Partial<ManifestIndexer>): ManifestIndexer {
	const defaultSources = new Map([
		['source.project.jaffle.customers', {
			uniqueId: 'source.project.jaffle.customers',
			name: 'customers',
			sourceName: 'jaffle',
			schema: 'raw',
			tags: [],
		}],
		['source.project.jaffle.orders', {
			uniqueId: 'source.project.jaffle.orders',
			name: 'orders',
			sourceName: 'jaffle',
			schema: 'raw',
			tags: [],
		}],
	]);

	const mockIndex: ManifestIndex = {
		models: new Map(),
		sources: defaultSources as unknown as ManifestIndex['sources'],
		macros: new Map(),
		nodesByName: new Map(),
		parentMap: new Map(),
		childMap: new Map(),
		dbtVersion: '1.8.0',
		adapterType: 'duckdb',
		buildTime: new Date(),
	};

	return {
		index: mockIndex,
		findModelsByName: vi.fn((name: string) => {
			if (name === 'stg_customers') {
				return [{ uniqueId: 'model.project.stg_customers', name: 'stg_customers' }];
			}
			if (name === 'stg_orders') {
				return [{ uniqueId: 'model.project.stg_orders', name: 'stg_orders' }];
			}
			return [];
		}),
		getRawNode: vi.fn((id: string) => {
			if (id === 'model.project.stg_customers') {
				return { name: 'stg_customers', alias: 'stg_customers', schema: 'main' };
			}
			if (id === 'model.project.stg_orders') {
				return { name: 'stg_orders', alias: 'stg_orders', schema: 'main' };
			}
			if (id === 'source.project.jaffle.customers') {
				return { name: 'customers', identifier: 'customers', schema: 'raw' };
			}
			if (id === 'source.project.jaffle.orders') {
				return { name: 'orders', identifier: 'orders', schema: 'raw' };
			}
			return undefined;
		}),
		...overrides,
	} as unknown as ManifestIndexer;
}

describe('stripJinja', () => {
	let indexer: ManifestIndexer;

	beforeEach(() => {
		indexer = createMockIndexer();
	});

	it('should replace ref() with schema.table', () => {
		const input = 'SELECT * FROM {{ ref(\'stg_customers\') }}';
		const result = stripJinja(input, indexer);

		expect(result.sql).toBe('SELECT * FROM main.stg_customers');
		expect(result.refs.get('stg_customers')).toBe('model.project.stg_customers');
	});

	it('should replace multiple ref() calls', () => {
		const input = [
			'SELECT c.*, o.order_count',
			'FROM {{ ref(\'stg_customers\') }} AS c',
			'JOIN {{ ref(\'stg_orders\') }} AS o ON c.id = o.user_id',
		].join('\n');

		const result = stripJinja(input, indexer);

		expect(result.sql).toContain('FROM main.stg_customers AS c');
		expect(result.sql).toContain('JOIN main.stg_orders AS o');
		expect(result.refs.size).toBe(2);
	});

	it('should replace source() with schema.identifier', () => {
		const input = 'SELECT * FROM {{ source(\'jaffle\', \'customers\') }}';
		const result = stripJinja(input, indexer);

		expect(result.sql).toBe('SELECT * FROM raw.customers');
		expect(result.refs.get('customers')).toBe('source.project.jaffle.customers');
	});

	it('should remove config() blocks', () => {
		const input = [
			'{{ config(materialized=\'table\', tags=[\'daily\']) }}',
			'SELECT * FROM main.customers',
		].join('\n');

		const result = stripJinja(input, indexer);

		expect(result.sql).toBe('SELECT * FROM main.customers');
	});

	it('should remove Jinja block tags', () => {
		const input = [
			'SELECT',
			'  {% if target.name == \'prod\' %}',
			'  col_a,',
			'  {% else %}',
			'  col_b,',
			'  {% endif %}',
			'  col_c',
			'FROM my_table',
		].join('\n');

		const result = stripJinja(input, indexer);

		expect(result.sql).toContain('col_a');
		expect(result.sql).toContain('col_b');
		expect(result.sql).toContain('col_c');
		expect(result.sql).not.toContain('{%');
	});

	it('should remove remaining {{ expressions }}', () => {
		const input = 'SELECT {{ var(\'my_column\') }} FROM my_table';
		const result = stripJinja(input, indexer);

		expect(result.sql).toBe('SELECT  FROM my_table');
		expect(result.sql).not.toContain('{{');
	});

	it('should handle package-qualified ref()', () => {
		const input = 'SELECT * FROM {{ ref(\'other_pkg\', \'stg_customers\') }}';
		const result = stripJinja(input, indexer);

		expect(result.sql).toBe('SELECT * FROM main.stg_customers');
	});

	it('should fall back to model name for unknown refs', () => {
		const input = 'SELECT * FROM {{ ref(\'unknown_model\') }}';
		const result = stripJinja(input, indexer);

		expect(result.sql).toBe('SELECT * FROM unknown_model');
		expect(result.refs.size).toBe(0);
	});

	it('should fall back to table name for unknown sources', () => {
		const input = 'SELECT * FROM {{ source(\'unknown_src\', \'unknown_table\') }}';
		const result = stripJinja(input, indexer);

		expect(result.sql).toBe('SELECT * FROM unknown_table');
	});

	it('should handle multiline config blocks', () => {
		const input = [
			'{{ config(',
			'    materialized=\'table\',',
			'    tags=[\'daily\']',
			') }}',
			'SELECT 1',
		].join('\n');

		const result = stripJinja(input, indexer);

		expect(result.sql).toBe('SELECT 1');
	});

	it('should handle mixed ref/source/config in one file', () => {
		const input = [
			'{{ config(materialized=\'view\') }}',
			'',
			'WITH customers AS (',
			'    SELECT * FROM {{ source(\'jaffle\', \'customers\') }}',
			'),',
			'orders AS (',
			'    SELECT * FROM {{ ref(\'stg_orders\') }}',
			')',
			'SELECT c.*, o.status',
			'FROM customers AS c',
			'JOIN orders AS o ON c.id = o.user_id',
		].join('\n');

		const result = stripJinja(input, indexer);

		expect(result.sql).toContain('FROM raw.customers');
		expect(result.sql).toContain('FROM main.stg_orders');
		expect(result.sql).not.toContain('{{');
		expect(result.refs.size).toBe(2);
	});
});
