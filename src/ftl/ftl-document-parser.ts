import type { DocumentModel } from '../services/parse-service';
import type { DocumentParser, ParseOptions } from '../services/document-parser';
import type { DialectSymbols, SqlParser } from './sql-parser';
import { PyodideWorkerPool, type PoolOptions } from './pyodide-worker-pool';
import {
	enrichTokensWithJinjaSpans,
	extractCtes,
	extractFinalColumns,
	extractFinalSelect,
	extractMacroCalls,
	extractPivotVirtualColumns,
	extractRefs,
	extractSources,
	extractSubqueries,
	extractTokens,
	mapWarnings,
	resolveTableRefs,
	walkLineageTree,
	type RawLineageV2,
} from './extractors';
import { mapAdapterToDialect } from './dialect-map';
import { mergeSqlAndJinjaTokens } from './ninja-sql-tokens';
import type { LineageResult } from './extractors/lineage-walker';

export { mapAdapterToDialect };
export {
	extractCtes,
	extractFinalColumns,
	extractFinalSelect,
	extractMacroCalls,
	extractPivotVirtualColumns,
	extractRefs,
	extractSources,
	extractSubqueries,
	extractTokens,
	mapWarnings,
	resolveTableRefs,
	walkLineageTree,
};
export type {
	ColumnDependency,
	LineageResult,
	LineageTreeNode,
	Transformation,
	TransformationBranch,
} from './extractors/lineage-walker';

/**
 * The subset of ManifestIndexer that FtlDocumentParser needs.
 * Defined here so FtlDocumentParser owns the contract; ManifestIndexer
 * satisfies it structurally via its `adapterType` getter.
 */
export interface AdapterContext {
	readonly adapterType: string | undefined;
}

export class FtlDocumentParser implements DocumentParser {
	private readonly _pool: PyodideWorkerPool | undefined;
	/** Cache of dialect symbol lookups, keyed by dialect string. */
	private readonly _symbolsCache = new Map<string, Promise<DialectSymbols>>();

	constructor(
		private readonly _sqlParser: SqlParser,
		private readonly _context: AdapterContext,
		pool?: PyodideWorkerPool,
	) {
		this._pool = pool;
	}

	static create(pyodideDir: string, vendorDir: string, scriptsDir: string, context: AdapterContext, options?: PoolOptions): FtlDocumentParser {
		const pool = new PyodideWorkerPool(pyodideDir, vendorDir, scriptsDir, options);
		return new FtlDocumentParser(pool, context, pool);
	}

	ready(): Promise<void> {
		return this._pool!.ready();
	}

	dispose(): void {
		this._pool?.dispose();
	}

	traceLineage(_compiledSql: string, _columnName: string, _dialect: string, _schemaJson: string): Promise<string> {
		throw new Error('traceLineage (v1) is deprecated — use traceLineageV2');
	}

	async traceLineageV2(sql: string, columnName: string, schemaJson: string): Promise<LineageResult | { error: string }> {
		const adapterType = this._context.adapterType;
		if (!adapterType) return { error: 'No adapter type available — manifest not loaded' };
		const dialect = mapAdapterToDialect(adapterType) ?? adapterType;
		const raw = await this._pool!.traceLineageV2(sql, columnName, dialect, schemaJson);
		const result = JSON.parse(raw) as RawLineageV2;
		if (!result.success) return { error: result.error };
		return walkLineageTree(result.tree);
	}

	async decomposeQuery(compiledSql: string): Promise<string> {
		const adapterType = this._context.adapterType;
		if (!adapterType) return '';
		const dialect = mapAdapterToDialect(adapterType) ?? adapterType;
		return this._pool!.decomposeQuery(compiledSql, dialect);
	}

	async getDialectSymbols(): Promise<DialectSymbols | undefined> {
		const adapterType = this._context.adapterType;
		if (!adapterType || !this._sqlParser.getDialectSymbols) return undefined;
		const dialect = mapAdapterToDialect(adapterType) ?? adapterType;
		let pending = this._symbolsCache.get(dialect);
		if (!pending) {
			pending = this._sqlParser.getDialectSymbols(dialect);
			this._symbolsCache.set(dialect, pending);
		}
		return pending;
	}

	async parse(sql: string, options?: ParseOptions): Promise<DocumentModel> {
		const adapterType = this._context.adapterType ?? '';
		const dialect = mapAdapterToDialect(adapterType) ?? adapterType;
		const result = await this._sqlParser.parse(sql, dialect, options?.schema);

		const ctes = extractCtes(result.ast, sql, result.wildcardCtes);
		const subqueries = extractSubqueries(result.ast);
		const tokens = extractTokens(result.ast, ctes);
		resolveTableRefs(tokens);
		const refs = extractRefs(result.jinjaTokens ?? []);
		const sources = extractSources(result.jinjaTokens ?? []);
		const macroCalls = extractMacroCalls(result.jinjaTokens ?? []);
		enrichTokensWithJinjaSpans(tokens, refs, sources);
		const pivotVirtualColumns = extractPivotVirtualColumns(result.ast);

		return {
			refs,
			sources,
			macroCalls,
			ctes: [...ctes, ...subqueries],
			finalColumns: extractFinalColumns(result.ast),
			finalSelect: extractFinalSelect(result.ast, sql),
			tokens,
			sqlglotWarnings: mapWarnings(result.warnings),
			timing: { parseMs: result.timing.parseMs, totalMs: result.timing.totalMs },
			jinjaTokens: result.jinjaTokens,
			ninjaSqlTokens: result.sqlTokens && result.jinjaTokens
				? mergeSqlAndJinjaTokens(result.sqlTokens, result.jinjaTokens)
				: undefined,
			ast: result.ast,
			pivotVirtualColumns: Object.keys(pivotVirtualColumns).length > 0 ? pivotVirtualColumns : undefined,
			isPass2: result.isPass2,
		};
	}
}
