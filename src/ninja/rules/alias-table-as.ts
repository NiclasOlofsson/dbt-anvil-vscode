import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { insertOp } from '../fix-op';

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
		if (!model.symbols?.length) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		// A FROM/JOIN source is kind 'table' (base table), 'cte' (CTE reference), or
		// 'subquery' (aliased derived table) — always modifiers:['reference']; this
		// excludes a CTE's own declaration site. Unlike the require-alias/self-alias
		// rules, 'subquery' stays in scope here: a subquery source is always aliased
		// structurally, and that alias still needs the explicit AS keyword.
		const relationRefs = model.symbols.filter(
			s => (s.kind === 'table' || s.kind === 'cte' || s.kind === 'subquery') && s.modifiers.includes('reference'),
		);

		for (const ref of relationRefs) {
			const alias = ref.alias;
			if (!alias) continue;

			const refLine = ref.span.line - 1;
			const aliasLine = alias.span.line - 1;
			const aliasCol = alias.span.column;
			if (refLine >= document.lineCount || aliasLine >= document.lineCount) continue;

			// Look at the source text immediately BEFORE the alias. If
			// the previous non-whitespace tokens are `AS`, the alias is
			// already explicit. We scan back ~16 chars (enough to clear
			// `)` + whitespace + `AS`), trim trailing whitespace, then
			// check the tail. Using "before the alias" rather than
			// "between name and alias" handles subquery aliases too:
			// `(select ...) as po` has the ref symbol's own span pointing
			// at `po` itself, so a between-slice would be empty and the
			// AS check would false-positive.
			const aliasStart = document.offsetAt(new vscode.Position(aliasLine, aliasCol));
			const beforeAlias = text.slice(Math.max(0, aliasStart - 16), aliasStart).trimEnd();

			if (/\bAS$/i.test(beforeAlias)) continue;

			const aliasEndCol = alias.span.endColumn;
			const range = new vscode.Range(aliasLine, aliasCol, aliasLine, aliasEndCol);

			violations.push({
				rule: RULE_ID,
				message: `Table alias '${alias.name}' should use explicit AS keyword.`,
				range,
				action: {
					type: FixAction.TYPE,
					ops: [insertOp(new vscode.Position(aliasLine, aliasCol), 'AS ')],
					autoFix: true,
				},
			});
		}

		return violations;
	},
};
