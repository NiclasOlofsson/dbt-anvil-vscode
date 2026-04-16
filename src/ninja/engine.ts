import type * as vscode from 'vscode';
import type { NinjaRule, NinjaSeverity } from './rule';
import type { NinjaViolation } from './violation';
import type { NinjaConfig } from './config';
import type { DocumentModel } from '../services/parse-service';
import type { JinjaToken } from '../dbt/jinja-tokenizer';
import type { DialectSymbols } from '../ftl/sql-parser';
import { parseInlineSuppressions } from './config-loader';
import type { RuleViewModel } from './editor/editor-types';

// -- Token rules --
import { keywordCapRule } from './rules/cap-keywords';
import { functionCapRule } from './rules/cap-functions';
import { literalCapRule } from './rules/cap-literals';
import { typeCapRule } from './rules/cap-types';
import { jinjaPaddingRule } from './rules/jinja-padding';

// -- Structure rules --
import { unusedCteRule } from './rules/structure-unused-cte';
import { unusedColumnsRule } from './rules/structure-unused-columns';
import { selectStarRule } from './rules/structure-select-star';

// -- Convention rules --
import { commaPositionRule } from './rules/convention-comma-position';
import { operatorPositionRule } from './rules/convention-operator-position';
import { notEqualRule } from './rules/convention-not-equal';
import { countRowsRule } from './rules/convention-count-rows';
import { isNullRule } from './rules/convention-is-null';
import { leftJoinRule } from './rules/convention-left-join';
import { coalesceRule } from './rules/convention-coalesce';
import { unionStyleRule } from './rules/convention-union-style';

// -- Ambiguity rules --
import { qualifiedColumnsRule } from './rules/ambiguity-qualified-columns';
import { bareUnionRule } from './rules/ambiguity-bare-union';
import { implicitJoinRule } from './rules/ambiguity-implicit-join';
import { distinctGroupByRule } from './rules/ambiguity-distinct-groupby';

// -- Aliasing rules --
import { columnAsRule } from './rules/alias-column-as';
import { requireTableAliasRule } from './rules/alias-require-table-alias';
import { selfAliasRule } from './rules/alias-self-alias';
import { uniqueTableRule } from './rules/alias-unique-table';
import { unusedAliasRule } from './rules/alias-unused';
import { expressionNoAliasRule } from './rules/alias-expression-no-alias';

// -- Structure rules (additional) --
import { distinctParensRule } from './rules/structure-distinct-parens';
import { unusedJoinRule } from './rules/structure-unused-join';
import { elseNullRule } from './rules/structure-else-null';
import { simpleCaseRule } from './rules/structure-simple-case';

// -- Layout rules --
import { trailingWhitespaceRule } from './rules/layout-trailing-whitespace';
import { trailingNewlineRule } from './rules/layout-trailing-newline';
import { leadingWhitespaceRule } from './rules/layout-leading-whitespace';
import { maxBlankLinesRule } from './rules/layout-max-blank-lines';
import { longLinesRule } from './rules/layout-long-lines';
import { indentRule } from './rules/layout-indent';
import { functionSpacingRule } from './rules/layout-function-spacing';

/** All built-in rules. Order does not matter — they all run independently. */
const ALL_RULES: NinjaRule[] = [
	keywordCapRule,
	functionCapRule,
	literalCapRule,
	typeCapRule,
	jinjaPaddingRule,
	unusedCteRule,
	unusedColumnsRule,
	selectStarRule,
	commaPositionRule,
	operatorPositionRule,
	notEqualRule,
	countRowsRule,
	isNullRule,
	leftJoinRule,
	qualifiedColumnsRule,
	bareUnionRule,
	implicitJoinRule,
	distinctGroupByRule,
	columnAsRule,
	requireTableAliasRule,
	selfAliasRule,
	uniqueTableRule,
	unusedAliasRule,
	expressionNoAliasRule,
	distinctParensRule,
	unusedJoinRule,
	elseNullRule,
	simpleCaseRule,
	coalesceRule,
	unionStyleRule,
	trailingWhitespaceRule,
	trailingNewlineRule,
	leadingWhitespaceRule,
	maxBlankLinesRule,
	longLinesRule,
	indentRule,
	functionSpacingRule,
];

function effectiveSeverity(rule: NinjaRule, config: NinjaConfig): NinjaSeverity {
	return config.rules[rule.id] ?? rule.defaultSeverity;
}

function toVsSeverity(sev: NinjaSeverity): vscode.DiagnosticSeverity | undefined {
	// Avoid importing vscode in this module at the top level so unit tests
	// can import this file. We use numeric values that match the enum.
	switch (sev) {
		case 'error': return 0; // DiagnosticSeverity.Error
		case 'warning': return 1; // DiagnosticSeverity.Warning
		case 'info': return 2; // DiagnosticSeverity.Information
		case 'hint': return 3; // DiagnosticSeverity.Hint
		case 'off': return undefined;
	}
}

export interface NinjaResult {
	violations: NinjaViolation[];
	severityMap: Map<string, vscode.DiagnosticSeverity>;
}

/**
 * Run all enabled Ninja rules against a document.
 *
 * Token rules receive the DocumentModel (already parsed for other providers).
 * Layout rules receive the raw document text + jinja token positions.
 */
export function runNinja(
	document: vscode.TextDocument,
	model: DocumentModel,
	jinjaTokens: JinjaToken[],
	config: NinjaConfig,
	dialectSymbols?: DialectSymbols,
): NinjaResult {
	if (!config.enabled) return { violations: [], severityMap: new Map() };

	const text = document.getText();
	const lines = text.split('\n');
	const suppressions = parseInlineSuppressions(text);

	const violations: NinjaViolation[] = [];
	const severityMap = new Map<string, vscode.DiagnosticSeverity>();

	for (const rule of ALL_RULES) {
		const sev = effectiveSeverity(rule, config);
		if (sev === 'off') continue;

		const vsSev = toVsSeverity(sev);
		if (vsSev === undefined) continue;

		let ruleViolations: NinjaViolation[];
		try {
			if (rule.type === 'token') {
				ruleViolations = rule.check({ model, document, jinjaTokens, config, dialectSymbols });
			} else {
				ruleViolations = rule.check({ text, lines, jinjaTokens, document, config });
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`[rule:${rule.id}] ${msg}`);
		}

		// Filter suppressed violations
		for (const v of ruleViolations) {
			const lineSuppression = suppressions.get(v.range.start.line);
			if (lineSuppression === 'all') continue;
			if (lineSuppression && lineSuppression.has(v.rule)) continue;
			violations.push(v);
			severityMap.set(v.rule, vsSev);
		}
	}

	return { violations, severityMap };
}

/** Return metadata for every registered rule (no check execution). */
export function getAllRuleMetadata(): RuleViewModel[] {
	return ALL_RULES.map(r => ({
		id: r.id,
		category: r.category,
		description: r.description,
		defaultSeverity: r.defaultSeverity,
		type: r.type,
	}));
}
