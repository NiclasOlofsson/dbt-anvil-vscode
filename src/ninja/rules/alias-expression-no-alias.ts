import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { SnippetAction, type NinjaViolation } from '../violation';
import { lastContentTokenOnLine } from '../fix-utils';

export const expressionNoAliasRule: TokenRule = {
	id: 'ninja.aliasing.expression-no-alias',
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'warning',
	description: 'Expressions in the final SELECT should have an explicit alias.',
	actionKinds: ['snippet'],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		if (!model.finalSelect) return [];
		// Pass 2 AST column numbers are in rendered-space and not remapped —
		// building ranges from them causes negative-character errors.
		if (model.isPass2) return [];
		const violations: NinjaViolation[] = [];

		for (const col of model.finalSelect.columns) {
			if (!col.expression) continue;
			if (col.aliasLine !== undefined) continue;
			// Synthesized columns (e.g. from SELECT * expansion) may have negative
			// col values when the anchor position is smaller than the name length.
			if (col.col < 0 || col.endCol < 0) continue;

			const lastTok = model.sqlTokens ? lastContentTokenOnLine(model.sqlTokens, col.endLine) : undefined;
			const insertCol = lastTok && lastTok.col > col.endCol ? lastTok.col : col.endCol;
			const insertPos = new vscode.Position(col.endLine, insertCol);
			const placeholder = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col.name) ? col.name : 'alias';

			violations.push({
				rule: 'ninja.aliasing.expression-no-alias',
				message: `Expression column '${col.expression}' should have an explicit alias.`,
				range: new vscode.Range(col.line, col.col, col.endLine, col.endCol),
				action: { type: SnippetAction.TYPE, position: insertPos, snippet: ` as \${1:${placeholder}}` },
			});
		}

		return violations;
	},
};
