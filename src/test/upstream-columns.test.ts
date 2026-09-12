/**
 * Seam test for upstream (ref/source) column knowledge — the contract that died
 * silently at the engine cutover: a described upstream relation's columns must
 * flow back OUT of the parse to the editor features that show them
 * (unknown-column warnings, hover column lists, alias→column completions).
 *
 * Real SqllensDocumentParser + real ParseService; only the warehouse boundary
 * (DescribeCache) and the manifest (ManifestIndexer) are mocked. Every earlier
 * test of this feature mocked one of the two REAL halves, which is exactly how
 * the regression stayed green — this file crosses the seam on purpose.
 * If it goes red, the editor has gone dark on upstream columns again.
 */
import { describe, expect, it } from 'vitest';
import { Uri } from 'vscode';
import { ParseService } from '../services/parse-service';
import { SqllensDocumentParser } from '../ftl/sqllens/document-parser';
import { makeTemplateProvider } from '../ftl/sqllens/template-shape';
import type { DescribeCache } from '../dbt/describe-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { Sym } from '../ftl/sqllens/api';
import { createMockLogger } from './helpers';

const ORDERS_UID = 'model.jaffle.orders';
const EVENTS_UID = 'source.jaffle.raw.events';

function createMockDocument(text: string, uri = 'file:///upstream.sql'): import('vscode').TextDocument {
	return {
		uri: Uri.parse(uri),
		version: 1,
		fileName: '/upstream.sql',
		languageId: 'jinja-sql',
		getText: () => text,
	} as unknown as import('vscode').TextDocument;
}

/**
 * The harness: a manifest with one model (orders) and one source (raw.events),
 * a Map-backed column store standing in for the indexer's warm column cache,
 * and a DescribeCache whose async `columns()` populates that store — the same
 * store/populate relationship the real pair has. The store starts COLD: the
 * whole warm-up must happen inside one getDocumentModel call.
 */
function makeHarness(describeAnswers: Record<string, string[] | undefined>) {
	const columnStore = new Map<string, string[]>();
	const describeCalls: string[] = [];

	const eventsSource = { uniqueId: EVENTS_UID, sourceName: 'raw', name: 'events', schema: 'landing' };
	const indexer = {
		adapterType: 'duckdb',
		index: { adapterType: 'duckdb', sources: new Map([[EVENTS_UID, eventsSource]]) },
		findModelsByName: (name: string) =>
			name === 'orders' ? [{ uniqueId: ORDERS_UID, name: 'orders', packageName: 'jaffle' }] : [],
		findSourceByKey: (sourceName: string, tableName: string) =>
			sourceName === 'raw' && tableName === 'events' ? { uid: EVENTS_UID, source: eventsSource } : undefined,
		getRawNode: (uid: string) => {
			if (uid === ORDERS_UID) return { resource_type: 'model', name: 'orders', alias: 'orders', schema: 'main' };
			if (uid === EVENTS_UID) return { resource_type: 'source', name: 'events', source_name: 'raw', identifier: 'events_raw', schema: 'landing' };
			return undefined;
		},
		getColumns: (uid: string) => columnStore.get(uid),
		setColumns: (uid: string, cols: string[]) => { columnStore.set(uid, cols); },
		buildSchemaMapping: () => ({}),
		findMacroByName: () => undefined,
		macroShape: () => undefined,
		get templateProvider() { return makeTemplateProvider(() => undefined); },
	} as unknown as ManifestIndexer;

	const describeCache = {
		columns: (uid: string): Promise<string[] | undefined> => {
			describeCalls.push(uid);
			const cols = describeAnswers[uid];
			if (cols) columnStore.set(uid, cols);
			return Promise.resolve(cols);
		},
	} as unknown as DescribeCache;

	const parser = new SqllensDocumentParser(indexer);
	const logger = { ...createMockLogger(), error: (m: string) => { throw new Error(m); } };
	const service = new ParseService(parser, logger, { describeCache, indexer });
	return { service, describeCalls };
}

/** The FROM/JOIN relation Sym carrying the given alias. */
function relationByAlias(model: { symbols?: Sym[] }, alias: string): Sym | undefined {
	return (model.symbols ?? []).find(
		s => s.modifiers.includes('reference') && s.alias?.name.toLowerCase() === alias,
	);
}

describe('upstream ref/source column knowledge (cutover-regression seam)', () => {
	it('a typo against a described ref warns; real columns reach hover and completions', async () => {
		const { service, describeCalls } = makeHarness({ [ORDERS_UID]: ['order_id', 'order_type'] });
		const doc = createMockDocument('select o.order_typ, o.order_id\nfrom {{ ref(\'orders\') }} as o');

		const model = await service.getDocumentModel(doc);
		expect(model).not.toBeNull();

		// The warehouse boundary was actually crossed (cold start, described in-call).
		expect(describeCalls).toContain(ORDERS_UID);

		// (1) The squiggle: exactly one scope_warning, on the typo'd reference only —
		// o.order_id is real and must stay silent.
		const scope = (model!.parseWarnings ?? []).filter(w => w.type === 'scope_warning');
		expect(scope).toHaveLength(1);
		expect(scope[0].message).toContain('order_typ');
		expect(scope[0].line).toBe(0);
		// The range covers the written reference (o.order_typ spans cols 7..18).
		expect(scope[0].col).toBeGreaterThanOrEqual(7);
		expect(scope[0].endCol).toBeLessThanOrEqual(18);
		expect(scope[0].endCol! - scope[0].col!).toBeGreaterThanOrEqual('order_typ'.length);

		// (2) Hover's source of truth: the relation resolves to the described columns.
		const rel = relationByAlias(model!, 'o');
		expect(rel).toBeDefined();
		expect([...(ParseService.columnsForRef(rel!, model!) ?? [])].sort()).toEqual(['order_id', 'order_type']);

		// (3) Completions' source of truth: alias → described columns.
		expect([...(ParseService.resolveAliases(model!)['o'] ?? [])].sort()).toEqual(['order_id', 'order_type']);
	});

	it('an undescribable ref stays silent — never-wrong on a partial catalog', async () => {
		const { service } = makeHarness({ [ORDERS_UID]: undefined });
		const doc = createMockDocument('select x.nope from {{ ref(\'orders\') }} x');

		const model = await service.getDocumentModel(doc);
		expect(model).not.toBeNull();

		// No column list → no unknown-column verdict, no phantom columns anywhere.
		expect((model!.parseWarnings ?? []).filter(w => w.type === 'scope_warning')).toHaveLength(0);
		const rel = relationByAlias(model!, 'x');
		expect(rel && ParseService.columnsForRef(rel, model!)).toBeUndefined();
	});

	it('source() relations get the same treatment as ref()', async () => {
		const { service } = makeHarness({ [EVENTS_UID]: ['event_id', 'ts'] });
		const doc = createMockDocument('select s.event_idz from {{ source(\'raw\', \'events\') }} s');

		const model = await service.getDocumentModel(doc);
		expect(model).not.toBeNull();

		const scope = (model!.parseWarnings ?? []).filter(w => w.type === 'scope_warning');
		expect(scope).toHaveLength(1);
		expect(scope[0].message).toContain('event_idz');

		const rel = relationByAlias(model!, 's');
		expect(rel).toBeDefined();
		expect([...(ParseService.columnsForRef(rel!, model!) ?? [])].sort()).toEqual(['event_id', 'ts']);
	});
});
