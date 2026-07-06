/**
 * C4 template-catalog: classify a dbt macro's expansion shape from its source, so
 * `parseTemplated` can fill a statement/CTE-body macro placeholder with a shape-valid
 * fragment (`SELECT 1`) instead of the identifier fill — letting a macro-generated
 * query body (`with c as ({{ playoff_sim(...) }}) {{ playoff_sim_end(...) }}`) parse
 * natively instead of falling back to the blank cascade.
 *
 * Deliberately conservative: a macro whose body is a full query (first significant
 * SQL keyword is WITH or SELECT) classifies as `statement`; a trailing-conjunct macro
 * (body leads with AND/OR — the `generic_is_deleted` family appended after a complete
 * ON/WHERE expression) classifies as `conjunct` (sqllens 012caf8, fills `AND 1=1`);
 * everything else returns `undefined` (the identifier fill).
 *
 * Why a WHERE-leading body is NOT `conjunct`: the where-mode variant of the same macro
 * family sits after a bare `FROM t`, where the identifier fill parses (as an alias)
 * and `AND 1=1` breaks — and sqllens's lexical slot guard cannot separate that slot
 * from the ON-trailing one (both end in an operand word), so answering `conjunct`
 * there would be a 0->1 regression. Where-mode macros keep the identifier fill.
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
import { DefaultTemplateProvider } from './api';
import type { ExpansionShape, TemplateCall } from './api';

/**
 * Classify a macro's expansion shape from its `macro_sql` source. Returns `statement`
 * for a query-bodied macro (WITH/SELECT-first), `conjunct` for a trailing-conjunct
 * macro (AND/OR-first), `undefined` otherwise (identifier fill).
 *
 * When the call site is supplied, its LITERAL arguments are bound to the macro's
 * declared parameters before classification, so a body that leads with a parameter
 * (`{{ stat }} {{ column_name }}=false`, the mode-as-argument generic_is_deleted
 * signature) classifies by the call's literal mode word: 'and'/'or' → `conjunct`.
 * A 'where' mode still answers `undefined` — see the header on why no shipped
 * shape fits that slot (tripwire tests pin it; channel: sqllens-anvil).
 */
export function classifyMacroShape(macroSql: string | undefined, call?: TemplateCall): ExpansionShape | undefined {
	if (!macroSql) return undefined;
	const body = bindLiteralArgs(macroSql, call)
		// drop the {% macro ... %} opener and {% endmacro %} closer (whitespace-trim variants)
		.replace(/\{%-?\s*macro\b[\s\S]*?%\}/i, '')
		.replace(/\{%-?\s*endmacro\s*-?%\}/i, '')
		// drop remaining jinja tags/expressions/comments and SQL line comments
		.replace(/\{\{[\s\S]*?\}\}/g, ' ')
		.replace(/\{%[\s\S]*?%\}/g, ' ')
		.replace(/\{#[\s\S]*?#\}/g, ' ')
		.replace(/--[^\n]*/g, ' ')
		.trim();
	if (/^(with|select)\b/i.test(body)) return 'statement';
	if (/^(and|or)\b/i.test(body)) return 'conjunct';
	return undefined;
}

/**
 * Substitute the call's literal arguments into bare `{{ param }}` references.
 * Positional args map to the signature's parameter order; kwargs by name.
 * Non-literal args (`null` — computed expressions the engine refuses to
 * fabricate) bind nothing, leaving the reference for the jinja strip.
 */
function bindLiteralArgs(macroSql: string, call: TemplateCall | undefined): string {
	if (!call) return macroSql;
	const sig = /\{%-?\s*macro\s+[A-Za-z0-9_]+\s*\(([^)]*)\)/i.exec(macroSql);
	if (!sig) return macroSql;
	const params = sig[1].split(',').map(p => p.trim().split('=')[0].trim()).filter(Boolean);
	const bound = new Map<string, string>();
	params.forEach((p, i) => {
		const arg = call.args[i];
		if (typeof arg === 'string') bound.set(p, arg);
	});
	for (const kw of call.kwargs ?? []) {
		if (typeof kw.value === 'string' && params.includes(kw.name)) bound.set(kw.name, kw.value);
	}
	if (bound.size === 0) return macroSql;
	return macroSql.replace(/\{\{-?\s*([A-Za-z0-9_]+)\s*-?\}\}/g, (whole, name: string) => bound.get(name) ?? whole);
}

/**
 * The extension's template provider (sqllens 4e1b18b catalog unification): the
 * shipped `DefaultTemplateProvider` carries the dbt-builtin knowledge (config →
 * "nothing", ref/source relations, env_var strings); this subclass overrides
 * `shapeOf` with the manifest-sourced classifier. `super.shapeOf` runs FIRST so
 * builtins keep their default answers (ship-note contract). Lazy: a macro is
 * classified only when the engine asks about it (i.e. it appears as a tag);
 * package qualifiers are ignored — dbt macro names are unique enough by bare
 * name for the lookup.
 */
class AnvilTemplateProvider extends DefaultTemplateProvider {
	constructor(private readonly lookupMacroSql: (name: string) => string | undefined) {
		super();
	}

	override shapeOf(call: TemplateCall): ExpansionShape | undefined {
		return super.shapeOf(call) ?? classifyMacroShape(this.lookupMacroSql(call.name), call);
	}
}

/** Build a per-document provider from a macro-name -> macro_sql lookup. */
export function makeTemplateProvider(lookup: (name: string) => string | undefined): DefaultTemplateProvider {
	return new AnvilTemplateProvider(lookup);
}
