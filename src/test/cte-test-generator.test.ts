import { describe, it, expect } from 'vitest';
import {
	rowsToSql,
	parseCsvFixture,
	replaceCteWithMock,
	generateModelSql,
	buildTestYaml,
} from '../dbt/cte-test-generator';
import { isPositionInComment } from '../ftl/sql-paren-utils';

// ---------------------------------------------------------------------------
// rowsToSql
// ---------------------------------------------------------------------------
describe('rowsToSql', () => {
	it('returns NULL WHERE FALSE for completely empty input', () => {
		expect(rowsToSql([])).toBe('SELECT NULL WHERE FALSE');
	});

	it('returns empty-set SELECT for empty rows with known columns', () => {
		expect(rowsToSql([], ['id', 'name'])).toBe('SELECT NULL as id, NULL as name WHERE 1=0');
	});

	it('generates SELECT for a single row', () => {
		const result = rowsToSql([{ id: 1, name: 'Alice' }]);
		expect(result).toBe('SELECT 1 as id, \'Alice\' as name');
	});

	it('generates UNION ALL for multiple rows', () => {
		const rows = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
		const result = rowsToSql(rows);
		expect(result).toBe('SELECT 1 as id, \'Alice\' as name\nUNION ALL\nSELECT 2 as id, \'Bob\' as name');
	});

	it('detects numeric strings and emits them without quotes', () => {
		const result = rowsToSql([{ id: '123', amount: '45.67' }]);
		// columns sorted alphabetically: amount, id
		expect(result).toBe('SELECT 45.67 as amount, 123 as id');
	});

	it('emits negative numbers without quotes', () => {
		expect(rowsToSql([{ delta: '-5' }])).toBe('SELECT -5 as delta');
	});

	it('escapes single quotes in string values', () => {
		expect(rowsToSql([{ name: 'O\'Brien' }])).toBe('SELECT \'O\'\'Brien\' as name');
	});

	it('emits NULL for null and undefined values', () => {
		expect(rowsToSql([{ id: 1, name: null }])).toBe('SELECT 1 as id, NULL as name');
		expect(rowsToSql([{ id: 1, name: undefined }])).toBe('SELECT 1 as id, NULL as name');
	});

	it('respects an explicit columns list (order and set)', () => {
		const result = rowsToSql([{ a: 1, b: 2, c: 3 }], ['c', 'a']);
		expect(result).toBe('SELECT 3 as c, 1 as a');
	});

	it('uses sorted union of all row keys when columns is omitted', () => {
		const rows = [{ b: 2 }, { a: 1 }];
		const result = rowsToSql(rows);
		// both rows processed, missing key → NULL
		expect(result).toContain('SELECT NULL as a, 2 as b');
		expect(result).toContain('SELECT 1 as a, NULL as b');
	});
});

// ---------------------------------------------------------------------------
// parseCsvFixture
// ---------------------------------------------------------------------------
describe('parseCsvFixture', () => {
	it('returns empty columns and rows for empty string', () => {
		const r = parseCsvFixture('');
		expect(r.columns).toEqual([]);
		expect(r.rows).toEqual([]);
	});

	it('parses headers-only CSV', () => {
		const r = parseCsvFixture('id,name\n');
		expect(r.columns).toEqual(['id', 'name']);
		expect(r.rows).toHaveLength(0);
	});

	it('parses a two-row CSV', () => {
		const r = parseCsvFixture('id,name\n1,Alice\n2,Bob');
		expect(r.columns).toEqual(['id', 'name']);
		expect(r.rows).toHaveLength(2);
		expect(r.rows[0]).toEqual({ id: '1', name: 'Alice' });
		expect(r.rows[1]).toEqual({ id: '2', name: 'Bob' });
	});

	it('handles quoted fields containing commas', () => {
		const r = parseCsvFixture('name,desc\nAlice,"Hello, world"');
		expect(r.rows[0]).toEqual({ name: 'Alice', desc: 'Hello, world' });
	});

	it('handles doubled-quote escaping inside quoted field', () => {
		const r = parseCsvFixture('name\n"O""Brien"');
		expect(r.rows[0]).toEqual({ name: 'O"Brien' });
	});

	it('ignores blank lines', () => {
		const r = parseCsvFixture('id\n1\n\n2\n');
		expect(r.rows).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// isPositionInComment
// ---------------------------------------------------------------------------
describe('isPositionInComment', () => {
	it('returns false for position outside any comment', () => {
		const sql = 'SELECT * FROM customers';
		expect(isPositionInComment(sql, 7)).toBe(false);
	});

	it('returns true for position inside line comment', () => {
		const sql = 'SELECT * -- this is a comment\nFROM customers';
		expect(isPositionInComment(sql, 20)).toBe(true);
	});

	it('returns false for position on the next line after a line comment', () => {
		const sql = 'SELECT * -- comment\nFROM customers';
		expect(isPositionInComment(sql, 25)).toBe(false);
	});

	it('returns true for position inside block comment', () => {
		const sql = 'SELECT * /* block comment */ FROM';
		expect(isPositionInComment(sql, 15)).toBe(true);
	});

	it('returns false for position after closed block comment', () => {
		const sql = 'SELECT * /* comment */ FROM';
		expect(isPositionInComment(sql, 24)).toBe(false);
	});

	it('returns true for position inside Jinja comment', () => {
		const sql = 'SELECT * {# jinja comment #} FROM';
		expect(isPositionInComment(sql, 15)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// replaceCteWithMock
// ---------------------------------------------------------------------------
describe('replaceCteWithMock', () => {
	const SQL = `
with orders as (
    select * from {{ ref('stg_orders') }}
),

customer_agg as (
    select customer_id, count(*) as order_count
    from orders
    group by customer_id
)

select * from customer_agg`.trim();

	it('replaces the target CTE with a mock SELECT', () => {
		const result = replaceCteWithMock(SQL, 'orders', [{ customer_id: 1, order_id: 100 }]);
		expect(result).toContain('orders AS (');
		expect(result).toContain('SELECT 1 as customer_id, 100 as order_id');
		// Original body should be gone
		expect(result).not.toContain('ref(\'stg_orders\')');
	});

	it('returns original sql when CTE name not found', () => {
		expect(replaceCteWithMock(SQL, 'nonexistent', [])).toBe(SQL);
	});

	it('produces empty-set mock for empty rows', () => {
		const result = replaceCteWithMock(SQL, 'orders', [], ['customer_id', 'order_id']);
		expect(result).toContain('WHERE 1=0');
	});

	it('does not replace CTEs inside comments', () => {
		const withComment = `-- orders as (\n${SQL}`;
		const result = replaceCteWithMock(withComment, 'orders', [{ id: 1 }]);
		// The real CTE should be replaced, not the one in the comment
		expect(result).toContain('orders AS (');
	});

	it('respects explicit column order', () => {
		const result = replaceCteWithMock(SQL, 'orders', [{ customer_id: 1, order_id: 100 }], ['order_id', 'customer_id']);
		expect(result).toContain('SELECT 100 as order_id, 1 as customer_id');
	});
});

// ---------------------------------------------------------------------------
// generateModelSql
// ---------------------------------------------------------------------------
describe('generateModelSql', () => {
	const SQL = `
with stg_orders as (
    select * from {{ ref('stg_orders') }}
),

customer_agg as (
    select customer_id, count(*) as cnt
    from stg_orders
    group by customer_id
)

select * from customer_agg`.trim();

	it('generates sql trimmed at the target CTE with appended SELECT', () => {
		const result = generateModelSql(SQL, 'customer_agg', []);
		expect(result).not.toBeNull();
		expect(result).toContain('-- sqlfluff:disable');
		expect(result).toContain('customer_agg as (');
		expect(result).toContain('select * from customer_agg');
		// Should NOT include the final model SELECT * after customer_agg
	});

	it('returns null when target CTE is not found', () => {
		expect(generateModelSql(SQL, 'nonexistent', [])).toBeNull();
	});

	it('applies :: CTE mocks from testGiven', () => {
		const given = [
			{
				input: '::stg_orders',
				rows: [{ customer_id: 42, order_id: 99 }],
			},
		];
		const result = generateModelSql(SQL, 'customer_agg', given);
		expect(result).not.toBeNull();
		// The stg_orders CTE should be replaced with the mock
		expect(result).toContain('stg_orders AS (');
		expect(result).toContain('SELECT 42 as customer_id, 99 as order_id');
		// The original ref() should be gone
		expect(result).not.toContain('ref(\'stg_orders\')');
	});

	it('applies csv-format CTE mock', () => {
		const given = [
			{
				input: '::stg_orders',
				format: 'csv',
				rows: 'customer_id,order_id\n1,100\n2,200',
			},
		];
		const result = generateModelSql(SQL, 'customer_agg', given);
		expect(result).not.toBeNull();
		// CSV values "1","100" look numeric → rowsToSql emits them without quotes
		expect(result).toContain('SELECT 1 as customer_id, 100 as order_id');
	});
});

// ---------------------------------------------------------------------------
// buildTestYaml
// ---------------------------------------------------------------------------
describe('buildTestYaml', () => {
	const TEST_DATA = {
		version: 2,
		unit_tests: [
			{
				name: 'test_customer_agg',
				model: 'customers::customer_agg',
				config: { cte_test: true },
				given: [
					{ input: 'ref(\'stg_orders\')', rows: [{ customer_id: 1, order_id: 100 }] },
					{ input: '::stg_orders', rows: [] }, // CTE mock — should be filtered out
				],
				expect: { rows: [{ customer_id: 1, cnt: 1 }] },
			},
		],
	};

	const GEN_SQL = '-- sqlfluff:disable\nwith stg_orders as (...)\n\nselect * from customer_agg\n-- uses {{ ref(\'stg_orders\') }}';

	it('returns null when test name is not found', () => {
		expect(buildTestYaml(TEST_DATA, 'nonexistent', 'gen_model', GEN_SQL)).toBeNull();
	});

	it('sets model to genModelName', () => {
		const result = buildTestYaml(TEST_DATA, 'test_customer_agg', 'customers__customer_agg__abc123', GEN_SQL);
		expect(result).not.toBeNull();
		expect(result).toContain('customers__customer_agg__abc123');
	});

	it('filters out :: CTE mock entries from given', () => {
		const result = buildTestYaml(TEST_DATA, 'test_customer_agg', 'gen_model', GEN_SQL);
		expect(result).not.toBeNull();
		expect(result).not.toContain('::stg_orders');
	});

	it('removes config from the output', () => {
		const result = buildTestYaml(TEST_DATA, 'test_customer_agg', 'gen_model', GEN_SQL);
		expect(result).not.toContain('cte_test');
	});

	it('adds empty-row stubs for refs used in sql but missing from given', () => {
		const dataWithoutRef = {
			version: 2,
			unit_tests: [{
				name: 'test_something',
				model: 'customers::customer_agg',
				given: [],
				expect: { rows: [] },
			}],
		};
		const sqlWithRef = 'select * from {{ ref(\'stg_customers\') }}';
		const result = buildTestYaml(dataWithoutRef, 'test_something', 'gen_model', sqlWithRef);
		expect(result).not.toBeNull();
		expect(result).toContain('ref(\'stg_customers\')');
		expect(result).toContain('rows: []');
	});

	it('does not mutate the input testData', () => {
		const original = JSON.parse(JSON.stringify(TEST_DATA));
		buildTestYaml(TEST_DATA, 'test_customer_agg', 'gen_model', GEN_SQL);
		expect(TEST_DATA).toEqual(original);
	});
});
