import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * LT02 (indented_using_on) — ON/USING after a JOIN should be indented
 * one level deeper than the JOIN clause when indentation.indentedOn is true,
 * or at the same level as JOIN when false.
 *
 * The indent reference is the first token on the JOIN's line (e.g. LEFT in
 * `left join`), so the base column is always a clean multiple of the indent
 * unit.
 */
const ON_SPEC: IndentSpec = {
	triggerTypes: new Set(['ON', 'USING']),
	governorTypes: new Set(['JOIN']),
	diagnostic: 'ninja.layout.indent-on',
	shouldIndent: config => config.indentation.indentedOn,
};

export const indentOnRule: TokenRule = {
	id: 'ninja.layout.indent-on',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'ON/USING should be indented relative to its JOIN clause.',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [
		{ settingPath: 'indentation.indentedOn', label: 'Indent ON/USING under JOIN', type: 'bool' },
	],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[ON_SPEC],
			'ninja.layout.indent-on',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-on',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
