/**
 * Build the extension's `RefInfo` / `SourceInfo` / `MacroCallInfo` consumer shapes
 * from sqllens's R2 tag-AST (`TagNode[]` from `parseTemplated`), replacing the
 * jinja-tokenizer extractors (`extractRefs` / `extractSources` / `extractMacroCalls`)
 * on the NATIVE templated-parse path.
 *
 * Coordinate contract: every `PartSpan` on a `TagNode` carries ABSOLUTE, 0-based,
 * end-EXCLUSIVE char offsets into the raw document (`start`/`end`). The consumer
 * shapes want 0-based (line, col) where every `*Col` is a COLUMN ON A LINE. So the
 * only conversion here is offset -> (line, col), done with the SAME `buildLineStarts`
 * / `lineAtOffset` / `colAtOffset` helpers the jinja tokenizer (and thus the old
 * extractors) use — guaranteeing byte-identical positions for single-line tags.
 *
 * Deliberate deviations from the old extractors (see tag-infos.test.ts for the
 * field-for-field diffs, and the migration report):
 *
 *   - MULTI-LINE tags. The old extractors assumed a single line: every `*Col` was a
 *     column on the ref/source/macro identifier's line, and end columns were computed
 *     as `startCol + byteLength` (nonsense once the tag wraps). Here EACH field's
 *     line/col is derived from ITS OWN span offset, so a multi-line tag is span-accurate.
 *     `line`/`col` still point at the leading identifier (`ref` / `source` / macro name),
 *     matching the old single-line behavior where it mattered. The enrichment back-fill
 *     (`enrichTokensWithJinjaSpans`) keys on `line` + `jinjaCol`, which are the
 *     identifier line and the `{{` column on that line — identical to the old extractor
 *     for single-line tags, so aliases keep back-filling (ref AND source).
 *
 *   - 2-ARGUMENT `ref('pkg','model')`. The old `extractRefs` only matched `ref ( STRING )`
 *     and silently emitted NOTHING for the 2-arg package form. The tag-AST takes the LAST
 *     positional string as the model (dbt's actual semantics), so this emits a correct
 *     ref where the old extractor dropped it. Span-accurate, strictly more correct.
 *
 * SOURCES are now tag-sourced: the `source` TagNode carries `callSpan` (the sibling of
 * ref's callSpan, over the whole `source(…)` call), so `SourceInfo.line/col` — the bare
 * `source` identifier position — is derived from `callSpan.start`, exactly like ref.
 * name/table content cols come from the (quote-excluded) sourceName/tableName spans, and
 * jinja cols from tagSpan.
 *
 * MACRO CALLS are produced from BOTH tag regions, mirroring the old extractor which
 * scanned `{{ … }}` AND `{% … %}`:
 *   - `{{ … }}` EXPRESSION tags surface as `macro` TagNodes (each IS a MacroCall).
 *   - `{% … %}` BLOCK tags surface as `control` TagNodes carrying `calls: MacroCall[]`
 *     (every embedded call, source order, nested included) — `{% set x = m(1) %}`,
 *     `{% if m() %}`, `{% for x in m() %}`, `{% call m() %}`, `{% do run_query(m()) %}`.
 * Both are filtered by the SAME `NOT_MACRO_CALLS` set the old extractor used (so `ref`
 * / `source` / jinja keywords / dbt globals `config`/`var`/`env_var` never surface as
 * macro calls — e.g. the `config` callee in `{% if config(...) %}`), and a macro's own
 * declaration (`{% macro foo(a) %}` → `foo`) is skipped exactly as the old extractor
 * skipped a callee immediately preceded by the `macro` keyword.
 *
 * NESTED macro calls inside `{{ … }}` EXPRESSION tags are covered as of sqllens
 * `af1170c`: the `macro` TagNode now carries `calls: MacroCall[]` (source order, nested
 * included, `calls[0]` == the node's own top-level call) symmetric to `control.calls`,
 * so `{{ outer(inner()) }}` surfaces BOTH — field-for-field with the old paren-scan.
 * This was the last held gap; macroCalls now come off the tag-AST on the native path
 * (see tag-infos.test.ts for the parity cases).
 */
import type { MacroCall, PartSpan, TagNode } from '../api';
import type { FunctionInfo, MacroCallArgInfo, MacroCallInfo, RefInfo, SourceInfo } from '../../../services/parse-service';

/**
 * Jinja keywords and dbt globals that may appear as `identifier(` but are NOT
 * user-defined macro calls. `ref`, `source` and `function` have dedicated consumer
 * shapes; the rest are control flow, statement keywords, or jinja built-ins.
 */
export const NOT_MACRO_CALLS = new Set([
	'ref', 'source', 'function',
	'if', 'elif', 'else', 'endif',
	'for', 'endfor', 'in',
	'block', 'endblock',
	'macro', 'endmacro',
	'call', 'endcall',
	'set', 'endset', 'do',
	'with', 'endwith',
	'filter', 'endfilter',
	'from', 'import', 'as', 'include', 'extends',
	'raw', 'endraw',
	'not', 'and', 'or', 'is',
	'none', 'None', 'true', 'True', 'false', 'False',
	'config', 'var', 'env_var',
]);

export interface TagInfos {
	refs: RefInfo[];
	sources: SourceInfo[];
	macroCalls: MacroCallInfo[];
	functions: FunctionInfo[];
}

/**
 * Whether a tag emits a `RefInfo` / `SourceInfo` here, and which. Since sqllens 1.2.0
 * the tag-AST is dbt-agnostic (every `{{ … }}` is a `call` node); the ref/source
 * classification is ours, by callee name. A confirmed reference needs a CLOSED tag
 * and LITERAL name args (dbt: `ref`'s model is the last arg; `source`'s are args 0/1) —
 * a computed arg (`ref(var('x'))`, value null) is not one. This is the SINGLE predicate
 * `tagInfos` (emission) and `backfillSymAliases` (index alignment) share, so they never
 * disagree on the count or order.
 */
export function emittedTagKind(tag: TagNode): 'ref' | 'source' | 'function' | undefined {
	if (tag.kind !== 'call' || tag.incomplete) return undefined;
	if (tag.name === 'ref') {
		const arg = tag.args[tag.args.length - 1];
		return arg && arg.value !== null && arg.valueSpan !== undefined ? 'ref' : undefined;
	}
	if (tag.name === 'function') {
		// dbt: `function('name')` / `function('pkg', 'name')`, positional only; the name is the last arg.
		if (tag.args.length !== 1 && tag.args.length !== 2) return undefined;
		const arg = tag.args[tag.args.length - 1];
		return arg && arg.value !== null && arg.valueSpan !== undefined ? 'function' : undefined;
	}
	if (tag.name === 'source') {
		const src = tag.args[0];
		const tbl = tag.args[1];
		return src && src.value !== null && src.valueSpan !== undefined
			&& tbl && tbl.value !== null && tbl.valueSpan !== undefined ? 'source' : undefined;
	}
	return undefined;
}

/**
 * Project sqllens R2 tag nodes onto the extension's ref / source / macro consumer
 * shapes. Every position is a direct PartSpan field read (line 1-based -> 0-based;
 * column/endColumn already 0-based) — the offset->line/col conversion pass died
 * with sqllens beb5adb, which carries end positions on every span.
 */
export function tagInfos(tags: TagNode[]): TagInfos {
	const refs: RefInfo[] = [];
	const sources: SourceInfo[] = [];
	const macroCalls: MacroCallInfo[] = [];
	const functions: FunctionInfo[] = [];

	for (const tag of tags) {
		if (tag.kind === 'call') {
			const emitted = emittedTagKind(tag);
			if (emitted === 'ref') {
				// dbt: the model is the LAST positional arg (`ref('model')` / `ref('pkg','model')`
				// / `ref(model='x')`); `value`/`valueSpan` are the quote-excluded literal, exactly
				// what the old `tag.model`/`modelSpan` carried.
				const arg = tag.args[tag.args.length - 1]!;
				refs.push({
					model: arg.value!,
					line: tag.callSpan.line - 1,
					col: tag.callSpan.column,
					modelCol: arg.valueSpan!.column,
					modelEndCol: arg.valueSpan!.endColumn,
					jinjaCol: tag.tagSpan.column,
					jinjaEndCol: tag.tagSpan.endColumn,
				});
			} else if (emitted === 'source') {
				// dbt: source(source_name, table_name) — args 0 and 1 positionally.
				const src = tag.args[0]!;
				const tbl = tag.args[1]!;
				sources.push({
					sourceName: src.value!,
					tableName: tbl.value!,
					line: tag.callSpan.line - 1,
					col: tag.callSpan.column,
					sourceNameCol: src.valueSpan!.column,
					sourceNameEndCol: src.valueSpan!.endColumn,
					tableNameCol: tbl.valueSpan!.column,
					tableNameEndCol: tbl.valueSpan!.endColumn,
					jinjaCol: tag.tagSpan.column,
					jinjaEndCol: tag.tagSpan.endColumn,
				});
			} else if (emitted === 'function') {
				const arg = tag.args[tag.args.length - 1]!;
				const pkg = tag.args.length === 2 ? tag.args[0] : undefined;
				functions.push({
					name: arg.value!,
					...(pkg && pkg.value !== null ? { packageName: pkg.value } : {}),
					line: tag.callSpan.line - 1,
					col: tag.callSpan.column,
					nameCol: arg.valueSpan!.column,
					nameEndCol: arg.valueSpan!.endColumn,
					jinjaCol: tag.tagSpan.column,
					jinjaEndCol: tag.tagSpan.endColumn,
				});
			} else if (!tag.incomplete) {
				// Every other closed expression tag, INCLUDING a ref/source/function with computed
				// args or a `config(...)`/`var(...)` tag: the per-call filter below drops the
				// builtin callee itself, while a macro nested in its arguments still surfaces.
				// A macro expression tag. `calls` is the top-level call (`calls[0]`) plus every
				// nested call in source order, so `{{ outer(inner()) }}` surfaces both. Filtered
				// by NOT_MACRO_CALLS (`ref`/`source`/`config`/`var`/`env_var`/keywords never surface).
				for (const call of tag.calls) {
					if (NOT_MACRO_CALLS.has(call.name)) continue;
					macroCalls.push(macroInfo(call, tag.tagSpan));
				}
			}
			// A ref/source call with computed (non-literal) args emits nothing.
		} else if (tag.kind === 'control') {
			// `{% … %}` block tag — each embedded call, filtered like the old extractor.
			let declSkipped = false;
			for (const call of tag.calls) {
				// Skip the macro's OWN declaration (`{% macro foo(a) %}` → `foo`): drop the first
				// `calls` entry whose name is the declared macro name.
				if (tag.keyword === 'macro' && !declSkipped && call.name === tag.name) {
					declSkipped = true;
					continue;
				}
				if (NOT_MACRO_CALLS.has(call.name)) continue;
				macroCalls.push(macroInfo(call, tag.tagSpan));
			}
		}
		// kind 'other': not a ref/source/macro-call site.
	}

	return { refs, sources, macroCalls, functions };
}

/**
 * Map one MacroCall to a MacroCallInfo, converting every span offset to line/col.
 * `tagSpan` is the OWNING tag's span: a `{{ }}` macro node passes its own `tagSpan`;
 * a `{% %}` control-tag call passes the control node's `tagSpan` (the call has no tag
 * span of its own) — mirroring the old extractor's `jinjaLine`/`jinjaCol`/`jinjaEndCol`
 * = the enclosing tag opener for both regions.
 */
function macroInfo(mc: MacroCall, tagSpan: PartSpan): MacroCallInfo {
	const args: MacroCallArgInfo[] = mc.args.map(a => ({
		line: a.span.line - 1,
		col: a.span.column,
		endCol: a.span.endColumn,
	}));

	return {
		name: mc.name,
		...(mc.packageName !== undefined ? { packageName: mc.packageName } : {}),
		// bare macro-name identifier.
		line: mc.nameSpan.line - 1,
		col: mc.nameSpan.column,
		endCol: mc.nameSpan.endColumn,
		...(mc.packageSpan !== undefined
			? { packageCol: mc.packageSpan.column, packageEndCol: mc.packageSpan.endColumn }
			: {}),
		// full enclosing tag.
		jinjaCol: tagSpan.column,
		jinjaEndCol: tagSpan.endColumn,
		jinjaLine: tagSpan.line - 1,
		// argument list `( … )`.
		...(mc.argsSpan !== undefined
			? { argsCol: mc.argsSpan.column, argsEndCol: mc.argsSpan.endColumn }
			: {}),
		args,
	};
}
