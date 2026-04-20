import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import type { TableRefToken } from '../../services/parse-service';

const RULE_ID = 'ninja.aliasing.table-as';

export const tableAsRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'info',
	description: 'Table aliases should use the explicit AS keyword.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		if (!ctx.config.convention.explicitAs) return [];

		const { model, document } = ctx;
		if (!model.tokens?.length) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		const tableRefs = model.tokens.filter(t => t.type === 'table_ref') as TableRefToken[];

		for (const ref of tableRefs) {
			if (!ref.alias) continue;
			if (ref.synthesized) continue;
			if (ref.cteDefinition) continue;

			if (ref.aliasLine === undefined || ref.aliasCol === undefined) continue;
			if (ref.line >= document.lineCount || ref.aliasLine >= document.lineCount) continue;

			// Look at the source text between the table name and the alias.
			// If it contains the AS keyword the alias is already explicit.
			const nameEnd = document.offsetAt(new vscode.Position(ref.line, ref.endCol));
			const aliasStart = document.offsetAt(new vscode.Position(ref.aliasLine, ref.aliasCol));
			const between = text.slice(nameEnd, aliasStart);

			if (/\bAS\b/i.test(between)) continue;

			const aliasEndCol = ref.aliasEndCol ?? ref.aliasCol + ref.alias.length;
			const range = new vscode.Range(ref.aliasLine, ref.aliasCol, ref.aliasLine, aliasEndCol);

			violations.push({
				rule: RULE_ID,
				message: `Table alias '${ref.alias}' should use explicit AS keyword.`,
				range,
				action: {
					type: FixAction.TYPE,
					edits: [vscode.TextEdit.insert(new vscode.Position(ref.aliasLine, ref.aliasCol), 'AS ')],
					autoFix: true,
				},
			});
		}

		return violations;
	},
};
