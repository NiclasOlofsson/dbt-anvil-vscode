import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { lineOffset } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

export const notEqualRule: TokenRule = {
	id: 'ninja.convention.not-equal',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Enforce consistent not-equal operator style (!= or <>).',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [{ settingPath: 'convention.notEqual', label: 'Style', type: 'enum', choices: ['!=', '<>'] }],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const preferred = config.convention.notEqual;
		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (const tok of tokens) {
			if (tok.type !== 'NEQ') continue;
			const raw = text.slice(tok.start, tok.end + 1);
			if (raw === preferred) continue;

			const range = new vscode.Range(tok.line, tok.start - lineOffset(text, tok.line), tok.line, tok.start - lineOffset(text, tok.line) + raw.length);
			violations.push({
				rule: 'ninja.convention.not-equal',
				message: `Use '${preferred}' instead of '${raw}'.`,
				range,
				action: { type: FixAction.TYPE, edits: [{ range, newText: preferred }], autoFix: true },
			});
		}

		return violations;
	},
};
