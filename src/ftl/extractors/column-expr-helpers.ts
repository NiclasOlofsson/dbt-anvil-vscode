import type { AstPayload } from '../parse-result';
import { childOf, findDescendant, findPositionedIdentifier, identifierName, leafValue } from '../ast-utils';

/** Maximum length of an inlined expression string in lineage / final-select payloads. */
export const MAX_EXPR_LEN = 200;

/** Truncate `expr` to `MAX_EXPR_LEN` chars, replacing the tail with an ellipsis. */
export function truncateExpression(expr: string): string {
	return expr.length > MAX_EXPR_LEN ? `${expr.slice(0, MAX_EXPR_LEN - 3)}...` : expr;
}

export interface ColumnExprMetadata {
	/** Resolved column name (alias if present, else first identifier). `undefined` for Star and unnamed exprs. */
	name?: string;
	/** 0-based source line of the name's identifier. Defaults to 0 when no positioned identifier exists. */
	line: number;
	/** 0-based start column of the name's identifier. `undefined` when no position metadata is present. */
	col?: number;
}

/**
 * Resolve `name`, `line`, and `col` for a SELECT-list column expression in a single pass.
 *
 * Position is taken from the user-written alias identifier when present (an `Alias` whose
 * `alias` child is an Identifier with `_meta`), otherwise from the first descendant
 * Identifier with `_meta`. Synthesised identifiers (no `_meta`) are skipped — those
 * appear when sqlglot's `qualify()` rewrote the expression.
 *
 * Replaces the legacy `_colExprName`, `_colExprLine`, and `_colExprCol` triple.
 */
export function getColumnExprMetadata(ast: AstPayload[], exprIdx: number): ColumnExprMetadata {
	const name = extractColumnExprName(ast, exprIdx);

	const ident = findPositionedIdentifier(ast, exprIdx, { aliasOnly: true })
		?? findPositionedIdentifier(ast, exprIdx);

	let line = 0;
	let col: number | undefined;
	if (ident?.node.m?.line !== undefined) {
		line = ident.node.m.line - 1;
		const m = ident.node.m;
		if (m.col !== undefined) {
			const identName = identifierName(ast, ident.index);
			if (identName) col = m.col - identName.length;
		}
	}

	return name !== undefined ? { name, line, col } : { line, col };
}

/**
 * Resolve just the column-name portion of {@link getColumnExprMetadata}.
 *
 * `Alias.alias` in serde.dump is normally an Identifier class node; as a fallback,
 * plain-string leaf values (rare) are also handled. Returns `'*'` for the qualified
 * wildcard `cp.*` so callers can flag the parent CTE as wildcard-containing.
 */
export function extractColumnExprName(ast: AstPayload[], exprIdx: number): string | undefined {
	if (ast[exprIdx]?.c === 'Star') return undefined;
	if (ast[exprIdx]?.c === 'Column') {
		const thisChild = childOf(ast, exprIdx, 'this');
		if (thisChild?.node.c === 'Star') return '*';
	}
	if (ast[exprIdx]?.c === 'Alias') {
		const leaf = leafValue(ast, exprIdx, 'alias');
		if (typeof leaf === 'string' && leaf) return leaf;
		const aliasIdent = childOf(ast, exprIdx, 'alias');
		if (aliasIdent?.node.c === 'Identifier') return identifierName(ast, aliasIdent.index);
	}
	const ident = findDescendant(ast, exprIdx, 'Identifier');
	if (ident) return identifierName(ast, ident.index);
	return undefined;
}
