import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { WorkspaceDiagnosticsScanner } from '../../ninja/diagnostics/scanner';
import type { ManifestIndexer, ManifestIndex, IndexedModel } from '../../indexing/manifest-indexer';
import type { DocumentModel, ParseService, RefInfo } from '../../services/parse-service';
import type { DbtPathResolver } from '../../dbt/dbt-path-resolver';
import { createMockLogger } from '../helpers';
import { model, sym } from './helpers';

/**
 * `_runCrossModelChecks` (the "column contract" check, part 4B) is private and only
 * invoked from `scanAll()`, which drives a full workspace file scan — too heavy for a
 * unit test. These tests populate the scanner's internal caches directly (the same
 * `_parsedModelCache` state `scanAll()` leaves behind after a real scan) and invoke
 * the method, then read back what it pushed onto `_contractsCollection`.
 *
 * Covers the Sym-based port (was: model.tokens' ColumnRefToken.table): a column
 * reference resolves to its FROM/JOIN source via `Sym.source` regardless of whether
 * it was written qualified or bare (mirrors the retired bridge's `.table`, itself
 * resolution-based), and the qualifier text used to match the ref's alias comes
 * from `Sym.alias`.
 */
interface ScannerInternals {
	_parsedModelCache: Map<string, DocumentModel>;
	_runCrossModelChecks: () => void;
	_contractsCollection: { set: ReturnType<typeof vi.fn> };
}

function indexedModel(uniqueId: string, name: string, path: string): IndexedModel {
	return { uniqueId, name, packageName: 'p', path, tags: [], materialisation: 'view' };
}

function makeIndex(models: IndexedModel[]): ManifestIndex {
	const nodesByName = new Map<string, string[]>();
	for (const m of models) nodesByName.set(m.name, [...(nodesByName.get(m.name) ?? []), m.uniqueId]);
	return {
		models: new Map(models.map(m => [m.uniqueId, m])),
		sources: new Map(),
		macros: new Map(),
		functions: new Map(),
		nodesByName,
		parentMap: new Map(),
		// No downstream for anyone — 4A ("unused model") fires for every model here,
		// but that's a separate, untouched check; tests filter to 'column-contract-break'.
		childMap: new Map(models.map(m => [m.uniqueId, []])),
		dbtVersion: '1.8.0',
		adapterType: 'databricks',
		buildTime: new Date(),
	};
}

function buildScanner(index: ManifestIndex): ScannerInternals {
	const indexer = { index } as unknown as ManifestIndexer;
	const scanner = new WorkspaceDiagnosticsScanner(
		{} as unknown as ParseService,
		indexer,
		{} as unknown as DbtPathResolver,
		createMockLogger(),
	);
	return scanner as unknown as ScannerInternals;
}

/** The diagnostics `_runCrossModelChecks` pushed for a given file path, or undefined if none. */
function diagsFor(internals: ScannerInternals, path: string): vscode.Diagnostic[] {
	const target = vscode.Uri.file(path).toString();
	for (const [uri, diags] of internals._contractsCollection.set.mock.calls as [vscode.Uri, vscode.Diagnostic[]][]) {
		if (uri.toString() === target) return diags;
	}
	return [];
}

function contractDiags(internals: ScannerInternals, path: string): vscode.Diagnostic[] {
	return diagsFor(internals, path).filter(d => d.code === 'column-contract-break');
}

const ORDERS_PATH = '/project/models/orders.sql';
const CUSTOMERS_PATH = '/project/models/customers.sql';

const testIndex = makeIndex([
	indexedModel('model.p.customers', 'customers', CUSTOMERS_PATH),
	indexedModel('model.p.orders', 'orders', ORDERS_PATH),
]);

const ref: RefInfo = { model: 'orders', line: 4, col: 0, alias: 'o' };

const ordersUpstream: DocumentModel = model({
	status: 'ok',
	finalColumns: [{ name: 'order_id', line: 0 }, { name: 'customer_id', line: 0 }],
});

function seedCaches(internals: ScannerInternals, downstream: DocumentModel): void {
	internals._parsedModelCache.set(vscode.Uri.file(CUSTOMERS_PATH).toString(), downstream);
	internals._parsedModelCache.set(vscode.Uri.file(ORDERS_PATH).toString(), ordersUpstream);
}

describe('WorkspaceDiagnosticsScanner — cross-model column contract (Sym port)', () => {
	it('flags a qualified column reference not present in the upstream ref\'s finalColumns', () => {
		const ordersTable = sym('table', 'orders', 4, 10, { alias: { name: 'o', line: 4, col: 17 } });
		const oAlias = sym('alias', 'o', 4, 17);
		const orderIdCol = sym('column', 'o.order_id', 5, 2, { source: ordersTable });
		const bogusCol = sym('column', 'o.bogus_col', 6, 2, { source: ordersTable });

		const downstream = model({
			status: 'ok',
			refs: [ref],
			symbols: [ordersTable, oAlias, orderIdCol, bogusCol],
		});

		const internals = buildScanner(testIndex);
		seedCaches(internals, downstream);
		internals._runCrossModelChecks();

		const diags = contractDiags(internals, CUSTOMERS_PATH);
		expect(diags).toHaveLength(1);
		expect(diags[0].message).toContain('Column \'bogus_col\' not found in \'orders\'');
		expect(diags[0].message).toContain('order_id, customer_id');
	});

	it('does not flag a qualified column reference that IS in the upstream finalColumns', () => {
		const ordersTable = sym('table', 'orders', 4, 10, { alias: { name: 'o', line: 4, col: 17 } });
		const oAlias = sym('alias', 'o', 4, 17);
		const orderIdCol = sym('column', 'o.order_id', 5, 2, { source: ordersTable });

		const downstream = model({
			status: 'ok',
			refs: [ref],
			symbols: [ordersTable, oAlias, orderIdCol],
		});

		const internals = buildScanner(testIndex);
		seedCaches(internals, downstream);
		internals._runCrossModelChecks();

		expect(contractDiags(internals, CUSTOMERS_PATH)).toHaveLength(0);
	});

	it('does not flag a column resolved to a source whose qualifier does not match the ref\'s alias', () => {
		// bound to a DIFFERENT relation ('x', not the 'o' the orders ref is aliased as) —
		// even though 'bogus_col' is unknown upstream, it's not a column read through
		// this ref, so the contract check must not fire.
		const otherTable = sym('table', 'other_thing', 4, 20, { alias: { name: 'x', line: 4, col: 33 } });
		const xAlias = sym('alias', 'x', 4, 33);
		const bogusCol = sym('column', 'x.bogus_col', 6, 2, { source: otherTable });

		const downstream = model({
			status: 'ok',
			refs: [ref],
			symbols: [otherTable, xAlias, bogusCol],
		});

		const internals = buildScanner(testIndex);
		seedCaches(internals, downstream);
		internals._runCrossModelChecks();

		expect(contractDiags(internals, CUSTOMERS_PATH)).toHaveLength(0);
	});

	it('flags a BARE (unqualified) column reference resolved via sourceOf to the ref\'s aliased table', () => {
		// No qualifier written in the SQL (`sym.name` carries no dot) — resolution comes
		// entirely from `sourceOf`, matching the retired bridge's behavior where `.table`
		// was upgraded via `qualification.bindingOf` for bare columns too, not read off
		// literal source text.
		const ordersTable = sym('table', 'orders', 4, 10, { alias: { name: 'o', line: 4, col: 17 } });
		const oAlias = sym('alias', 'o', 4, 17);
		const bareBogusCol = sym('column', 'bogus_col', 6, 2, { source: ordersTable });

		const downstream = model({
			status: 'ok',
			refs: [ref],
			symbols: [ordersTable, oAlias, bareBogusCol],
		});

		const internals = buildScanner(testIndex);
		seedCaches(internals, downstream);
		internals._runCrossModelChecks();

		const diags = contractDiags(internals, CUSTOMERS_PATH);
		expect(diags).toHaveLength(1);
		expect(diags[0].message).toContain('Column \'bogus_col\' not found in \'orders\'');
	});
});
