import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { computeCommentRanges, isOffsetInComment } from './comment-utils';

export interface StrippedSql {
	/** SQL with Jinja expressions replaced by table names. */
	sql: string;
	/** Map of resolved table name → manifest unique_id (for models/sources found in ref/source calls). */
	refs: Map<string, string>;
}

/**
 * Strip Jinja from a dbt SQL document, replacing `ref()` / `source()` calls
 * with the resolved relation name from the manifest.
 *
 * This produces SQL that sqlglot can parse while preserving the table names
 * the bridge needs for schema_mapping lookups.
 */
export function stripJinja(text: string, indexer: ManifestIndexer): StrippedSql {
	const refs = new Map<string, string>();
	const commentRanges = computeCommentRanges(text);

	// Replace {{ ref('model') }}, {{ ref("model") }} and two-arg variants (single or double quotes)
	let sql = text.replace(
		/\{\{\s*ref\(\s*(?:['"]([^'"]+)['"]\s*,\s*)?['"]([^'"]+)['"]\s*\)\s*\}\}/g,
		(fullMatch, _pkg: string | undefined, modelName: string, offset: number) => {
			if (isOffsetInComment(offset, commentRanges)) return fullMatch;
			const models = indexer.findModelsByName(modelName);
			if (models.length > 0) {
				const raw = indexer.getRawNode(models[0].uniqueId);
				if (raw && 'alias' in raw) {
					const tableName = raw.alias || raw.name;
					const schema = raw.schema ?? 'public';
					refs.set(tableName, models[0].uniqueId);
					return `${schema}.${tableName}`;
				}
				refs.set(modelName, models[0].uniqueId);
				return modelName;
			}
			return modelName;
		},
	);

	// Replace {{ source('source_name', 'table_name') }} and double-quote variants
	sql = sql.replace(
		/\{\{\s*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g,
		(fullMatch, sourceName: string, tableName: string, offset: number) => {
			if (isOffsetInComment(offset, commentRanges)) return fullMatch;
			const index = indexer.index;
			if (index) {
				for (const source of index.sources.values()) {
					if (source.sourceName === sourceName && source.name === tableName) {
						const raw = indexer.getRawNode(source.uniqueId);
						const identifier = raw && 'identifier' in raw ? raw.identifier : tableName;
						const schema = raw?.schema ?? source.schema;
						refs.set(identifier, source.uniqueId);
						return `${schema}.${identifier}`;
					}
				}
			}
			return tableName;
		},
	);

	// Remove {{ config(...) }} — may span multiple lines
	sql = sql.replace(/\{\{\s*config\s*\([\s\S]*?\)\s*\}\}/g, '');

	// Remove remaining {% ... %} block tags (if/endif, for/endfor, etc.)
	sql = sql.replace(/\{%[-\s][\s\S]*?[-\s]%\}/g, '');

	// Remove any remaining {{ ... }} expressions (variables, etc.)
	sql = sql.replace(/\{\{[\s\S]*?\}\}/g, '');

	return { sql: sql.trim(), refs };
}
