import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';
import { deleteOp, type FixOp } from '../fix-op';

/**
 * Flags CTEs that are defined but never referenced in any FROM/JOIN.
 *
 * Uses model.symbols to find table/CTE reference usages, and model.ninjaSqlTokens
 * to build precise deletion fixes (handles only-CTE, first-of-many, and last-of-many).
 */
export const unusedCteRule: TokenRule = {
	id: 'ninja.structure.unused-cte',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'info',
	description: 'CTE is defined but never referenced.',
	actionKinds: ['fix'],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (model.ctes.length === 0) return [];

		// Collect table/CTE names from real FROM/JOIN references only.
		// A CTE's declaration site (`WITH name AS (...)`) is a separate Sym with
		// modifiers:['declaration'] — filtering to 'reference' excludes it.
		const usedNames = new Set<string>();
		for (const s of model.symbols ?? []) {
			if ((s.kind === 'table' || s.kind === 'cte') && s.modifiers.includes('reference')) {
				usedNames.add(s.name.toLowerCase());
			}
		}

		const violations: NinjaViolation[] = [];

		for (let i = 0; i < model.ctes.length; i++) {
			const cte = model.ctes[i];
			if (usedNames.has(cte.name.toLowerCase())) continue;

			const nameCol = cte.col ?? 0;
			const range = new vscode.Range(cte.line, nameCol, cte.line, nameCol + cte.name.length);

			const deleteEdits = buildDeleteFix(model.ctes, i, sqlOnly(model.ninjaSqlTokens), document);
			violations.push({
				rule: 'ninja.structure.unused-cte',
				message: `CTE '${cte.name}' is defined but never referenced.`,
				range,
				action: deleteEdits ? { type: FixAction.TYPE, ops: deleteEdits, autoFix: false } : undefined,
			});
		}

		return violations;
	},
};

/**
 * Build a TextEdit[] that deletes an unused CTE from the WITH clause.
 *
 * Three cases:
 * 1. Only CTE → delete entire WITH block (WITH keyword through closing paren)
 * 2. First of many → delete from CTE name through the comma after closing paren
 * 3. Middle/Last → delete from the comma before CTE name through closing paren
 */
function buildDeleteFix(
	ctes: typeof unusedCteRule extends never ? never : import('../../services/parse-service').CteInfo[],
	index: number,
	sqlTokens: import('../../ftl/sql-tokens').SqlToken[] | undefined,
	document: vscode.TextDocument,
): FixOp[] | undefined {
	if (!sqlTokens || sqlTokens.length === 0) return undefined;

	const cte = ctes[index];
	if (cte.endLine === undefined) return undefined;

	const totalCtes = ctes.length;

	if (totalCtes === 1) {
		return deleteOnlyCte(cte, sqlTokens, document);
	}

	if (index === 0) {
		return deleteFirstCte(cte, ctes[1], sqlTokens, document);
	}

	return deleteNonFirstCte(cte, ctes[index - 1], document);
}

/** Delete the entire WITH clause when there's only one CTE. */
function deleteOnlyCte(
	cte: import('../../services/parse-service').CteInfo,
	sqlTokens: import('../../ftl/sql-tokens').SqlToken[],
	document: vscode.TextDocument,
): FixOp[] | undefined {
	// Find the WITH keyword token
	const withToken = sqlTokens.find(t => t.type === 'WITH');
	if (!withToken) return undefined;

	const startPos = document.positionAt(withToken.start);
	const endLine = cte.endLine;
	const endCol = cte.endCol ?? document.lineAt(endLine).text.length;
	const endPos = new vscode.Position(endLine, endCol);

	// Extend end to consume the rest of the line if only whitespace remains
	const lineText = document.lineAt(endLine).text;
	const afterEnd = lineText.slice(endCol).trim();
	let deleteEnd = endPos;
	if (afterEnd === '' && endLine + 1 < document.lineCount) {
		deleteEnd = new vscode.Position(endLine + 1, 0);
	}

	// Extend start backwards to consume leading whitespace on the WITH line
	let deleteStart = startPos;
	const withLineText = document.lineAt(startPos.line).text;
	if (withLineText.slice(0, startPos.character).trim() === '' && startPos.line > 0) {
		// Delete from end of previous line
		deleteStart = new vscode.Position(startPos.line, 0);
	}

	return [deleteOp(new vscode.Range(deleteStart, deleteEnd))];
}

/** Delete the first CTE of many: from CTE name AS ( ... ) up to but not including next CTE name. */
function deleteFirstCte(
	cte: import('../../services/parse-service').CteInfo,
	nextCte: import('../../services/parse-service').CteInfo,
	_sqlTokens: import('../../ftl/sql-tokens').SqlToken[],
	document: vscode.TextDocument,
): FixOp[] | undefined {
	const nameCol = cte.col ?? 0;
	const startPos = new vscode.Position(cte.line, nameCol);

	// Delete from CTE name through to the start of the next CTE name
	const nextNameCol = nextCte.col ?? 0;
	const endPos = new vscode.Position(nextCte.line, nextNameCol);

	// Extend start to beginning of line if only whitespace before
	let deleteStart = startPos;
	const lineText = document.lineAt(cte.line).text;
	if (lineText.slice(0, nameCol).trim() === '') {
		deleteStart = new vscode.Position(cte.line, 0);
	}

	return [deleteOp(new vscode.Range(deleteStart, endPos))];
}

/** Delete a non-first CTE: from the end of the previous CTE through this CTE's closing paren. */
function deleteNonFirstCte(
	cte: import('../../services/parse-service').CteInfo,
	prevCte: import('../../services/parse-service').CteInfo,
	document: vscode.TextDocument,
): FixOp[] | undefined {
	// Start from end of previous CTE's closing paren
	const prevEndLine = prevCte.endLine;
	const prevEndCol = prevCte.endCol ?? document.lineAt(prevEndLine).text.length;
	const startPos = new vscode.Position(prevEndLine, prevEndCol);

	// End at this CTE's closing paren
	const endLine = cte.endLine;
	const endCol = cte.endCol ?? document.lineAt(endLine).text.length;
	let endPos = new vscode.Position(endLine, endCol);

	// Extend end to consume the rest of the line if only whitespace remains
	const lineText = document.lineAt(endLine).text;
	const afterEnd = lineText.slice(endCol).trim();
	if (afterEnd === '' && endLine + 1 < document.lineCount) {
		endPos = new vscode.Position(endLine + 1, 0);
	}

	return [deleteOp(new vscode.Range(startPos, endPos))];
}
