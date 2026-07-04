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
 *     `line`/`col` still point at the leading identifier (`ref` / macro name), matching
 *     the old single-line behavior where it mattered. The enrichment back-fill
 *     (`enrichTokensWithJinjaSpans`) keys on `ref.line` + `ref.jinjaCol`, which are the
 *     identifier line and the `{{` column on that line — identical to the old extractor
 *     for single-line tags, so aliases keep back-filling.
 *
 *   - 2-ARGUMENT `ref('pkg','model')`. The old `extractRefs` only matched `ref ( STRING )`
 *     and silently emitted NOTHING for the 2-arg package form. The tag-AST takes the LAST
 *     positional string as the model (dbt's actual semantics), so this emits a correct
 *     ref where the old extractor dropped it. Span-accurate, strictly more correct.
 *
 * SOURCES are deliberately NOT emitted here. The `source` TagNode carries
 * `sourceNameSpan` / `tableNameSpan` / `tagSpan` but NO span for the bare `source`
 * callee identifier (ref has `callSpan`; source has no equivalent), so `SourceInfo.col`
 * — the column of the `source` identifier — cannot be produced. Rather than fabricate
 * it by scanning the raw text, sources stay on the old `extractSources` extractor and
 * the missing-span is raised upstream. `sources` is always `[]` here.
 *
 * MACRO CALLS are produced from `{{ … }}` EXPRESSION-tag macro nodes only; they are
 * field-for-field equal to the old extractor for simple single-line calls (used by the
 * comparison test). They are NOT wired into the live model: `{% set/if/call … %}`
 * BLOCK-tag macro calls surface as `control` nodes (no call detail) in R2, nested calls
 * capture the top-level call only, and multi-line macro tags diverge (span-accurate vs
 * lossy) — so the live path keeps ALL macro calls on `extractMacroCalls` until the
 * block-tag coverage lands upstream.
 */
import type { TagNode } from '../api';
import { buildLineStarts, colAtOffset, lineAtOffset } from '../../jinja-spans';
import type { MacroCallArgInfo, MacroCallInfo, RefInfo, SourceInfo } from '../../../services/parse-service';

export interface TagInfos {
	refs: RefInfo[];
	/** Always empty — see the file header: the source TagNode has no callee span, so
	 *  `SourceInfo.col` is underivable and sources stay on the old extractor. */
	sources: SourceInfo[];
	macroCalls: MacroCallInfo[];
}

/**
 * Project sqllens R2 tag nodes onto the extension's ref / source / macro consumer
 * shapes. `rawSql` is the ORIGINAL document the spans index into (offset -> line/col).
 */
export function tagInfos(tags: TagNode[], rawSql: string): TagInfos {
	const lineStarts = buildLineStarts(rawSql);
	const ln = (off: number): number => lineAtOffset(off, lineStarts);
	const cl = (off: number): number => colAtOffset(off, lineStarts);

	const refs: RefInfo[] = [];
	const macroCalls: MacroCallInfo[] = [];

	for (const tag of tags) {
		if (tag.kind === 'ref') {
			refs.push({
				model: tag.model,
				// line/col anchor on the `ref` identifier (callSpan starts at the callee),
				// NOT the `{{` — matches the old extractor's `id.line`/`id.col`.
				line: ln(tag.callSpan.start),
				col: cl(tag.callSpan.start),
				// model name string CONTENT (quotes excluded — modelSpan is content-only).
				modelCol: cl(tag.modelSpan.start),
				modelEndCol: cl(tag.modelSpan.end),
				// full `{{ … }}` tag span.
				jinjaCol: cl(tag.tagSpan.start),
				jinjaEndCol: cl(tag.tagSpan.end),
			});
		} else if (tag.kind === 'macro') {
			macroCalls.push(macroInfo(tag, ln, cl));
		}
		// source / control / var / env_var / config / other: not emitted here
		// (sources -> old extractor; the rest are not ref/source/macro-call sites).
	}

	return { refs, sources: [], macroCalls };
}

/** Map one macro TagNode to a MacroCallInfo, converting every span offset to line/col. */
function macroInfo(
	tag: Extract<TagNode, { kind: 'macro' }>,
	ln: (off: number) => number,
	cl: (off: number) => number,
): MacroCallInfo {
	const args: MacroCallArgInfo[] = tag.args.map(a => ({
		line: ln(a.span.start),
		col: cl(a.span.start),
		endCol: cl(a.span.end),
	}));

	return {
		name: tag.name,
		...(tag.packageName !== undefined ? { packageName: tag.packageName } : {}),
		// bare macro-name identifier.
		line: ln(tag.nameSpan.start),
		col: cl(tag.nameSpan.start),
		endCol: cl(tag.nameSpan.end),
		...(tag.packageSpan !== undefined
			? { packageCol: cl(tag.packageSpan.start), packageEndCol: cl(tag.packageSpan.end) }
			: {}),
		// full enclosing tag.
		jinjaCol: cl(tag.tagSpan.start),
		jinjaEndCol: cl(tag.tagSpan.end),
		jinjaLine: ln(tag.tagSpan.start),
		// argument list `( … )`.
		...(tag.argsSpan !== undefined
			? { argsCol: cl(tag.argsSpan.start), argsEndCol: cl(tag.argsSpan.end) }
			: {}),
		args,
	};
}
