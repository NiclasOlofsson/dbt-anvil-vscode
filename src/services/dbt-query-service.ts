import type { CompileCache } from '../dbt/compile-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { CteInfo, ParseService } from './parse-service';

export class DbtQueryService {
	constructor(
		private readonly _compileCache: CompileCache,
		private readonly _parseService: ParseService,
		private readonly _indexer: ManifestIndexer,
	) {}

	/**
	 * Compiles a model via CompileCache and parses CTE boundaries with sqlglot.
	 * Returns the compiled SQL string and the full CTE list, or null if compilation
	 * fails or the uniqueId is not a model node.
	 *
	 * Used by the profiler (needs all CTEs at once) and internally by buildCteSql.
	 */
	async getCompiledCtes(uniqueId: string): Promise<{ compiledSql: string; ctes: CteInfo[] } | null> {
		const rawNode = this._indexer.getRawNode(uniqueId);
		if (!rawNode || rawNode.resource_type !== 'model') return null;

		const compiledSql = await this._compileCache.ensureCompiled(
			uniqueId, rawNode.name, this._indexer.projectDir, rawNode.original_file_path,
		);
		if (!compiledSql) return null;

		const ctes = await this._parseService.parseSqlString(compiledSql);
		return { compiledSql, ctes };
	}

	/**
	 * Returns a runnable SQL string for a specific named CTE in a model: all upstream
	 * CTEs up to and including the target CTE's closing paren, plus SELECT * FROM <cteName>.
	 * Returns null if the model cannot be compiled or the CTE name is not found.
	 */
	async buildCteSql(uniqueId: string, cteName: string): Promise<string | null> {
		const compiled = await this.getCompiledCtes(uniqueId);
		if (!compiled) return null;

		const { compiledSql, ctes } = compiled;
		const targetCte = ctes.find(c => c.name === cteName);
		if (!targetCte) return null;

		const lines = compiledSql.split('\n');
		const fragment = lines.slice(0, targetCte.endLine + 1);
		fragment[fragment.length - 1] = fragment[fragment.length - 1].replace(/,\s*$/, '');
		return `${fragment.join('\n')}\nSELECT * FROM ${cteName}`;
	}
}
