import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { TagNode } from '../../ftl/sqllens/api';
import { computeCommentRanges, isOffsetInComment } from './comment-utils';

/**
 * Resolve every `ref()` / `source()` tag to its manifest relation: resolved
 * table name → manifest unique_id (models by alias-or-name, sources by
 * identifier). The schema enrichment path feeds these into the describe cache.
 *
 * Tags come from sqllens's tag-AST (which handles both quote styles and the
 * 2-arg `ref('pkg','model')` form structurally — the regex layer this replaces
 * matched them textually). A tag opening inside a SQL comment is skipped, so a
 * commented-out ref never triggers a schema lookup.
 */
export function resolveTagRelations(text: string, tags: TagNode[], indexer: ManifestIndexer): Map<string, string> {
	const refs = new Map<string, string>();
	const commentRanges = computeCommentRanges(text);

	for (const tag of tags) {
		if (tag.kind !== 'ref' && tag.kind !== 'source') continue;
		if (isOffsetInComment(tag.tagSpan.start, commentRanges)) continue;

		if (tag.kind === 'ref') {
			const models = indexer.findModelsByName(tag.model);
			if (models.length === 0) continue;
			const raw = indexer.getRawNode(models[0].uniqueId);
			if (raw && 'alias' in raw) {
				refs.set(raw.alias || raw.name, models[0].uniqueId);
			} else {
				refs.set(tag.model, models[0].uniqueId);
			}
		} else {
			const index = indexer.index;
			if (!index) continue;
			for (const source of index.sources.values()) {
				if (source.sourceName === tag.sourceName && source.name === tag.tableName) {
					const raw = indexer.getRawNode(source.uniqueId);
					const identifier = raw && 'identifier' in raw ? (raw.identifier as string) : tag.tableName;
					refs.set(identifier, source.uniqueId);
					break;
				}
			}
		}
	}

	return refs;
}
