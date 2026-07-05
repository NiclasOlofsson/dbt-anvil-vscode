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
import { NOT_MACRO_CALLS } from '../../extractors/jinja-tag-extractors';
import type { MacroCallArgInfo, MacroCallInfo, RefInfo, SourceInfo } from '../../../services/parse-service';

export interface TagInfos {
	refs: RefInfo[];
	sources: SourceInfo[];
	macroCalls: MacroCallInfo[];
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

	for (const tag of tags) {
		if (tag.kind === 'ref') {
			refs.push({
				model: tag.model,
				// line/col anchor on the `ref` identifier (callSpan starts at the callee),
				// NOT the `{{` — matches the old extractor's `id.line`/`id.col`.
				line: tag.callSpan.line - 1,
				col: tag.callSpan.column,
				// model name string CONTENT (quotes excluded — modelSpan is content-only).
				modelCol: tag.modelSpan.column,
				modelEndCol: tag.modelSpan.endColumn,
				// full `{{ … }}` tag span.
				jinjaCol: tag.tagSpan.column,
				jinjaEndCol: tag.tagSpan.endColumn,
			});
		} else if (tag.kind === 'source') {
			sources.push({
				sourceName: tag.sourceName,
				tableName: tag.tableName,
				// line/col anchor on the bare `source` identifier (callSpan starts at the
				// callee, exactly like ref) — matches the old extractor's `id.line`/`id.col`.
				line: tag.callSpan.line - 1,
				col: tag.callSpan.column,
				// source/table string CONTENT (quotes excluded — the spans are content-only).
				sourceNameCol: tag.sourceNameSpan.column,
				sourceNameEndCol: tag.sourceNameSpan.endColumn,
				tableNameCol: tag.tableNameSpan.column,
				tableNameEndCol: tag.tableNameSpan.endColumn,
				// full `{{ … }}` tag span.
				jinjaCol: tag.tagSpan.column,
				jinjaEndCol: tag.tagSpan.endColumn,
			});
		} else if (tag.kind === 'macro') {
			// `{{ … }}` expression macro node. `calls` (af1170c) is the top-level call
			// (`calls[0]`, == the node's own name/args) PLUS every nested call in source
			// order, symmetric to `control.calls` — so `{{ outer(inner()) }}` surfaces
			// BOTH, matching the old tokenizer's paren-scan. Filtered by the same
			// NOT_MACRO_CALLS set (`ref`/`source`/`var`/`env_var`/`config` never surface).
			for (const call of tag.calls) {
				if (NOT_MACRO_CALLS.has(call.name)) continue;
				macroCalls.push(macroInfo(call, tag.tagSpan));
			}
		} else if (tag.kind === 'control') {
			// `{% … %}` block tag — each embedded call, filtered like the old extractor.
			let declSkipped = false;
			for (const call of tag.calls) {
				// Skip the macro's OWN declaration (`{% macro foo(a) %}` → `foo`): the old
				// extractor skips a callee immediately preceded by the `macro` keyword. The
				// declaration is the first call in source order, so drop the first `calls`
				// entry whose name is the declared macro name.
				if (tag.keyword === 'macro' && !declSkipped && call.name === tag.name) {
					declSkipped = true;
					continue;
				}
				// `ref`/`source`/jinja keywords/dbt globals (`config`/`var`/`env_var`) that
				// appear as callees INSIDE a control tag are not user macro calls.
				if (NOT_MACRO_CALLS.has(call.name)) continue;
				macroCalls.push(macroInfo(call, tag.tagSpan));
			}
		}
		// var / env_var / config / other: not ref/source/macro-call sites.
	}

	return { refs, sources, macroCalls };
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
