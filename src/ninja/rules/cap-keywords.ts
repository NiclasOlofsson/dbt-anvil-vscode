import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { CapitalisationPolicy } from '../config';
import { replaceOp } from '../fix-op';
import { tokenText, tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

const RULE_ID = 'ninja.cap.keywords';

/**
 * A token is keyword-recasable when the PARSE said so for this occurrence
 * (`SqlToken.kind`, from sqllens's consumedAs verdict or the mapper's curated
 * fallback) AND its type is a single plain alpha word — compounds (GROUP_BY)
 * and underscore names (CURRENT_DATE) keep their source casing, the same
 * exemption the retired membership set encoded via its alpha-only filter.
 * Type-kind tokens recase under the keyword policy exactly as their canonical
 * names did when they sat in the old membership set.
 */
export function isKeywordRecasable(token: { kind?: 'keyword' | 'type'; type: string }): boolean {
	return (token.kind === 'keyword' || token.kind === 'type') && /^[A-Za-z]+$/.test(token.type);
}

function checkPolicy(word: string, policy: CapitalisationPolicy, expected: Map<string, string>): string | undefined {
	if (policy === 'upper') {
		const upper = word.toUpperCase();
		return word !== upper ? upper : undefined;
	}
	if (policy === 'lower') {
		const lower = word.toLowerCase();
		return word !== lower ? lower : undefined;
	}
	// consistent: use the first occurrence's casing
	const key = word.toLowerCase();
	const first = expected.get(key);
	if (!first) {
		expected.set(key, word);
		return undefined;
	}
	return word !== first ? first : undefined;
}

export const keywordCapRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Capitalisation,
	defaultSeverity: 'hint',
	description: 'SQL keywords should follow the configured capitalisation policy',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [{ settingPath: 'capitalisation.keywords', label: 'Style', type: 'enum', choices: ['upper', 'lower', 'consistent'] }],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const policy = ctx.config.capitalisation.keywords;
		const violations: NinjaViolation[] = [];
		const consistentMap = new Map<string, string>();

		const sqlTokens = sqlOnly(ctx.model.ninjaSqlTokens);
		if (sqlTokens.length === 0) return violations;

		const text = ctx.document.getText();

		for (const token of sqlTokens) {
			if (!isKeywordRecasable(token)) continue;

			const word = tokenText(text, token);
			const fix = checkPolicy(word, policy, consistentMap);
			if (fix !== undefined) {
				const range = tokenRange(text, token);
				violations.push({
					rule: RULE_ID,
					message: `Expected keyword '${word}' to be '${fix}'`,
					range,
					action: { type: FixAction.TYPE, ops: [replaceOp(range, fix)], autoFix: true },
				});
			}
		}

		return violations;
	},
};
