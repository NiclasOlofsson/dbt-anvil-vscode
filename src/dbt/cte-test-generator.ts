/**
 * CTE test generator — TypeScript port of bridge.py's _cte_* functions.
 *
 * All functions here are pure (no file I/O), making them straightforward to
 * unit-test. File I/O and dbt execution live in cte-test-runner.ts.
 */

import * as yaml from 'js-yaml';
import { findCteDef, findMatchingParen, isPositionInComment } from '../ftl/sql-paren-utils';

// Re-export helpers that tests need to import from one place.
export { isPositionInComment };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FixtureRow = Record<string, string | number | null | undefined>;

export interface GivenItem {
	input: string;
	format?: string;
	rows?: FixtureRow[] | string;
	columns?: string[];
	[key: string]: unknown;
}

export interface UnitTestEntry {
	name: string;
	model: string;
	given?: GivenItem[];
	expect?: unknown;
	config?: unknown;
	[key: string]: unknown;
}

export interface UnitTestFile {
	version?: number;
	unit_tests?: UnitTestEntry[];
}

// ---------------------------------------------------------------------------
// rowsToSql
// ---------------------------------------------------------------------------

/**
 * Convert a list of row dicts to a SQL VALUES expression (SELECT … UNION ALL …).
 * Mirrors Python's `_cte_rows_to_sql`.
 */
export function rowsToSql(rows: FixtureRow[], columns?: string[]): string {
	let cols = columns;
	if (cols === undefined) {
		const colSet = new Set<string>();
		for (const row of rows) {
			for (const k of Object.keys(row)) colSet.add(k);
		}
		cols = [...colSet].sort();
	}

	if (cols.length === 0) return 'SELECT NULL WHERE FALSE';

	if (rows.length === 0) {
		const nullExprs = cols.map(c => `NULL as ${c}`);
		return `SELECT ${nullExprs.join(', ')} WHERE 1=0`;
	}

	const selects: string[] = [];
	for (const row of rows) {
		const exprs: string[] = [];
		for (const col of cols) {
			const v = row[col];
			if (v === null || v === undefined) {
				exprs.push(`NULL as ${col}`);
			} else if (typeof v === 'number') {
				exprs.push(`${v} as ${col}`);
			} else {
				const s = String(v);
				if (isNumericString(s)) {
					exprs.push(`${s} as ${col}`);
				} else {
					const escaped = s.replace(/'/g, '\'\'');
					exprs.push(`'${escaped}' as ${col}`);
				}
			}
		}
		selects.push(`SELECT ${exprs.join(', ')}`);
	}

	return selects.join('\nUNION ALL\n');
}

/** Match Python's numeric-string detection: v.isdigit() or removing one dot+dash leaves all digits. */
function isNumericString(v: string): boolean {
	if (/^\d+$/.test(v)) return true;
	const stripped = v.replace('.', '').replace('-', '');
	return stripped.length > 0 && /^\d+$/.test(stripped);
}

// ---------------------------------------------------------------------------
// parseCsvFixture
// ---------------------------------------------------------------------------

/**
 * Parse a CSV fixture string into `{ columns, rows }`.
 * Mirrors Python's `_cte_parse_csv_fixture` (uses csv.DictReader semantics).
 */
export function parseCsvFixture(csvText: string): { columns: string[]; rows: FixtureRow[] } {
	const lines = csvText
		.split('\n')
		.map(l => l.trimEnd())
		.filter(l => l.trim() !== '');

	if (lines.length === 0) return { columns: [], rows: [] };

	const columns = parseCsvLine(lines[0]);
	const rows: FixtureRow[] = [];

	for (let i = 1; i < lines.length; i++) {
		const values = parseCsvLine(lines[i]);
		const row: FixtureRow = {};
		for (let j = 0; j < columns.length; j++) {
			row[columns[j]] = values[j] ?? null;
		}
		rows.push(row);
	}

	return { columns, rows };
}

/** Parse a single CSV line, handling double-quote escaping and commas inside quotes. */
function parseCsvLine(line: string): string[] {
	const fields: string[] = [];
	let i = 0;
	while (i <= line.length) {
		if (i === line.length) {
			fields.push('');
			break;
		}
		if (line[i] === '"') {
			// Quoted field
			i++;
			let field = '';
			while (i < line.length) {
				if (line[i] === '"' && line[i + 1] === '"') {
					field += '"';
					i += 2;
				} else if (line[i] === '"') {
					i++;
					break;
				} else {
					field += line[i++];
				}
			}
			fields.push(field);
			// Skip comma after closing quote
			if (line[i] === ',') i++;
		} else {
			// Unquoted field
			const end = line.indexOf(',', i);
			if (end === -1) {
				fields.push(line.slice(i));
				break;
			}
			fields.push(line.slice(i, end));
			i = end + 1;
		}
	}
	return fields;
}

// ---------------------------------------------------------------------------
// replaceCteWithMock
// ---------------------------------------------------------------------------

/**
 * Replace a CTE definition body with a mock SELECT built from fixture rows.
 * Mirrors Python's `_cte_replace_cte_with_mock`.
 */
export function replaceCteWithMock(
	sql: string,
	cteName: string,
	rows: FixtureRow[],
	columns?: string[],
): string {
	const def = findCteDef(sql, cteName);
	if (!def) return sql;

	const closePos = findMatchingParen(sql, def.parenPos);
	if (closePos < 0) return sql;

	const mockSql = rowsToSql(rows, columns);
	const mocked = `${cteName} AS (\n    ${mockSql}\n)`;
	const original = sql.slice(def.matchStart, closePos);
	return sql.replace(original, mocked);
}

// ---------------------------------------------------------------------------
// generateModelSql
// ---------------------------------------------------------------------------

/**
 * Generate trimmed model SQL that selects from the target CTE, applying any
 * upstream CTE mocks specified in `testGiven`.
 * Mirrors Python's `_cte_generate_model` (pure, no file I/O).
 * Returns null when the CTE cannot be found.
 */
export function generateModelSql(
	rawSql: string,
	cteName: string,
	testGiven: GivenItem[],
): string | null {
	const def = findCteDef(rawSql, cteName);
	if (!def) return null;

	const closePos = findMatchingParen(rawSql, def.parenPos);
	if (closePos < 0) return null;

	let upstreamSql = rawSql.slice(0, closePos).trimEnd();

	// Apply upstream CTE mocks (:: prefix means "mock this CTE")
	for (const given of testGiven) {
		const inp = given.input;
		if (typeof inp === 'string' && inp.startsWith('::')) {
			const mockCteName = inp.slice(2);
			const fmt = given.format ?? 'dict';
			let mockColumns: string[] | undefined;
			let mockRows: FixtureRow[];
			if (fmt === 'csv') {
				const parsed = parseCsvFixture(typeof given.rows === 'string' ? given.rows : '');
				mockColumns = parsed.columns;
				mockRows = parsed.rows;
			} else {
				mockColumns = given.columns;
				mockRows = Array.isArray(given.rows) ? given.rows : [];
			}
			upstreamSql = replaceCteWithMock(upstreamSql, mockCteName, mockRows, mockColumns);
		}
	}

	const generated = `${upstreamSql}\n\nselect * from ${cteName}`;
	return `-- sqlfluff:disable\n${generated}`;
}

// ---------------------------------------------------------------------------
// buildTestYaml
// ---------------------------------------------------------------------------

/**
 * Build the unit-test YAML for a generated CTE model.
 * Filters `given` to only refs/sources actually referenced in `generatedSql`.
 * Mirrors Python's `_cte_generate_test` (pure, no file I/O).
 * Returns null when testName cannot be found.
 */
export function buildTestYaml(
	testData: UnitTestFile,
	testName: string,
	genModelName: string,
	generatedSql: string,
): string | null {
	const original = testData.unit_tests?.find(t => t.name === testName);
	if (!original) return null;

	// Deep-clone to avoid mutating caller's data
	const target = JSON.parse(JSON.stringify(original)) as UnitTestEntry;

	// Collect refs / sources actually used in the generated SQL
	const actuallyUsed = new Set<string>();
	for (const [, refName] of generatedSql.matchAll(/ref\(['"](\w+)['"]\)/g)) {
		actuallyUsed.add(`ref('${refName}')`);
	}
	for (const [, ns, tbl] of generatedSql.matchAll(/source\(['"](\w+)['"]\s*,\s*['"](\w+)['"]\)/g)) {
		actuallyUsed.add(`source('${ns}', '${tbl}')`);
	}

	// Filter given to only refs/sources (drops :: CTE mock entries)
	const cleanGiven: GivenItem[] = (target.given ?? []).filter(g =>
		actuallyUsed.has(g.input),
	);
	target.given = cleanGiven;

	// Add empty-row stubs for any ref/source not already in given
	const existingInputs = new Set(cleanGiven.map(g => g.input));
	for (const input of actuallyUsed) {
		if (!existingInputs.has(input)) {
			target.given.push({ input, rows: [] });
		}
	}

	target.model = genModelName;
	delete target.config;

	const output: UnitTestFile = { version: 2, unit_tests: [target] };
	return yaml.dump(output, { lineWidth: 120, noRefs: true });
}
