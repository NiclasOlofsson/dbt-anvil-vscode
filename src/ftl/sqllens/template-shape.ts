/**
 * C4 template-catalog: classify a dbt macro's expansion shape from its source, so
 * `parseTemplated` can fill a statement/CTE-body macro placeholder with a shape-valid
 * fragment (`SELECT 1`) instead of the identifier fill — letting a macro-generated
 * query body (`with c as ({{ playoff_sim(...) }}) {{ playoff_sim_end(...) }}`) parse
 * natively instead of falling back to the blank cascade.
 *
 * v1 is deliberately conservative: a macro whose body is a full query (first significant
 * SQL keyword is WITH or SELECT) classifies as `statement`; everything else returns
 * `undefined` (the identifier fill — today's behavior, correct for expression macros).
 *
 * Why `statement` and never `relation`: both fill `SELECT 1`, but `relation` is the shape
 * sqllens flags as a 0->1 regression risk in a bare `from {{ m() }}` slot (fills to the
 * invalid `from SELECT 1`). `statement`'s `SELECT 1` is valid both standalone and inside a
 * `(...)` CTE body, and the corpus's FROM-relations are all `ref()` tags, not bare macros —
 * so never answering `relation` sidesteps that gap by construction.
 *
 * Safety: the lookup is by macro NAME and only consulted for macros that actually appear
 * as `{{ }}` tags, so query-bodied helper/test/adapter macros that never appear in a model
 * body are never classified. The one residual over-reach — a query-bodied macro genuinely
 * called in a predicate slot (`where {{ m() }}`) — is nonsensical dbt and is the slot-blind
 * fit-guard Open Gap sqllens owns; `statement` is safe in every real position (a select-item
 * `SELECT 1` is fit-rejected back to the identifier fill; a `(...)`/statement slot accepts it).
 */
import type { ExpansionShape, ShapeOf } from './api';

/**
 * Classify a macro's expansion shape from its `macro_sql` source. Returns `statement`
 * for a query-bodied macro (WITH/SELECT-first), `undefined` otherwise (identifier fill).
 */
export function classifyMacroShape(macroSql: string | undefined): ExpansionShape | undefined {
	if (!macroSql) return undefined;
	const body = macroSql
		// drop the {% macro ... %} opener and {% endmacro %} closer (whitespace-trim variants)
		.replace(/\{%-?\s*macro\b[\s\S]*?%\}/i, '')
		.replace(/\{%-?\s*endmacro\s*-?%\}/i, '')
		// drop remaining jinja tags/expressions/comments and SQL line comments
		.replace(/\{\{[\s\S]*?\}\}/g, ' ')
		.replace(/\{%[\s\S]*?%\}/g, ' ')
		.replace(/\{#[\s\S]*?#\}/g, ' ')
		.replace(/--[^\n]*/g, ' ')
		.trim();
	return /^(with|select)\b/i.test(body) ? 'statement' : undefined;
}

/**
 * Build a `ShapeOf` callback from a macro-name -> macro_sql lookup. Lazy: a macro's shape
 * is classified only when `parseTemplated` asks about it (i.e. it appears as a tag), so
 * macros that never appear in a model body are never classified. `parts` (package-qualified
 * calls) is ignored in v1 — dbt macro names are unique enough by bare name for the lookup.
 */
export function makeShapeOf(lookup: (name: string) => string | undefined): ShapeOf {
	return (call) => classifyMacroShape(lookup(call.name));
}
