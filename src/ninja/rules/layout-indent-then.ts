import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * LT02 (indented_then) — THEN should be indented one level deeper than its
 * WHEN clause when indentation.indentedThen is true (default), or at the same
 * level as WHEN when false.
 *
 * The check only fires when THEN is the first content token on its line (i.e.
 * `when x then y` on one line is silently skipped). Paren depth tracking
 * prevents matching WHEN inside nested CASE expressions enclosed in parens.
 */
const THEN_SPEC: IndentSpec = {
	triggerTypes: new Set(['THEN']),
	governorTypes: new Set(['WHEN']),
	diagnostic: 'ninja.layout.indent-then',
	shouldIndent: config => config.indentation.indentedThen,
};

export const indentThenRule: TokenRule = {
	id: 'ninja.layout.indent-then',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'THEN should be indented relative to its WHEN clause.',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [
		{ settingPath: 'indentation.indentedThen', label: 'Indent THEN under WHEN', type: 'bool' },
	],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[THEN_SPEC],
			'ninja.layout.indent-then',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-then',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
