import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * LT02 (indented_joins) — JOIN clauses should be at the same indent level as
 * FROM when indentation.indentedJoins is false (default), or one level deeper
 * when true.
 *
 * The anchor is the first token on the JOIN line so that `left join`, `right
 * join`, etc. are all handled uniformly. anchorTypes lists every keyword that
 * can legally precede JOIN on the same line.
 */
const JOIN_ANCHOR_TYPES = new Set([
	'JOIN', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'INNER', 'OUTER', 'NATURAL',
]);

const JOIN_SPEC: IndentSpec = {
	triggerTypes: new Set(['JOIN']),
	anchorTypes: JOIN_ANCHOR_TYPES,
	governorTypes: new Set(['FROM']),
	diagnostic: 'ninja.layout.indent-joins',
	shouldIndent: config => config.indentation.indentedJoins,
};

export const indentJoinsRule: TokenRule = {
	id: 'ninja.layout.indent-joins',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'JOIN clauses should be consistently indented relative to FROM.',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [
		{ settingPath: 'indentation.indentedJoins', label: 'Indent JOINs under FROM', type: 'bool' },
	],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[JOIN_SPEC],
			'ninja.layout.indent-joins',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-joins',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
