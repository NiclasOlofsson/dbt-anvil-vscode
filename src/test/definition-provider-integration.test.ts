/**
 * Integration tests for definition-provider alias resolution.
 *
 * Uses the real native FTL parser to parse SQL — no mocked DocumentModels.
 * This suite is the canonical replacement for the unit tests in definition-provider.test.ts
 * which rely on hand-crafted DocumentModels that can drift from what the parser actually emits.
 *
 * What is covered here:
 *   - Parser emitting correct CTE / ref / symbol data for a realistic SQL fixture
 *   - ParseService.symAtPosition / partIndexAtPosition: hit-testing a cursor position
 *     against the Sym stream
 *   - Sym.alias / Sym.source: mapping a relation/column Sym to its alias / source
 *   - DbtDefinitionProvider.provideDefinition: end-to-end navigation from cursor → location
 *
 * What is NOT covered here (known gaps):
 *   - ref('model') / source('x','y') click navigation (handled by regex, not Sym-based;
 *     those code paths are exercised by the regex itself, no Sym positions involved)
 *   - Bare column navigation when the column is NOT schema-resolved (cold describe cache)
 *   - Multi-package ref() returning multiple locations (picker scenario)
 *   - source() alias resolution (no source() calls in the SQL fixture)
 *
 * Does not require a Python environment with dbt — only the FTL SQL parser.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SqllensDocumentParser, type AdapterContext } from '../ftl/sqllens/document-parser';
import { ParseService } from '../services/parse-service';
import type { DocumentModel } from '../services/parse-service';
import type { Sym } from '../ftl/sqllens/api';
import { nameRangeOf, qualifierRangeOf, rangeOfSpan, relationNameRangeOf } from '../providers/sql/sym-spans';
import { DbtDefinitionProvider } from '../providers/sql/definition-provider';
import * as vscode from 'vscode';
import { createMockLogger } from './helpers';

// The SQL under test — mirrors a real warehouse enrichment model.
// Line numbers are 0-based; use SQL.split('\n') to derive positions.
const SQL = `with address_with_country as (
	select *
	from {{ ref('gold__address') }}
),
warehouses_enriched as (
	select
		wh.*,
		addr.street as warehouse_address_street,
		city as warehouse_address_city,
		addr.zipcode as warehouse_address_zipcode,
		addr.countrycode_2char as warehouse_address_country,
		addr.location_description as warehouse_location_description
	from {{ ref('gold__warehouse') }} as wh
	left join address_with_country as addr
		on
			wh.gold_warehousekey = addr.gold_warehousekey
			and addr.isprimaryaddress = true
			and addr.is_current = true
			and addr.is_deleted = false
			and addr.is_valid = true
	where wh.gold_sourcesystemkey = 'd365'
),
raw_orders as (
	select *
	from {{ source('raw', 'orders') }}
)
select * from warehouses_enriched`;

// Column schema for the two refs in SQL — enables the qualifier to resolve bare columns
// (e.g. bare `city` → `addr`) even when they come through a SELECT * chain.
const SQL_SCHEMA: Record<string, Record<string, string>> = {
	gold__address: {
		gold_warehousekey: 'TEXT',
		city: 'TEXT',
		street: 'TEXT',
		zipcode: 'TEXT',
		countrycode_2char: 'TEXT',
		location_description: 'TEXT',
		isprimaryaddress: 'BOOLEAN',
		is_current: 'BOOLEAN',
		is_deleted: 'BOOLEAN',
		is_valid: 'BOOLEAN',
	},
	gold__warehouse: {
		gold_warehousekey: 'TEXT',
		gold_sourcesystemkey: 'TEXT',
	},
};

describe('definition-provider integration (FTL)', () => {
	let model: DocumentModel;

	beforeAll(async () => {
		const parser = new SqllensDocumentParser({ adapterType: 'ansi' } as AdapterContext);
		model = await parser.parse(SQL, { schema: SQL_SCHEMA });
	});

	// ---- DocumentModel structure ----
	//
	// Validates that the parser produces the raw DocumentModel data
	// we depend on. These tests are the contract between the parser output and the
	// rest of the TypeScript code — if they break, something changed in the parser,
	// not in our providers.
	//
	// Coverage:
	//   ✅ CTE names and line spans
	//   ✅ SELECT * CTE column recording
	//   ✅ ref() extraction and alias annotation
	//   ✅ relation Syms with alias line/col positions
	//   ✅ column Syms with qualifier positions (addr.street)
	//   ✅ bare column resolved to table via schema-aware qualification (city → addr)
	//   ✅ column declaration Syms (warehouse_address_street)
	//   ✅ source() relation Sym col/endCol covering the full {{ source('ns','tbl') }} span
	//   ✅ refs entry enriched position fields (modelCol, modelEndCol, jinjaCol, jinjaEndCol)
	//   ✅ sources entry enriched position fields (sourceNameCol/EndCol, tableNameCol/EndCol, jinjaCol/EndCol)
	//
	// Not covered:
	//   ❌ wh.* wildcard expansion into individual column Syms

	describe('DocumentModel structure', () => {
		it('parses three CTEs', () => {
			expect(model.ctes).toHaveLength(3);
			const names = model.ctes.map(c => c.name);
			expect(names).toContain('address_with_country');
			expect(names).toContain('warehouses_enriched');
			expect(names).toContain('raw_orders');
		});

		it('address_with_country CTE has SELECT * column', () => {
			const awc = model.ctes.find(c => c.name === 'address_with_country')!;
			expect(awc).toBeDefined();
			expect(awc.columns.some(c => c.name === '*')).toBe(true);
		});

		it('warehouses_enriched CTE spans the right lines', () => {
			const we = model.ctes.find(c => c.name === 'warehouses_enriched')!;
			expect(we).toBeDefined();
			// Should start on line 4 (0-based) and close on or after line 21
			expect(we.line).toBe(4);
			expect(we.endLine).toBeGreaterThanOrEqual(21);
		});

		it('parses two refs: gold__address and gold__warehouse', () => {
			const refNames = model.refs.map(r => r.model);
			expect(refNames).toContain('gold__address');
			expect(refNames).toContain('gold__warehouse');
		});

		it('gold__address ref has no alias, is on line 2, col 9', () => {
			// Line 2: "\tfrom {{ ref('gold__address') }}"
			// ref( starts after "\tfrom {{ " → col 9
			const addr = model.refs.find(r => r.model === 'gold__address')!;
			expect(addr).toBeDefined();
			expect(addr.alias).toBeUndefined();
			expect(addr.line).toBe(2);
			expect(addr.col).toBe(9);
		});

		it('gold__warehouse ref has alias wh, is on line 12, col 9', () => {
			// Line 12: "\tfrom {{ ref('gold__warehouse') }} as wh"
			// ref( starts after "\tfrom {{ " → col 9
			const wh = model.refs.find(r => r.model === 'gold__warehouse')!;
			expect(wh).toBeDefined();
			expect(wh.alias).toBe('wh');
			expect(wh.line).toBe(12);
			expect(wh.col).toBe(9);
		});

		it('emits a table reference sym for gold__warehouse as wh with alias on line 12', () => {
			// Line 12: "\tfrom {{ ref('gold__warehouse') }} as wh"
			// _blank_jinja replaces {{ ref(...) }} in-place preserving offsets, so
			// 'gold__warehouse' starts at col 6 (the position of the opening {{ ).
			// The Sym's own span extends through a trailing alias when one is
			// written (verified empirically) — it covers the full jinja tag PLUS
			// " as wh", ending where the alias ends (col 40), not where the tag
			// itself ends (col 34).
			const tableSym = (model.symbols ?? []).find(s =>
				s.kind === 'table' && s.modifiers.includes('reference') && s.name === 'gold__warehouse',
			);
			expect(tableSym).toBeDefined();
			const range = rangeOfSpan(tableSym!.span);
			expect(range.start.line).toBe(12);
			expect(range.start.character).toBe(6);
			expect(range.end.character).toBe(40);

			const alias = tableSym!.alias;
			expect(alias).toBeDefined();
			const aliasRange = rangeOfSpan(alias!.span);
			expect(aliasRange.start.line).toBe(12);
			expect(aliasRange.start.character).toBe(38);
			expect(aliasRange.end.character).toBe(38 + 'wh'.length);
		});

		it('emits a table reference sym for gold__address (no alias) on line 2', () => {
			// Line 2: "\tfrom {{ ref('gold__address') }}"
			// col=6: the {{ starts at col 6. endCol covers the full tag = 26 chars.
			// Note: qualification may add an auto-alias equal to the table name; we find by name alone.
			const tableSym = (model.symbols ?? []).find(s =>
				s.kind === 'table' && s.modifiers.includes('reference') && s.name === 'gold__address',
			);
			expect(tableSym).toBeDefined();
			const range = rangeOfSpan(tableSym!.span);
			expect(range.start.line).toBe(2);
			expect(range.start.character).toBe(6);
			expect(range.end.character).toBe(6 + '{{ ref(\'gold__address\') }}'.length); // 32
		});

		it('emits a cte reference sym for address_with_country as addr with alias on line 13', () => {
			// Line 13: "\tleft join address_with_country as addr"
			// address_with_country is a CTE name (not jinja), so col is its literal
			// position. The raw span extends through the trailing alias (col 39,
			// through the end of "addr") — relationNameRangeOf narrows it back to
			// just the CTE name (col 11..32) for consumers that need that.
			const cteSym = (model.symbols ?? []).find(s =>
				s.kind === 'cte' && s.modifiers.includes('reference') && s.name === 'address_with_country',
			);
			expect(cteSym).toBeDefined();
			const range = rangeOfSpan(cteSym!.span);
			expect(range.start.line).toBe(13);
			expect(range.start.character).toBe(11);
			expect(range.end.character).toBe(39);

			const nameRange = relationNameRangeOf(cteSym!);
			expect(nameRange.start.character).toBe(11);
			expect(nameRange.end.character).toBe(11 + 'address_with_country'.length);

			const alias = cteSym!.alias;
			expect(alias).toBeDefined();
			const aliasRange = rangeOfSpan(alias!.span);
			expect(aliasRange.start.line).toBe(13);
			expect(aliasRange.start.character).toBe(35);
			expect(aliasRange.end.character).toBe(35 + 'addr'.length);
		});

		it('emits a column reference sym for addr.street on line 7 with correct col range', () => {
			const colSym = (model.symbols ?? []).find(s =>
				s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'addr.street',
			);
			expect(colSym).toBeDefined();
			const nameRange = nameRangeOf(colSym!);
			expect(nameRange.start.line).toBe(7);
			expect(nameRange.start.character).toBe(7);
			expect(nameRange.end.character).toBe(7 + 'street'.length);

			const qualRange = qualifierRangeOf(colSym!);
			expect(qualRange).toBeDefined();
			expect(qualRange!.start.character).toBe(2);
			expect(qualRange!.end.character).toBe(2 + 'addr'.length);
		});

		it('emits a column reference sym for city on line 8 resolved to table addr', () => {
			const citySym = (model.symbols ?? []).find(s =>
				s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'city' && s.span.line - 1 === 8,
			);
			expect(citySym).toBeDefined();
			const nameRange = nameRangeOf(citySym!);
			expect(nameRange.start.line).toBe(8);
			expect(nameRange.start.character).toBe(2);
			expect(nameRange.end.character).toBe(2 + 'city'.length);

			const resolved = citySym!.source;
			expect(resolved).toBeDefined();
			const alias = resolved!.alias;
			expect(alias?.name).toBe('addr');
		});

		it('emits a column declaration sym for warehouse_address_street alias on line 7', () => {
			const declSym = (model.symbols ?? []).find(s =>
				s.kind === 'column' && s.modifiers.includes('declaration') && s.name === 'warehouse_address_street',
			);
			expect(declSym).toBeDefined();
			// The declaration's own span covers the whole "addr.street as
			// warehouse_address_street" clause — nameRangeOf narrows it to just the alias.
			const range = nameRangeOf(declSym!);
			expect(range.start.line).toBe(7);
			expect(range.start.character).toBe(17);
			expect(range.end.character).toBe(17 + 'warehouse_address_street'.length);
		});

		it('emits a table reference sym for raw_orders source() on line 24', () => {
			// Line 24: "\tfrom {{ source('raw', 'orders') }}"
			// _blank_jinja replaces {{ source('ns', 'tbl') }} with 'tbl' padded to tag length.
			// The parser names a source() relation Sym "sourceName.tableName".
			// _jinja_ref_end now covers source tags too, so endCol spans the full jinja tag.
			const tableSym = (model.symbols ?? []).find(s =>
				s.kind === 'table' && s.modifiers.includes('reference') && s.name === 'raw.orders' && s.span.line - 1 === 24,
			);
			expect(tableSym).toBeDefined();
			const range = rangeOfSpan(tableSym!.span);
			expect(range.start.character).toBe(6);
			expect(range.end.character).toBe(6 + '{{ source(\'raw\', \'orders\') }}'.length); // 35
		});

		it('refs entry for gold__address carries enriched position fields', () => {
			// Line 2: "\tfrom {{ ref('gold__address') }}"
			// jinjaCol=6 (the {{), modelCol=14 (the 'g' of gold__address, after ref(')
			// modelEndCol=27 (exclusive, position of closing '), jinjaEndCol=32
			const ref = model.refs.find(r => r.model === 'gold__address')!;
			expect(ref).toBeDefined();
			expect(ref.jinjaCol).toBe(6);
			expect(ref.jinjaEndCol).toBe(32);
			expect(ref.modelCol).toBe(14);
			expect(ref.modelEndCol).toBe(27);
		});

		it('sources entry for raw.orders carries enriched position fields', () => {
			// Line 24: "\tfrom {{ source('raw', 'orders') }}"
			// jinjaCol=6 ({{), sourceNameCol=17 ('r' of raw), sourceNameEndCol=20 (excl)
			// tableNameCol=24 ('o' of orders), tableNameEndCol=30 (excl), jinjaEndCol=35
			const src = model.sources.find(s => s.sourceName === 'raw' && s.tableName === 'orders')!;
			expect(src).toBeDefined();
			expect(src.jinjaCol).toBe(6);
			expect(src.jinjaEndCol).toBe(35);
			expect(src.sourceNameCol).toBe(17);
			expect(src.sourceNameEndCol).toBe(20);
			expect(src.tableNameCol).toBe(24);
			expect(src.tableNameEndCol).toBe(30);
		});
	});

	// ---- ParseService.symAtPosition ----
	//
	// Tests the hit-testing layer: given a (line, col) cursor position, symAtPosition
	// must return the right Sym (or undefined), and partIndexAtPosition must report
	// which dotted part the cursor sits on. This is the only way the VS Code
	// providers know what the user clicked on.
	//
	// The key correctness invariant: a relation's alias Sym must win over a column's
	// qualifier part, because a bare/qualified column's qualifier span can coincide
	// with the alias keyword position (discovered bug, now fixed, in the old bridge —
	// symAtPosition's specificity-width logic supersedes it).
	//
	// Coverage:
	//   ✅ relation name span → kind 'table'/'cte'
	//   ✅ alias span → kind 'alias' (for both FROM and JOIN aliases)
	//   ✅ column qualifier part → partIndexAtPosition < last index (SELECT list)
	//   ✅ column qualifier part → partIndexAtPosition < last index (ON clause)
	//   ✅ column name part → partIndexAtPosition === last index (ON clause, both sides)
	//   ✅ bare column name span (city on line 8) → resolved via sourceOf
	//   ✅ column declaration span → kind 'column' with 'declaration' modifier
	//   ✅ position outside all syms → undefined
	//
	// Not covered:
	//   (none)

	describe('ParseService.symAtPosition', () => {
		it('resolves address_with_country table name (JOIN, line 13) → cte sym', () => {
			const cteSym = (model.symbols ?? []).find(s =>
				s.kind === 'cte' && s.modifiers.includes('reference') && s.name === 'address_with_country',
			);
			expect(cteSym).toBeDefined();
			const range = rangeOfSpan(cteSym!.span);

			const resolved = ParseService.symAtPosition(model, range.start.line, range.start.character);
			expect(resolved?.kind).toBe('cte');
			expect(resolved?.name).toBe('address_with_country');
		});

		it('resolves addr alias definition (line 13) → alias sym', () => {
			const cteSym = (model.symbols ?? []).find(s => s.kind === 'cte' && s.modifiers.includes('reference') && s.name === 'address_with_country');
			const alias = cteSym!.alias;
			expect(alias).toBeDefined();
			const aliasRange = rangeOfSpan(alias!.span);

			const resolved = ParseService.symAtPosition(model, aliasRange.start.line, aliasRange.start.character);
			expect(resolved?.kind).toBe('alias');
			expect(resolved?.name).toBe('addr');
		});

		it('resolves wh alias definition (line 12) → alias sym', () => {
			const tableSym = (model.symbols ?? []).find(s => s.kind === 'table' && s.modifiers.includes('reference') && s.name === 'gold__warehouse');
			const alias = tableSym!.alias;
			expect(alias).toBeDefined();
			const aliasRange = rangeOfSpan(alias!.span);

			const resolved = ParseService.symAtPosition(model, aliasRange.start.line, aliasRange.start.character);
			expect(resolved?.kind).toBe('alias');
			expect(resolved?.name).toBe('wh');
		});

		it('resolves wh qualifier in wh.gold_warehousekey (ON clause) → qualifier part', () => {
			const whQualCol = findColumnSym(model, 'gold_warehousekey', 15, 'wh');
			expect(whQualCol).toBeDefined();
			const qualRange = qualifierRangeOf(whQualCol!)!;

			const resolved = ParseService.symAtPosition(model, qualRange.start.line, qualRange.start.character);
			expect(resolved?.kind).toBe('column');
			const partIndex = ParseService.partIndexAtPosition(resolved!, qualRange.start.line, qualRange.start.character);
			expect(partIndex).toBeLessThan(resolved!.partSpans!.length - 1);
			const relation = resolved!.source;
			expect(relation!.alias?.name).toBe('wh');
		});

		it('resolves gold_warehousekey column (wh side, ON clause) → name part', () => {
			const whQualCol = findColumnSym(model, 'gold_warehousekey', 15, 'wh');
			expect(whQualCol).toBeDefined();
			const nameRange = nameRangeOf(whQualCol!);

			const resolved = ParseService.symAtPosition(model, nameRange.start.line, nameRange.start.character);
			expect(resolved?.kind).toBe('column');
			const partIndex = ParseService.partIndexAtPosition(resolved!, nameRange.start.line, nameRange.start.character);
			expect(partIndex).toBe(resolved!.partSpans!.length - 1);
			const relation = resolved!.source;
			expect(relation!.alias?.name).toBe('wh');
		});

		it('resolves addr qualifier in addr.gold_warehousekey (ON clause) → qualifier part', () => {
			const addrQualCol = findColumnSym(model, 'gold_warehousekey', 15, 'addr');
			expect(addrQualCol).toBeDefined();
			const qualRange = qualifierRangeOf(addrQualCol!)!;

			const resolved = ParseService.symAtPosition(model, qualRange.start.line, qualRange.start.character);
			expect(resolved?.kind).toBe('column');
			const partIndex = ParseService.partIndexAtPosition(resolved!, qualRange.start.line, qualRange.start.character);
			expect(partIndex).toBeLessThan(resolved!.partSpans!.length - 1);
			const relation = resolved!.source;
			expect(relation!.alias?.name).toBe('addr');
		});

		it('resolves gold_warehousekey column (addr side, ON clause) → name part', () => {
			const addrQualCol = findColumnSym(model, 'gold_warehousekey', 15, 'addr');
			expect(addrQualCol).toBeDefined();
			const nameRange = nameRangeOf(addrQualCol!);

			const resolved = ParseService.symAtPosition(model, nameRange.start.line, nameRange.start.character);
			expect(resolved?.kind).toBe('column');
			const partIndex = ParseService.partIndexAtPosition(resolved!, nameRange.start.line, nameRange.start.character);
			expect(partIndex).toBe(resolved!.partSpans!.length - 1);
			const relation = resolved!.source;
			expect(relation!.alias?.name).toBe('addr');
		});

		it('resolves addr qualifier in addr.street (SELECT list) → qualifier part', () => {
			const streetCol = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'addr.street');
			expect(streetCol).toBeDefined();
			const qualRange = qualifierRangeOf(streetCol!)!;

			const resolved = ParseService.symAtPosition(model, qualRange.start.line, qualRange.start.character);
			expect(resolved?.kind).toBe('column');
			const partIndex = ParseService.partIndexAtPosition(resolved!, qualRange.start.line, qualRange.start.character);
			expect(partIndex).toBeLessThan(resolved!.partSpans!.length - 1);
			const relation = resolved!.source;
			expect(relation!.alias?.name).toBe('addr');
		});

		it('resolves city (bare column, line 8) → column resolved to table addr', () => {
			// city has no qualifier in the source SQL; qualification resolved it to addr.
			const citySym = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'city' && s.span.line - 1 === 8);
			expect(citySym).toBeDefined();
			const nameRange = nameRangeOf(citySym!);

			const resolved = ParseService.symAtPosition(model, nameRange.start.line, nameRange.start.character + 1);
			expect(resolved?.kind).toBe('column');
			const relation = resolved!.source;
			expect(relation!.alias?.name).toBe('addr');
		});

		it('resolves warehouse_address_street column declaration → declaration modifier', () => {
			const declSym = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('declaration') && s.name === 'warehouse_address_street');
			expect(declSym).toBeDefined();
			const nameRange = nameRangeOf(declSym!);

			const resolved = ParseService.symAtPosition(model, nameRange.start.line, nameRange.start.character + 1);
			expect(resolved?.kind).toBe('column');
			expect(resolved?.modifiers.includes('declaration')).toBe(true);
		});

		it('returns undefined for a position outside all syms', () => {
			// Line 3 ("),") falls INSIDE the address_with_country CTE declaration's
			// span (a declaration's span covers the whole multi-line clause, not
			// just its name — see nameRangeOf's doc comment) — no longer a safe
			// "nothing here" position under Sym. Line 26 ("select * from
			// warehouses_enriched"), column 0 (the 's' of the SELECT keyword) is:
			// no Sym starts before the '*' at col 7.
			const resolved = ParseService.symAtPosition(model, 26, 0);
			expect(resolved).toBeUndefined();
		});
	});

	// ---- DbtDefinitionProvider.provideDefinition — end-to-end with real parsed model ----
	//
	// Full round-trip tests: cursor position → provider → vscode.Location (or undefined).
	// The indexer is mocked (no real manifest), so ref() / source() lookups return nothing.
	// The parseService mock returns the real `model` parsed by the parser in beforeAll.
	//
	// Navigation rules under test:
	//   column qualifier   → jump to the alias definition site (same file)
	//   alias definition   → undefined (you are already on the definition)
	//   column declaration → undefined (you are already on the definition)
	//   column (qualified) → follow alias → CTE → find column → navigate to its definition
	//                        if CTE has SELECT *, navigate to the * itself
	//
	// Coverage:
	//   ✅ qualifier 'wh' → alias site on line 12
	//   ✅ qualifier 'addr' → alias site on line 13
	//   ✅ alias definition site 'addr' → undefined
	//   ✅ alias definition site 'wh' → undefined
	//   ✅ column declaration 'warehouse_address_street' → undefined
	//   ✅ qualified column addr.street → SELECT * on line 1 (stays in same file)
	//   ✅ bare column city (schema-resolved to addr) → SELECT * on line 1
	//   ✅ {{ source('raw', 'orders') }} click → navigates to sources.yml (via regex path)
	//
	// Not covered:
	//   ❌ source() via Sym path (a relation Sym currently falls through to _resolveRef;
	//      fixing it requires storing sourceName on the Sym or a second lookup)

	describe('DbtDefinitionProvider.provideDefinition', () => {
		const cancelToken: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

		// makeProvider constructs the real DbtDefinitionProvider with three fake dependencies:
		//   indexer    — stands in for the dbt manifest; findModelsByName returns a path only
		//                when explicitly given one via modelPaths (default: empty → not found).
		//                sourcePaths maps 'ns.tbl' keys to { uid, schemaYml } for source() lookups.
		//   parseService — skips a second parse; returns the real `model` already parsed
		//                  in beforeAll (schema-resolved symbols included).
		//   loader     — only used for projectDir when building file paths.
		// The provider itself and all its internal logic (resolveToken, jumpToCte, etc.) run for real.
		function makeProvider(
			modelPaths: Record<string, string> = {},
			sourcePaths: Record<string, { uid: string; schemaYml: string }> = {},
		) {
			const indexer = {
				index: {
					adapterType: 'duckdb',
					models: new Map(),
					sources: new Map(Object.values(sourcePaths).map(v => [v.uid, {}])),
					macros: new Map(),
					nodesByName: new Map(Object.entries(sourcePaths).map(([key, v]) => [key, [v.uid]])),
				},
				findModelsByName: (name: string) => {
					const p = modelPaths[name];
					return p ? [{ path: p }] : [];
				},
				findSourceByKey: (sourceName: string, tableName: string) => {
					const key = `${sourceName}.${tableName}`;
					const entry = sourcePaths[key];
					return entry ? { uid: entry.uid, source: {} } : undefined;
				},
				getRawNode: (uid: string) => {
					const entry = Object.values(sourcePaths).find(v => v.uid === uid);
					return entry ? { original_file_path: entry.schemaYml } : null;
				},
				getColumns: () => null,
				setColumns: vi.fn(),
				buildSchemaMapping: () => ({}),
			};
			const parseService = {
				getDocumentModel: vi.fn().mockResolvedValue(model),
				evict: vi.fn(),
			};
			const loader = { projectDir: '/project' };
			return new DbtDefinitionProvider(indexer as never, loader as never, createMockLogger(), parseService as never);
		}

		// makeDoc fakes a vscode.TextDocument — the VS Code document API is not available
		// outside the extension host, so we provide just the methods provideDefinition uses:
		// lineAt() for reading line text, uri for constructing Locations, and getText() for
		// the SQL content. The fileName is arbitrary but .sql so languageId matches.
		function makeDoc() {
			const lines = SQL.split('\n');
			return {
				languageId: 'jinja-sql',
				fileName: '/project/models/mart.sql',
				getText: () => SQL,
				lineAt: (n: number) => ({ text: lines[n] ?? '', range: new vscode.Range(n, 0, n, (lines[n] ?? '').length) }),
				positionAt: () => new vscode.Position(0, 0),
				getWordRangeAtPosition: () => undefined,
				lineCount: lines.length,
				uri: vscode.Uri.file('/project/models/mart.sql'),
				version: 1,
			} as unknown as vscode.TextDocument;
		}

		it('wh qualifier → alias site of wh definition (line 12)', async () => {
			const doc = makeDoc();
			const whQualCol = findColumnSym(model, 'gold_warehousekey', 15, 'wh')!;
			expect(whQualCol).toBeDefined();
			const qualRange = qualifierRangeOf(whQualCol)!;

			const tableSym = (model.symbols ?? []).find(s => s.kind === 'table' && s.modifiers.includes('reference') && s.name === 'gold__warehouse')!;
			const whAlias = tableSym.alias!;

			// click on the qualifier part (the 'wh' before the dot)
			const result = await makeProvider().provideDefinition(doc, new vscode.Position(qualRange.start.line, qualRange.start.character + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(rangeOfSpan(whAlias.span).start.line);
		});

		it('addr qualifier → alias site of addr definition (line 13)', async () => {
			const doc = makeDoc();
			const addrQualCol = findColumnSym(model, 'gold_warehousekey', 15, 'addr')!;
			expect(addrQualCol).toBeDefined();
			const qualRange = qualifierRangeOf(addrQualCol)!;

			const cteSym = (model.symbols ?? []).find(s => s.kind === 'cte' && s.modifiers.includes('reference') && s.name === 'address_with_country')!;
			const addrAlias = cteSym.alias!;

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(qualRange.start.line, qualRange.start.character + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(rangeOfSpan(addrAlias.span).start.line);
		});

		it('clicking on addr alias definition → undefined (no ctrl+click on definition site)', async () => {
			const doc = makeDoc();
			const cteSym = (model.symbols ?? []).find(s => s.kind === 'cte' && s.modifiers.includes('reference') && s.name === 'address_with_country')!;
			const addrAlias = cteSym.alias!;
			expect(addrAlias).toBeDefined();
			const aliasRange = rangeOfSpan(addrAlias.span);

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(aliasRange.start.line, aliasRange.start.character + 1), cancelToken);

			expect(result).toBeUndefined();
		});

		it('clicking on wh alias definition (FROM driver) → undefined (no ctrl+click on definition site)', async () => {
			const doc = makeDoc();
			const tableSym = (model.symbols ?? []).find(s => s.kind === 'table' && s.modifiers.includes('reference') && s.name === 'gold__warehouse')!;
			const whAlias = tableSym.alias!;
			expect(whAlias).toBeDefined();
			const aliasRange = rangeOfSpan(whAlias.span);

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(aliasRange.start.line, aliasRange.start.character + 1), cancelToken);

			expect(result).toBeUndefined();
		});

		it('clicking on warehouse_address_street column alias → undefined (definition site)', async () => {
			const doc = makeDoc();
			const declSym = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('declaration') && s.name === 'warehouse_address_street')!;
			expect(declSym).toBeDefined();
			const nameRange = nameRangeOf(declSym);

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(nameRange.start.line, nameRange.start.character + 1), cancelToken);

			expect(result).toBeUndefined();
		});

		it('addr.street → * on line 1 in the current file (not gold__address)', async () => {
			// Line 7: "\t\taddr.street as warehouse_address_street,"
			// addr is a CTE alias for address_with_country which does SELECT *
			// Correct: navigate to the * on line 1, stay in the current file
			const doc = makeDoc();
			const streetSym = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'addr.street')!;
			expect(streetSym).toBeDefined();
			const nameRange = nameRangeOf(streetSym);

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(nameRange.start.line, nameRange.start.character + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(1); // line 1: "\tselect *"
		});

		it('clicking on {{ ref(\'gold__warehouse\') }} → resolves to model file path', async () => {
			// Line 12: "\tfrom {{ ref('gold__warehouse') }} as wh"
			// Click anywhere inside the jinja tag — the relation Sym now spans the full tag.
			// Indexer is given a fake model path so _resolveRef returns a Location.
			const doc = makeDoc();
			const tableSym = (model.symbols ?? []).find(s => s.kind === 'table' && s.modifiers.includes('reference') && s.name === 'gold__warehouse')!;
			expect(tableSym).toBeDefined();
			const range = rangeOfSpan(tableSym.span);

			const fakeModelPath = '/project/models/gold__warehouse.sql';
			// Click in the middle of the jinja tag span
			const clickCol = Math.floor((range.start.character + range.end.character) / 2);
			const result = await makeProvider({ gold__warehouse: fakeModelPath })
				.provideDefinition(doc, new vscode.Position(range.start.line, clickCol), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('gold__warehouse');
			expect(loc.range.start.line).toBe(0);
		});

		it('clicking on address_with_country in JOIN → jumps to CTE definition (line 0)', async () => {
			// Line 13: "\tleft join address_with_country as addr"
			// address_with_country is a CTE — _jumpToCte should navigate to line 0.
			const doc = makeDoc();
			const cteSym = (model.symbols ?? []).find(s => s.kind === 'cte' && s.modifiers.includes('reference') && s.name === 'address_with_country')!;
			expect(cteSym).toBeDefined();
			const range = rangeOfSpan(cteSym.span);

			const result = await makeProvider()
				.provideDefinition(doc, new vscode.Position(range.start.line, range.start.character + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(0); // CTE is defined at line 0
		});

		it('city (bare column, schema-resolved to addr) → SELECT * on line 1', async () => {
			// Line 8: "\t\tcity as warehouse_address_city," — city has no qualifier in the
			// source SQL, but qualification resolved it to addr. symAtPosition returns
			// kind: 'column' (no qualifier part), then _jumpToColumn follows addr →
			// CTE address_with_country → SELECT * on line 1. Same destination as addr.street.
			const doc = makeDoc();
			const citySym = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'city' && s.span.line - 1 === 8)!;
			expect(citySym).toBeDefined();
			const nameRange = nameRangeOf(citySym);

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(nameRange.start.line, nameRange.start.character + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(1); // SELECT * on line 1
		});
	});
});

/** Find a column reference Sym by bare name, 0-based line, and qualifier text. */
function findColumnSym(model: DocumentModel, bareName: string, line: number, qualifier: string): Sym | undefined {
	return (model.symbols ?? []).find(s =>
		s.kind === 'column'
		&& s.modifiers.includes('reference')
		&& s.name === `${qualifier}.${bareName}`
		&& s.span.line - 1 === line,
	);
}
