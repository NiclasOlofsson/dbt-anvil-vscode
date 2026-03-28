import { buildBranchTree, countVariants, selectVariant } from './branch-enumerator';
import type { DocumentNode } from './branch-enumerator';
import { tokenize } from './jinja-tokenizer';
import type { JinjaToken } from './jinja-tokenizer';

export interface SqlVariant {
	/** 0-based variant index, matching selectVariant(nodes, index). */
	index: number;
	/**
	 * SQL string with the same length as the original source.
	 * Inactive Jinja spans are replaced with spaces so character offsets of
	 * active tokens are preserved, making error positions reported by the
	 * bridge directly usable against the original document.
	 */
	sql: string;
}

/**
 * Collects all token start/end positions that are NOT in the active set and
 * blanks them out in the source string.
 *
 * All tokens in the document are visited; any token whose `start` offset is
 * absent from the active-token set is masked with spaces.
 */
function collectAllTokens(nodes: DocumentNode[]): JinjaToken[] {
	const all: JinjaToken[] = [];

	function visit(node: DocumentNode): void {
		if (node.type === 'fixed') {
			all.push(...node.tokens);
		} else {
			for (const arm of node.branches) {
				if (arm.header !== undefined) {
					all.push(arm.header);
				}
				for (const child of arm.body) {
					visit(child);
				}
			}
			if (node.endif !== undefined) {
				all.push(node.endif);
			}
		}
	}

	for (const node of nodes) {
		visit(node);
	}
	return all;
}

function buildSql(source: string, sortedTokens: JinjaToken[], activeStarts: Set<number>): string {
	// Walk the pre-sorted token list once, copying active spans and writing
	// spaces over inactive ones — O(tokens + sourceLength) per variant.
	const parts: string[] = [];
	let cursor = 0;
	for (const token of sortedTokens) {
		if (token.start > cursor) {
			parts.push(source.slice(cursor, token.start));
		}
		if (activeStarts.has(token.start)) {
			parts.push(token.raw);
		} else {
			parts.push(' '.repeat(token.end - token.start));
		}
		cursor = token.end;
	}
	if (cursor < source.length) {
		parts.push(source.slice(cursor));
	}
	return parts.join('');
}

/**
 * Generates one SQL string per Jinja2 branch variant in `source`.
 *
 * - When the source has no `{% if %}` blocks, returns a single variant whose
 *   SQL equals the original source.
 * - Each returned SQL string has the same `.length` as `source`, ensuring
 *   character offsets from bridge error responses map directly to the source.
 * - Inactive spans (tokens on untaken branch arms) are replaced with spaces.
 *   The header token of the chosen arm (e.g. `{% if x %}`) is kept so parsers
 *   can still identify the conditional structure, but only *one* arm per
 *   conditional is materialized.
 *
 * @param source - The raw Jinja-SQL document text.
 * @returns Array of SqlVariant, length == countVariants(buildBranchTree(tokenize(source))).
 */
export function generateVariants(source: string): SqlVariant[] {
	const tokens = tokenize(source);
	const nodes = buildBranchTree(tokens);
	// Sort once — reused for every variant.
	const sortedTokens = collectAllTokens(nodes).sort((a, b) => a.start - b.start);
	const total = countVariants(nodes);
	const variants: SqlVariant[] = [];

	for (let i = 0; i < total; i++) {
		const active = selectVariant(nodes, i);
		const activeStarts = new Set(active.map(t => t.start));
		variants.push({
			index: i,
			sql: buildSql(source, sortedTokens, activeStarts),
		});
	}

	return variants;
}
