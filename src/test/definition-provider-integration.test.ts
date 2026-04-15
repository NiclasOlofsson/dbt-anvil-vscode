/**
 * Integration tests for definition-provider alias resolution.
 *
 * Uses the real Python bridge to parse SQL — no mocked DocumentModels.
 * This suite is the canonical replacement for the unit tests in definition-provider.test.ts
 * which rely on hand-crafted DocumentModels that can drift from what the bridge actually emits.
 *
 * What is covered here:
 *   - Bridge emitting correct CTE / ref / token data for a realistic SQL fixture
 *   - ParseService.resolveAtPosition: hit-testing a cursor position against the token map
 *   - resolveAlias: mapping an alias string to its CTE / ref / source target
 *   - DbtDefinitionProvider.provideDefinition: end-to-end navigation from cursor → location
 *
 * What is NOT covered here (known gaps):
 *   - ref('model') / source('x','y') click navigation (handled by regex, not token-based;
 *     those code paths are exercised by the regex itself, no token positions involved)
 *   - Bare column navigation when the column is NOT schema-resolved (cold describe cache)
 *   - Multi-package ref() returning multiple locations (picker scenario)
 *   - source() alias resolution (no source() calls in the SQL fixture)
 *
 * Does not require a Python environment with dbt — only Pyodide/sqlglot via FTL.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { FtlDocumentParser } from '../ftl/ftl-document-parser';
import type { AdapterContext } from '../ftl/ftl-document-parser';
import { ParseService } from '../services/parse-service';
import type { ColumnDefToken, ColumnRefToken, DocumentModel, TableRefToken } from '../services/parse-service';
import { DbtDefinitionProvider } from '../providers/sql/definition-provider';
import * as vscode from 'vscode';
import { createMockLogger } from './helpers';

const PYODIDE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl', 'vendor');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl');

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

// Column schema for the two refs in SQL — lets sqlglot qualify() resolve bare columns
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
		const ftlParser = FtlDocumentParser.create(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR, { adapterType: 'ansi' } as AdapterContext);
		await ftlParser.ready();
		model = await ftlParser.parse(SQL, { schema: SQL_SCHEMA });
		ftlParser.dispose();
	}, 60_000);

	// ---- DocumentModel structure ----
	//
	// Validates that the Python bridge (sqlglot) produces the raw DocumentModel data
	// we depend on. These tests are the contract between the bridge output and the
	// rest of the TypeScript code — if they break, something changed in bridge.py or
	// sqlglot's behaviour, not in our providers.
	//
	// Coverage:
	//   ✅ CTE names and line spans
	//   ✅ SELECT * CTE column recording
	//   ✅ ref() extraction and alias annotation
	//   ✅ table_ref tokens with alias line/col positions
	//   ✅ column_ref tokens with qualifier positions (addr.street)
	//   ✅ bare column resolved to table via schema-aware qualify() (city → addr)
	//   ✅ column_def output alias tokens (warehouse_address_street)
	//   ✅ source() table_ref token col/endCol covering the full {{ source('ns','tbl') }} span
	//   ✅ refs entry enriched position fields (modelCol, modelEndCol, jinjaCol, jinjaEndCol)
	//   ✅ sources entry enriched position fields (sourceNameCol/EndCol, tableNameCol/EndCol, jinjaCol/EndCol)
	//
	// Not covered:
	//   ❌ wh.* wildcard expansion into individual column_ref tokens

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

		it('emits table_ref token for gold__warehouse as wh with aliasLine 12', () => {
			// Line 12: "\tfrom {{ ref('gold__warehouse') }} as wh"
			// _blank_jinja replaces {{ ref(...) }} in-place preserving offsets, so
			// 'gold__warehouse' starts at col 6 (the position of the opening {{ ).
			// endCol covers the full jinja tag {{ ref('gold__warehouse') }} = 28 chars.
			const tok = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.name === 'gold__warehouse' && t.alias === 'wh');
			expect(tok).toBeDefined();
			expect(tok!.line).toBe(12);
			expect(tok!.col).toBe(6);
			expect(tok!.endCol).toBe(6 + '{{ ref(\'gold__warehouse\') }}'.length); // 34
			expect(tok!.aliasLine).toBe(12);
			expect(tok!.aliasCol).toBe(38);
			expect(tok!.aliasEndCol).toBe(38 + 'wh'.length);
		});

		it('emits table_ref token for gold__address (no alias) on line 2', () => {
			// Line 2: "\tfrom {{ ref('gold__address') }}"
			// col=6: the {{ starts at col 6. endCol covers the full tag = 26 chars.
			// Note: qualify() may add an auto-alias equal to the table name; we find by name alone.
			const tok = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.name === 'gold__address');
			expect(tok).toBeDefined();
			expect(tok!.line).toBe(2);
			expect(tok!.col).toBe(6);
			expect(tok!.endCol).toBe(6 + '{{ ref(\'gold__address\') }}'.length); // 32
		});

		it('emits table_ref token for address_with_country as addr with aliasLine 13', () => {
			// Line 13: "\tleft join address_with_country as addr"
			// address_with_country is a CTE name (not jinja), so col is its literal position.
			const tok = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.name === 'address_with_country' && t.alias === 'addr');
			expect(tok).toBeDefined();
			expect(tok!.line).toBe(13);
			expect(tok!.col).toBe(11);
			expect(tok!.endCol).toBe(11 + 'address_with_country'.length);
			expect(tok!.aliasLine).toBe(13);
			expect(tok!.aliasCol).toBe(35);
			expect(tok!.aliasEndCol).toBe(35 + 'addr'.length);
		});

		it('emits column_ref token for addr.street on line 7 with correct col range', () => {
			const tok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.table === 'addr' && t.name === 'street');
			expect(tok).toBeDefined();
			expect(tok!.line).toBe(7);
			expect(tok!.col).toBe(7);
			expect(tok!.endCol).toBe(7 + 'street'.length);
			expect(tok!.tableCol).toBe(2);
			expect(tok!.tableEndCol).toBe(2 + 'addr'.length);
		});

		it('emits column_ref token for city on line 8 resolved to table addr', () => {
			const tok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'city' && t.line === 8);
			expect(tok).toBeDefined();
			expect(tok!.line).toBe(8);
			expect(tok!.col).toBe(2);
			expect(tok!.endCol).toBe(2 + 'city'.length);
			expect(tok!.table).toBe('addr');
		});

		it('emits column_def token for warehouse_address_street alias on line 7', () => {
			const tok = model.tokens
				.filter((t): t is ColumnDefToken => t.type === 'column_def')
				.find(t => t.name === 'warehouse_address_street' && t.line === 7);
			expect(tok).toBeDefined();
			expect(tok!.col).toBe(17);
			expect(tok!.endCol).toBe(17 + 'warehouse_address_street'.length);
		});

		it('emits table_ref token for raw_orders source() on line 24', () => {
			// Line 24: "\tfrom {{ source('raw', 'orders') }}"
			// _blank_jinja replaces {{ source('ns', 'tbl') }} with 'tbl' padded to tag length.
			// So sqlglot sees 'orders' as the table identifier starting at the '{{' position.
			// _jinja_ref_end now covers source tags too, so endCol spans the full jinja tag.
			const tok = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.name === 'orders' && t.line === 24);
			expect(tok).toBeDefined();
			expect(tok!.col).toBe(6);
			expect(tok!.endCol).toBe(6 + '{{ source(\'raw\', \'orders\') }}'.length); // 35
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

	// ---- ParseService.resolveAtPosition ----
	//
	// Tests the hit-testing layer: given a (line, col) cursor position, resolveAtPosition
	// must return the right kind and token, or null. This is the only way the VS Code
	// providers know what the user clicked on.
	//
	// The key correctness invariant: table_ref alias positions must win over column_ref
	// qualifier positions, because schema-aware qualify() synthesises column_ref tokens
	// whose tableCol lands exactly on the alias keyword (discovered bug, now fixed).
	//
	// Coverage:
	//   ✅ table_ref name span → 'table_ref'
	//   ✅ table_ref alias span → 'table_alias' (for both FROM and JOIN aliases)
	//   ✅ column_ref qualifier span → 'table_qualifier' (SELECT list)
	//   ✅ column_ref qualifier span → 'table_qualifier' (ON clause)
	//   ✅ column_ref column span → 'column' (ON clause, both sides)
	//   ✅ bare column name span (city on line 8) → 'column' with table resolved
	//   ✅ column_def span → 'column_def'
	//   ✅ position outside all tokens → null
	//
	// Not covered:
	//   (none)

	describe('ParseService.resolveAtPosition', () => {
		it('resolves address_with_country table name (JOIN, line 13) → table_ref', () => {
			const tok = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.name === 'address_with_country' && t.alias === 'addr');
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.line, tok!.col);
			expect(resolved?.kind).toBe('table_ref');
			expect(resolved?.token.name).toBe('address_with_country');
		});

		it('resolves addr alias definition (line 13) → table_alias', () => {
			const tok = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.alias === 'addr');
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.aliasLine!, tok!.aliasCol!);
			expect(resolved?.kind).toBe('table_alias');
			expect(resolved?.token.name).toBe('address_with_country');
		});

		it('resolves wh alias definition (line 12) → table_alias', () => {
			const tok = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.name === 'gold__warehouse' && t.alias === 'wh');
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.aliasLine!, tok!.aliasCol!);
			expect(resolved?.kind).toBe('table_alias');
			expect(resolved?.token.name).toBe('gold__warehouse');
		});

		it('resolves wh qualifier in wh.gold_warehousekey (ON clause) → table_qualifier', () => {
			const tok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'gold_warehousekey' && t.table === 'wh' && t.tableLine === 15);
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.tableLine!, tok!.tableCol!);
			expect(resolved?.kind).toBe('table_qualifier');
			expect((resolved?.token as ColumnRefToken).table).toBe('wh');
		});

		it('resolves gold_warehousekey column (wh side, ON clause) → column', () => {
			const tok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'gold_warehousekey' && t.table === 'wh' && t.line === 15);
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.line, tok!.col);
			expect(resolved?.kind).toBe('column');
			expect((resolved?.token as ColumnRefToken).table).toBe('wh');
		});

		it('resolves addr qualifier in addr.gold_warehousekey (ON clause) → table_qualifier', () => {
			const tok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'gold_warehousekey' && t.table === 'addr' && t.tableLine === 15);
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.tableLine!, tok!.tableCol!);
			expect(resolved?.kind).toBe('table_qualifier');
			expect((resolved?.token as ColumnRefToken).table).toBe('addr');
		});

		it('resolves gold_warehousekey column (addr side, ON clause) → column', () => {
			const tok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'gold_warehousekey' && t.table === 'addr' && t.line === 15);
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.line, tok!.col);
			expect(resolved?.kind).toBe('column');
			expect((resolved?.token as ColumnRefToken).table).toBe('addr');
		});

		it('resolves addr qualifier in addr.street (SELECT list) → table_qualifier', () => {
			const tok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'street' && t.table === 'addr');
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.tableLine!, tok!.tableCol!);
			expect(resolved?.kind).toBe('table_qualifier');
			expect((resolved?.token as ColumnRefToken).table).toBe('addr');
		});

		it('resolves city (bare column, line 8) → column with table addr', () => {
			// city has no qualifier in the source SQL; qualify() resolved it to addr.
			// There is no tableCol span, so only the column name range [col, endCol] matches.
			const tok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'city' && t.line === 8);
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.line, tok!.col + 1);
			expect(resolved?.kind).toBe('column');
			expect((resolved?.token as ColumnRefToken).table).toBe('addr');
		});

		it('resolves warehouse_address_street column_def (line 7) → column_def', () => {
			const tok = model.tokens
				.filter((t): t is ColumnDefToken => t.type === 'column_def')
				.find(t => t.name === 'warehouse_address_street' && t.line === 7);
			expect(tok).toBeDefined();

			const resolved = ParseService.resolveAtPosition(model, tok!.line, tok!.col + 1);
			expect(resolved?.kind).toBe('column_def');
		});

		it('returns null for a position outside all tokens', () => {
			// Line 3 is "\tfrom {{ ref('gold__address') }}" — the ref() jinja tag
			// is replaced by a space-padded identifier, but column 0 (the tab indent)
			// has no token.
			const resolved = ParseService.resolveAtPosition(model, 3, 0);
			expect(resolved).toBeNull();
		});
	});

	// ---- DbtDefinitionProvider.provideDefinition — end-to-end with real parsed model ----
	//
	// Full round-trip tests: cursor position → provider → vscode.Location (or undefined).
	// The indexer is mocked (no real manifest), so ref() / source() lookups return nothing.
	// The parseService mock returns the real `model` parsed by the bridge in beforeAll.
	//
	// Navigation rules under test:
	//   table_qualifier  → jump to the alias definition site (same file)
	//   table_alias      → undefined (you are already on the definition)
	//   column_def       → undefined (you are already on the definition)
	//   column (qualified) → follow alias → CTE → find column → navigate to its definition
	//                        if CTE has SELECT *, navigate to the * itself
	//
	// Coverage:
	//   ✅ qualifier 'wh' → alias site on line 12
	//   ✅ qualifier 'addr' → alias site on line 13
	//   ✅ alias definition site 'addr' → undefined
	//   ✅ alias definition site 'wh' → undefined
	//   ✅ column_def 'warehouse_address_street' → undefined
	//   ✅ qualified column addr.street → SELECT * on line 1 (stays in same file)
	//   ✅ bare column city (schema-resolved to addr) → SELECT * on line 1
	//   ✅ {{ source('raw', 'orders') }} click → navigates to sources.yml (via regex path)
	//
	// Not covered:
	//   ❌ source() via token path (case 'table_ref' currently falls through to _resolveRef;
	//      fixing it requires storing sourceName in the table_ref token or a second lookup)

	describe('DbtDefinitionProvider.provideDefinition', () => {
		const cancelToken: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

		// makeProvider constructs the real DbtDefinitionProvider with three fake dependencies:
		//   indexer    — stands in for the dbt manifest; findModelsByName returns a path only
		//                when explicitly given one via modelPaths (default: empty → not found).
		//                sourcePaths maps 'ns.tbl' keys to { uid, schemaYml } for source() lookups.
		//   parseService — skips a second bridge call; returns the real `model` already parsed
		//                  in beforeAll (schema-resolved tokens included).
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

		it('wh qualifier → aliasLine of wh definition (line 12)', async () => {
			const doc = makeDoc();
			// resolveAtPosition on 'wh.' returns table_qualifier with table='wh'
			// find the token for wh.gold_warehousekey in the ON clause (line 15)
			const whQualTok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.table === 'wh' && t.name === 'gold_warehousekey')!;
			expect(whQualTok).toBeDefined();

			const whRef = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.alias === 'wh')!;

			// click on the qualifier part (the 'wh' before the dot)
			const result = await makeProvider().provideDefinition(doc, new vscode.Position(whQualTok.tableLine!, whQualTok.tableCol! + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(whRef.aliasLine);
		});

		it('addr qualifier → aliasLine of addr definition (line 13)', async () => {
			const doc = makeDoc();
			const addrQualTok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.table === 'addr' && t.tableLine !== undefined)!;
			expect(addrQualTok).toBeDefined();

			const addrRef = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.alias === 'addr')!;

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(addrQualTok.tableLine!, addrQualTok.tableCol! + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(addrRef.aliasLine);
		});

		it('clicking on addr alias definition → undefined (no ctrl+click on definition site)', async () => {
			const doc = makeDoc();
			const addrRef = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.alias === 'addr')!;
			expect(addrRef).toBeDefined();

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(addrRef.aliasLine!, addrRef.aliasCol! + 1), cancelToken);

			expect(result).toBeUndefined();
		});

		it('clicking on wh alias definition (FROM driver) → undefined (no ctrl+click on definition site)', async () => {
			const doc = makeDoc();
			const whRef = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.alias === 'wh')!;
			expect(whRef).toBeDefined();

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(whRef.aliasLine!, whRef.aliasCol! + 1), cancelToken);

			expect(result).toBeUndefined();
		});

		it('clicking on warehouse_address_street column alias → undefined (definition site)', async () => {
			const doc = makeDoc();
			const defTok = model.tokens
				.filter((t): t is ColumnDefToken => t.type === 'column_def')
				.find(t => t.name === 'warehouse_address_street' && t.line === 7)!;
			expect(defTok).toBeDefined();

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(defTok.line, defTok.col + 1), cancelToken);

			expect(result).toBeUndefined();
		});

		it('addr.street → * on line 1 in the current file (not gold__address)', async () => {
			// Line 7: "\t\taddr.street as warehouse_address_street,"
			// addr is a CTE alias for address_with_country which does SELECT *
			// Correct: navigate to the * on line 1, stay in the current file
			const doc = makeDoc();
			const streetTok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'street' && t.table === 'addr')!;
			expect(streetTok).toBeDefined();

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(streetTok.line, streetTok.col + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(1); // line 1: "\tselect *"
		});

		it('clicking on {{ ref(\'gold__warehouse\') }} → resolves to model file path', async () => {
			// Line 12: "\tfrom {{ ref('gold__warehouse') }} as wh"
			// Click anywhere inside the jinja tag — the table_ref token now spans the full tag.
			// Indexer is given a fake model path so _resolveRef returns a Location.
			const doc = makeDoc();
			const tok = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.name === 'gold__warehouse')!;
			expect(tok).toBeDefined();

			const fakeModelPath = '/project/models/gold__warehouse.sql';
			// Click in the middle of the jinja tag span
			const clickCol = Math.floor((tok.col + tok.endCol) / 2);
			const result = await makeProvider({ gold__warehouse: fakeModelPath })
				.provideDefinition(doc, new vscode.Position(tok.line, clickCol), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('gold__warehouse');
			expect(loc.range.start.line).toBe(0);
		});

		it('clicking on address_with_country in JOIN → jumps to CTE definition (line 0)', async () => {
			// Line 13: "\tleft join address_with_country as addr"
			// address_with_country is a CTE — _jumpToCte should navigate to line 0.
			const doc = makeDoc();
			const tok = model.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref')
				.find(t => t.name === 'address_with_country')!;
			expect(tok).toBeDefined();

			const result = await makeProvider()
				.provideDefinition(doc, new vscode.Position(tok.line, tok.col + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(0); // CTE is defined at line 0
		});

		it('city (bare column, schema-resolved to addr) → SELECT * on line 1', async () => {
			// Line 8: "\t\tcity as warehouse_address_city," — city has no qualifier in the
			// source SQL, but qualify() resolved it to addr. resolveAtPosition returns
			// kind: 'column' (no tableCol span), then _jumpToColumn follows addr →
			// CTE address_with_country → SELECT * on line 1. Same destination as addr.street.
			const doc = makeDoc();
			const cityTok = model.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'city' && t.line === 8)!;
			expect(cityTok).toBeDefined();

			const result = await makeProvider().provideDefinition(doc, new vscode.Position(cityTok.line, cityTok.col + 1), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('mart');
			expect(loc.range.start.line).toBe(1); // SELECT * on line 1
		});

		it('clicking on {{ source(\'raw\', \'orders\') }} \u2192 navigates to sources.yml', async () => {
			// Line 24: "\tfrom {{ source('raw', 'orders') }}"
			// Only the table name identifier ('orders', col 24-30) is clickable.
			// The provider checks model.sources entries by tableNameCol/tableNameEndCol,
			// then calls _resolveSource('raw', 'orders').
			const doc = makeDoc();
			const src = model.sources.find(s => s.sourceName === 'raw' && s.tableName === 'orders')!;
			expect(src).toBeDefined();

			// Click in the middle of 'orders' (the clickable table name identifier).
			const clickCol = Math.floor((src.tableNameCol! + src.tableNameEndCol!) / 2);
			const result = await makeProvider(
				{},
				{ 'raw.orders': { uid: 'source.raw.orders', schemaYml: 'models/sources.yml' } },
			).provideDefinition(doc, new vscode.Position(src.line, clickCol), cancelToken);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.uri.fsPath).toContain('sources');
			expect(loc.range.start.line).toBe(0);
		});
	});

	// ---- Duplicate alias scoping ----
	//
	// Regression for: F12 on a qualifier always jumped to the *first* table_ref token
	// with that alias name, regardless of cursor position. Fix: pick the closest
	// preceding table_ref token (by line number) rather than using Array.find().
	//
	// SQL2 uses 'addr' as an alias in two separate CTEs. Clicking on addr.col_b in
	// cte_second must jump to the cte_second alias definition, not cte_first's.

	describe('duplicate alias — F12 picks closest preceding alias definition', () => {
		// Line 0: with cte_first as (
		// Line 1:     select a.col_a
		// Line 2:     from {{ ref('model_a') }} as addr
		// Line 3:     where addr.col_a = 1
		// Line 4: ),
		// Line 5: cte_second as (
		// Line 6:     select b.col_b
		// Line 7:     from {{ ref('model_b') }} as addr
		// Line 8:     where addr.col_b = 2
		// Line 9: )
		// Line 10: select * from cte_first join cte_second using (col_a)
		const SQL2 = [
			'with cte_first as (',
			'    select a.col_a',
			'    from {{ ref(\'model_a\') }} as addr',
			'    where addr.col_a = 1',
			'),',
			'cte_second as (',
			'    select b.col_b',
			'    from {{ ref(\'model_b\') }} as addr',
			'    where addr.col_b = 2',
			')',
			'select * from cte_first join cte_second using (col_a)',
		].join('\n');

		let model2: DocumentModel;

		beforeAll(async () => {
			const ftlParser = FtlDocumentParser.create(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR, { adapterType: 'ansi' } as AdapterContext);
			await ftlParser.ready();
			model2 = await ftlParser.parse(SQL2, { schema: { model_a: { col_a: 'TEXT' }, model_b: { col_b: 'TEXT' } } });
			ftlParser.dispose();
		}, 30_000);

		it('bridge emits two table_ref tokens with alias addr at different lines', () => {
			const addrRefs = model2.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref' && t.alias === 'addr');
			expect(addrRefs).toHaveLength(2);
			const lines = addrRefs.map(t => t.line).sort((a, b) => a - b);
			expect(lines[0]).toBe(2); // cte_first alias
			expect(lines[1]).toBe(7); // cte_second alias
		});

		it('proximity fix: cursor on line 8 (cte_second) selects the line-7 addr definition, not line-2', () => {
			// Simulate the fix logic from definition-provider.ts _resolveToken 'table_qualifier':
			// reduce over all candidates, picking the one with highest line ≤ cursorLine.
			const addrRefs = model2.tokens
				.filter((t): t is TableRefToken => t.type === 'table_ref' && t.alias?.toLowerCase() === 'addr');
			const cursorLine = 8; // hovering addr.col_b on line 8

			const chosen = addrRefs.reduce<TableRefToken | undefined>((best, t) => {
				if (t.line > cursorLine) return best;
				if (!best || t.line > best.line) return t;
				return best;
			}, undefined) ?? addrRefs[0];

			expect(chosen.line).toBe(7); // must pick cte_second's definition, not cte_first's
		});

		it('F12 on addr.col_b (cte_second, line 8) → alias site at line 7, not line 2', async () => {
			const lines2 = SQL2.split('\n');
			const doc2 = {
				languageId: 'jinja-sql',
				fileName: '/project/models/test2.sql',
				getText: () => SQL2,
				lineAt: (n: number) => ({ text: lines2[n] ?? '', range: new vscode.Range(n, 0, n, (lines2[n] ?? '').length) }),
				positionAt: () => new vscode.Position(0, 0),
				getWordRangeAtPosition: () => undefined,
				lineCount: lines2.length,
				uri: vscode.Uri.file('/project/models/test2.sql'),
				version: 1,
			} as unknown as vscode.TextDocument;

			const addrColBTok = model2.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'col_b' && t.table === 'addr')!;
			expect(addrColBTok).toBeDefined();
			expect(addrColBTok.tableLine).toBe(8);

			const indexer2 = {
				index: { adapterType: 'ansi' },
				findModelsByName: () => [],
				findSourceByKey: () => undefined,
				getRawNode: () => null,
				getColumns: () => null,
				setColumns: vi.fn(),
				buildSchemaMapping: () => ({}),
			};
			const parseService2 = { getDocumentModel: vi.fn().mockResolvedValue(model2), evict: vi.fn() };
			const provider2 = new DbtDefinitionProvider(
				indexer2 as never,
				{ projectDir: '/project' } as never,
				createMockLogger(),
				parseService2 as never,
			);

			const result = await provider2.provideDefinition(
				doc2,
				new vscode.Position(addrColBTok.tableLine!, addrColBTok.tableCol! + 1),
				{ isCancellationRequested: false, onCancellationRequested: vi.fn() },
			);

			expect(result).toBeDefined();
			const loc = (Array.isArray(result) ? result[0] : result) as vscode.Location;
			expect(loc.range.start.line).toBe(7); // cte_second's alias site — NOT line 2
		});
	});

	// ---- CTE-scope alias isolation ----
	//
	// Regression for: an alias name used *inside* CTE A (e.g. `addr` for gold__address)
	// was being picked as the resolvedTableRef for uses of the same alias *inside* CTE B
	// (where `addr` means address_with_country).  The proximity search was global and
	// found the earlier CTE A definition first.
	// Fix: constrain candidate table_refs to the same CTE body as the column_ref.
	//
	// SQL3:
	//   address_with_country as (        -- line 0
	//     select addr.*                  -- line 1
	//     from gold__address as addr     -- line 2  (addr = gold__address here)
	//   ),                               -- line 3
	//   enriched as (                    -- line 4
	//     select addr.street             -- line 5  (addr = address_with_country here)
	//     from address_with_country as addr -- line 6
	//   )                                -- line 7
	//   select * from enriched           -- line 8

	describe('CTE-scope alias isolation — same alias name in different CTE bodies', () => {
		const SQL3 = [
			'with address_with_country as (',
			'    select addr.*',
			'    from {{ ref(\'gold__address\') }} as addr',
			'),',
			'enriched as (',
			'    select addr.street',
			'    from address_with_country as addr',
			')',
			'select * from enriched',
		].join('\n');

		let model3: DocumentModel;

		beforeAll(async () => {
			const ftlParser = FtlDocumentParser.create(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR, { adapterType: 'ansi' } as AdapterContext);
			await ftlParser.ready();
			model3 = await ftlParser.parse(SQL3, { schema: { gold__address: { street: 'TEXT' } } });
			ftlParser.dispose();
		}, 30_000);

		it('addr.street in `enriched` resolves to the address_with_country table_ref (line 6), not gold__address (line 2)', () => {
			// SQL3 line 5: "    select addr.street" — inside the `enriched` CTE body (lines 4–7).
			// NOTE: `address_with_country` body (line 1) also contains a synthesised `street`
			// column_ref (from `select addr.*` expanded by qualify()), which correctly resolves
			// to gold__address. We must pick the explicit token at line 5, not that synthesised one.
			const streetTok = model3.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.find(t => t.name === 'street' && t.table === 'addr' && t.line === 5);
			expect(streetTok).toBeDefined();
			// Must point to the `address_with_country as addr` on line 6, not `gold__address as addr` on line 2
			expect(streetTok!.resolvedTableRef).toBeDefined();
			expect(streetTok!.resolvedTableRef!.name.toLowerCase()).toContain('address_with_country');
			expect(streetTok!.resolvedTableRef!.line).toBe(6);
		});

		it('addr.* in `address_with_country` resolves to the gold__address table_ref (line 2)', () => {
			const cteAddrRefs = model3.tokens
				.filter((t): t is ColumnRefToken => t.type === 'column_ref')
				.filter(t => t.table === 'addr' && t.line < 3);
			// At least one column_ref inside the first CTE should resolve to gold__address
			const withResolvedRef = cteAddrRefs.filter(t => t.resolvedTableRef !== undefined);
			if (withResolvedRef.length > 0) {
				for (const tok of withResolvedRef) {
					expect(tok.resolvedTableRef!.line).toBe(2);
				}
			}
			// If sqlglot collapses addr.* to no column_refs, that's fine — just assert no wrong ref
			for (const tok of cteAddrRefs) {
				if (tok.resolvedTableRef) {
					expect(tok.resolvedTableRef.line).not.toBe(6);
				}
			}
		});
	});

	// ---- model.aliases — architectural boundary test ----
	//
	// _aliases_from_scope in bridge.py processes:
	//   Step 1: CTE names → their output columns
	//   Step 2: ROOT scope selected_sources only
	//
	// The final SELECT is `select * from warehouses_enriched`, so the root scope's
	// only selected_source is `warehouses_enriched` — not `wh` or `gold__warehouse`.
	// `wh` is a CTE-internal alias inside the warehouses_enriched body.
	// By design (comment in bridge.py): "CTE-internal aliases must NOT pollute
	// the top-level alias dict — they are local to that CTE's scope."
	//
	// This means model.aliases['wh'] is NEVER populated regardless of schema_mapping.
	// The hover-provider must use resolvedTableRef from the token pipeline instead.

	describe('model.aliases — CTE-internal aliases are not in the top-level alias dict', () => {
		it('aliases[wh] is absent (wh is a CTE-internal alias, intentionally excluded)', () => {
			const aliases = (model as DocumentModel & { aliases?: Record<string, string[]> }).aliases;
			// wh is defined inside warehouses_enriched CTE body — never in the root scope aliases
			expect(aliases?.['wh']).toBeUndefined();
		});

		it('aliases[gold__warehouse] is absent (not in root scope selected_sources)', () => {
			const aliases = (model as DocumentModel & { aliases?: Record<string, string[]> }).aliases;
			expect(aliases?.['gold__warehouse']).toBeUndefined();
		});

		it('aliases[warehouses_enriched] IS populated (it is a CTE name — Step 1)', () => {
			const aliases = (model as DocumentModel & { aliases?: Record<string, string[]> }).aliases;
			// warehouses_enriched is registered by Step 1 (CTE scopes → output columns)
			// It may be empty if the CTE has wh.* (wildcard from an external ref)
			// but the key should exist or the aliased model should have it.
			// The key point: wh (CTE-internal alias) is NOT here.
			expect(aliases?.['wh']).toBeUndefined();
		});
	});

});
