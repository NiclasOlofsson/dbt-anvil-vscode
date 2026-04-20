/**
 * Unified token stream for ninja consumers — interleaves sqlglot's lexer
 * output (`SqlToken`) with the jinja tokenizer's output (`JinjaToken`) by
 * source position. SQL tokens that fall inside a jinja region (the lexer
 * sees the blanker's placeholders, e.g. `VAR(__j0__)`) are dropped — the
 * jinja tokens are the truth at those offsets.
 *
 * Each entry carries a `category` discriminator (`'sql'` | `'jinja'`) so
 * consumers can branch on origin without re-checking the `type` string.
 * The original token shapes are preserved verbatim — this is a tagged
 * union, not a normalized record. That keeps existing SqlToken consumers
 * working when they receive a NinjaSqlToken filtered down to category 'sql'.
 *
 * On `*_open` jinja tokens, the `tagEnd` field holds the offset just past
 * the matching close. Consumers wanting opaque-jinja behaviour (e.g. the
 * debugger walking statement boundaries) skip from any `*_open` straight
 * to `tagEnd` without scanning forward for the close.
 *
 * Position semantics differ between the two inputs:
 *   - `SqlToken.col` is sqlglot's exclusive end column on the start line.
 *   - `JinjaToken.col` is the 0-based start column.
 * Consumers should use `start`/`end` for cross-category position math —
 * those are normalized 0-based offsets in raw-source space on both sides.
 */
import type { SqlToken } from './parse-result';
import type { JinjaToken } from './jinja-tokenizer';

export type NinjaSqlToken =
	| ({ category: 'sql' } & SqlToken)
	| ({ category: 'jinja' } & JinjaToken);

/**
 * Extract only the sql-category tokens from a unified stream.
 * Centralizes the discriminator filter so consumers don't repeat the
 * type-narrowing predicate at every call site.
 */
export function sqlOnly(stream: NinjaSqlToken[] | undefined): SqlToken[] {
	if (!stream) return [];
	const out: SqlToken[] = [];
	for (const t of stream) if (t.category === 'sql') out.push(t);
	return out;
}

/**
 * Lines whose first content token is a jinja tag rather than SQL.
 *
 * Indent rules rely on this to avoid re-indenting a line whose leading
 * content is `{{ ref(...) }}` or similar — the first SQL token on such a
 * line sits AFTER the jinja, so replacing `[col 0 .. sqlTokenCol)` would
 * silently delete the jinja. Rules should skip any line in this set.
 */
export function jinjaLeadingLines(stream: NinjaSqlToken[] | undefined): Set<number> {
	const result = new Set<number>();
	if (!stream) return result;
	const seen = new Set<number>();
	for (const t of stream) {
		if (seen.has(t.line)) continue;
		seen.add(t.line);
		if (t.category === 'jinja') result.add(t.line);
	}
	return result;
}

/**
 * Merge sqlglot and jinja token streams into a single position-ordered
 * sequence. SQL tokens whose `start` falls inside a jinja tag region (as
 * marked by `*_open` tokens carrying `tagEnd`) are dropped — the jinja
 * stream is authoritative inside its own regions.
 *
 * Stable: when a surviving sql and jinja token share the same `start`
 * offset, the sql token comes first.
 */
export function mergeSqlAndJinjaTokens(
	sqlTokens: SqlToken[],
	jinjaTokens: JinjaToken[],
): NinjaSqlToken[] {
	const regions = collectJinjaRegions(jinjaTokens);
	const filteredSql = dropSqlInsideJinja(sqlTokens, regions);

	const out: NinjaSqlToken[] = [];
	let i = 0;
	let j = 0;
	while (i < filteredSql.length && j < jinjaTokens.length) {
		if (filteredSql[i].start <= jinjaTokens[j].start) {
			out.push({ category: 'sql', ...filteredSql[i++] });
		} else {
			out.push({ category: 'jinja', ...jinjaTokens[j++] });
		}
	}
	while (i < filteredSql.length) out.push({ category: 'sql', ...filteredSql[i++] });
	while (j < jinjaTokens.length) out.push({ category: 'jinja', ...jinjaTokens[j++] });
	return out;
}

/** Pull `[start, tagEnd)` regions off every `*_open` token. */
function collectJinjaRegions(jinjaTokens: JinjaToken[]): Array<{ start: number; end: number }> {
	const regions: Array<{ start: number; end: number }> = [];
	for (const t of jinjaTokens) {
		if (t.tagEnd !== undefined) regions.push({ start: t.start, end: t.tagEnd });
	}
	return regions;
}

/**
 * Drop sql tokens whose `start` lies inside any jinja region.
 * Both inputs are in source order; advances a region cursor in lockstep.
 */
function dropSqlInsideJinja(sqlTokens: SqlToken[], regions: Array<{ start: number; end: number }>): SqlToken[] {
	if (regions.length === 0) return sqlTokens;
	const out: SqlToken[] = [];
	let r = 0;
	for (const tok of sqlTokens) {
		while (r < regions.length && tok.start >= regions[r].end) r++;
		if (r >= regions.length || tok.start < regions[r].start) out.push(tok);
		// otherwise tok.start is in [regions[r].start, regions[r].end) — drop it
	}
	return out;
}
