import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import { matchesStyle, convertToStyle, type IdentifierStyle } from '../identifier-style';
import { buildInFileRenameOps } from '../../providers/sql/rename-edits';
import type { PositionResolution } from '../../services/parse-service';

const RULE_ID = 'ninja.cap.identifiers';

/**
 * Style policy enforcement for identifiers the user introduced in this
 * file — column aliases (`as my_col`), CTE names (`with my_cte as ...`),
 * and user-written table aliases (`from t as my_t`). Column references
 * are NOT flagged: their case is owned by the source schema, not by the
 * caller's style preference.
 *
 * Violations carry a `FixAction` with `autoFix: false`. The fix walks
 * the in-file token stream via `buildInFileRenameOps` so every reference
 * to the identifier updates atomically when the user accepts the code
 * action — same code path the F2 rename uses, so behaviour stays
 * consistent across the two entry points.
 *
 * Detection is bounded by visible markers + the configured acronym list.
 * All-lowercase identifiers like `customerid` are accepted as conformant
 * snake_case unless the word list configures otherwise — matching the
 * approach of IntelliJ/VS, since heuristic segmentation without a
 * project vocabulary produces more harm than help.
 */
export const capIdentifiersRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Capitalisation,
	defaultSeverity: 'hint',
	description: 'Introduced identifiers (column aliases, CTE names, table aliases) should follow the configured style policy',
	actionKinds: ['fix'],
	autoFixable: false,
	fixScope: 'surgical',
	configOptions: [{
		settingPath: 'capitalisation.identifiers.style',
		label: 'Style',
		type: 'enum',
		choices: ['off', 'snake_case', 'camelCase', 'PascalCase', 'lower', 'upper'],
	}],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const policy = ctx.config.capitalisation.identifiers.style;
		if (policy === 'off') return [];

		const style = policy as IdentifierStyle;
		const acronyms = new Set(ctx.config.capitalisation.identifiers.acronyms);
		const words = new Set(ctx.config.capitalisation.identifiers.words);
		const opts = { acronyms, words };

		const violations: NinjaViolation[] = [];

		for (const token of ctx.model.tokens) {
			let name: string | undefined;
			let range: vscode.Range | undefined;
			let resolved: PositionResolution | undefined;

			if (token.type === 'column_def') {
				name = token.name;
				range = new vscode.Range(token.line, token.col, token.line, token.endCol);
				resolved = { kind: 'column_def', token };
			} else if (
				token.type === 'table_ref'
				&& token.cteDefinition
			) {
				name = token.name;
				range = new vscode.Range(token.line, token.col, token.line, token.endCol);
				resolved = { kind: 'table_ref', token };
			} else if (
				token.type === 'table_ref'
				&& token.alias !== undefined
				&& token.aliasLine !== undefined
				&& token.aliasCol !== undefined
				&& token.aliasEndCol !== undefined
			) {
				name = token.alias;
				range = new vscode.Range(token.aliasLine, token.aliasCol, token.aliasLine, token.aliasEndCol);
				resolved = { kind: 'table_alias', token };
			}

			if (!name || !range || !resolved) continue;
			if (name.length <= 1) continue;          // single-char short aliases — skip
			if (matchesStyle(name, style, opts)) continue;

			const suggestion = convertToStyle(name, style, opts);
			if (!suggestion || suggestion === name) continue;

			const ops = buildInFileRenameOps(resolved, ctx.model, suggestion);

			violations.push({
				rule: RULE_ID,
				message: `Identifier '${name}' does not match ${style} style — rename to '${suggestion}'.`,
				range,
				action: ops.length > 0
					? { type: FixAction.TYPE, ops, autoFix: false }
					: undefined,
			});
		}

		return violations;
	},
};
