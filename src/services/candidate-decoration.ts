/**
 * The dbt-flavored completion decoration hook (sqllens 1.7.0 `CompleteOptions.decorate`).
 *
 * sqllens decides the candidate SET; this hook only supplies display text, keyed on the
 * STRUCTURAL identity sqllens hands over — never on the label string (a label-keyed join
 * is the name-identity bug class the 2026-07-19 audit killed):
 *
 *  - `template` candidates (a model/source name inside a `ref('…`/`source('…` slot) carry
 *    the TemplateCall, so the manifest join is a catalog lookup on dbt's own unique names;
 *  - `table` candidates in a FROM/JOIN slot are the manifest model names our
 *    `AnvilTemplateProvider.tables()` supplied, same catalog join;
 *  - `cte` candidates carry their declaration span, joined structurally against the cached
 *    DocumentModel's CTE entries (position, not name — shadowing-safe).
 *
 * Every miss returns undefined: the contract keeps the candidate as sqllens built it.
 */
import type { CandidateDecoration, Completion, DecorateCandidate, TemplateCall } from '../ftl/sqllens/api';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { DocumentModel } from './parse-service';

export function makeCandidateDecorator(
	indexer: ManifestIndexer | undefined,
	peekModel: () => DocumentModel | undefined,
): DecorateCandidate {
	return (candidate, identity) => {
		switch (identity.kind) {
			case 'template': {
				if (!indexer) return undefined;
				if (identity.call.name === 'ref') return modelDetail(indexer, candidate.label);
				if (identity.call.name === 'source') return sourceDetail(indexer, identity.call, candidate.label);
				return undefined;
			}
			case 'table':
				return indexer ? modelDetail(indexer, candidate.label) : undefined;
			case 'cte': {
				const span = identity.declarationSpan;
				if (span === undefined) return undefined;
				const cte = peekModel()?.ctes.find(c => c.line === span.line - 1 && c.col === span.column);
				if (!cte || cte.columns.length === 0 || cte.columns.some(c => c.name === '*')) return undefined;
				return { detail: `CTE — ${cte.columns.length} column${cte.columns.length === 1 ? '' : 's'}` };
			}
			default:
				return undefined;
		}
	};
}

/** Manifest lookup by dbt model name (globally unique in dbt — a catalog join). */
function modelDetail(indexer: ManifestIndexer, label: string): CandidateDecoration | undefined {
	const m = indexer.findModelsByName(label)[0];
	if (!m) return undefined;
	const decoration: CandidateDecoration = { detail: `${m.materialisation} — ${m.packageName}` };
	if (m.description) decoration.documentation = m.description;
	return decoration;
}

/** Source lookup on dbt's (sourceName, tableName) COMPOUND key — the source name comes
 *  off the TemplateCall's own args, so two sources sharing a table name never conflate. */
function sourceDetail(indexer: ManifestIndexer, call: TemplateCall, label: string): CandidateDecoration | undefined {
	const sourceName = call.kwargs?.find(k => k.name === 'source_name')?.value ?? call.args[0];
	if (typeof sourceName !== 'string') return undefined;
	for (const src of indexer.index?.sources.values() ?? []) {
		if (src.sourceName === sourceName && src.name === label) {
			const decoration: CandidateDecoration = { detail: `source — ${src.schema}` };
			if (src.description) decoration.documentation = src.description;
			return decoration;
		}
	}
	return undefined;
}

/** Re-exported so ParseService can type its option threading without importing sqllens directly. */
export type { Completion, DecorateCandidate };
