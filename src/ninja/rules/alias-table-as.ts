import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { insertOp } from '../fix-op';
import type { TableRefToken } from '../../services/parse-service';

const RULE_ID = 'ninja.aliasing.table-as';

export const tableAsRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'hint',
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

			// Look at the source text immediately BEFORE the alias. If
			// the previous non-whitespace tokens are `AS`, the alias is
			// already explicit. We scan back ~16 chars (enough to clear
			// `)` + whitespace + `AS`), trim trailing whitespace, then
			// check the tail. Using "before the alias" rather than
			// "between name and alias" handles subquery aliases too:
			// `(select ...) as po` has the table_ref's `name`/`endCol`
			// pointing at `po` itself, so the legacy between-slice was
			// empty and the AS check was failing — false-positive.
			const aliasStart = document.offsetAt(new vscode.Position(ref.aliasLine, ref.aliasCol));
			const beforeAlias = text.slice(Math.max(0, aliasStart - 16), aliasStart).trimEnd();

			if (/\bAS$/i.test(beforeAlias)) continue;

			const aliasEndCol = ref.aliasEndCol ?? ref.aliasCol + ref.alias.length;
			const range = new vscode.Range(ref.aliasLine, ref.aliasCol, ref.aliasLine, aliasEndCol);

			violations.push({
				rule: RULE_ID,
				message: `Table alias '${ref.alias}' should use explicit AS keyword.`,
				range,
				action: {
					type: FixAction.TYPE,
					ops: [insertOp(new vscode.Position(ref.aliasLine, ref.aliasCol), 'AS ')],
					autoFix: true,
				},
			});
		}

		return violations;
	},
};
