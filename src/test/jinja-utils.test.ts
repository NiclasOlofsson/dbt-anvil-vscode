import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTagRelations } from '../providers/common/jinja-utils';
import { parseTemplated } from '../ftl/sqllens/api';
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

describe('resolveTagRelations', () => {
	let indexer: ManifestIndexer;

	beforeEach(() => {
		indexer = createMockIndexer();
	});

	function relations(input: string): Map<string, string> {
		return resolveTagRelations(input, parseTemplated(input, 'duckdb').tags, indexer);
	}

	it('resolves ref() to alias → unique_id', () => {
		const refs = relations('SELECT * FROM {{ ref(\'stg_customers\') }}');
		expect(refs.get('stg_customers')).toBe('model.project.stg_customers');
	});

	it('resolves ref() with double-quoted argument', () => {
		const refs = relations('SELECT * FROM {{ ref("stg_customers") }}');
		expect(refs.get('stg_customers')).toBe('model.project.stg_customers');
	});

	it('resolves multiple ref() calls', () => {
		const refs = relations([
			'SELECT c.*, o.order_count',
			'FROM {{ ref(\'stg_customers\') }} AS c',
			'JOIN {{ ref(\'stg_orders\') }} AS o ON c.id = o.user_id',
		].join('\n'));
		expect(refs.size).toBe(2);
		expect(refs.get('stg_orders')).toBe('model.project.stg_orders');
	});

	it('resolves source() to identifier → unique_id', () => {
		const refs = relations('SELECT * FROM {{ source(\'jaffle\', \'customers\') }}');
		expect(refs.get('customers')).toBe('source.project.jaffle.customers');
	});

	it('resolves the package-qualified 2-arg ref form (model = last arg)', () => {
		const refs = relations('SELECT * FROM {{ ref(\'other_pkg\', \'stg_customers\') }}');
		expect(refs.get('stg_customers')).toBe('model.project.stg_customers');
	});

	it('skips refs the manifest does not know', () => {
		const refs = relations('SELECT * FROM {{ ref(\'unknown_model\') }}');
		expect(refs.size).toBe(0);
	});

	it('skips sources the manifest does not know', () => {
		const refs = relations('SELECT * FROM {{ source(\'unknown_src\', \'unknown_table\') }}');
		expect(refs.size).toBe(0);
	});

	it('skips a ref inside a SQL line comment (no schema lookup for dead code)', () => {
		const refs = relations([
			'-- FROM {{ ref(\'stg_customers\') }}',
			'SELECT * FROM {{ ref(\'stg_orders\') }}',
		].join('\n'));
		expect(refs.size).toBe(1);
		expect(refs.get('stg_orders')).toBe('model.project.stg_orders');
	});

	it('ignores config / var / control tags entirely', () => {
		const refs = relations([
			'{{ config(materialized=\'table\') }}',
			'{% if target.name == \'prod\' %}',
			'SELECT {{ var(\'my_column\') }} FROM {{ ref(\'stg_customers\') }}',
			'{% endif %}',
		].join('\n'));
		expect(refs.size).toBe(1);
		expect(refs.get('stg_customers')).toBe('model.project.stg_customers');
	});
});
