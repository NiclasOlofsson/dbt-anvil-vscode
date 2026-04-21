import type * as vscode from 'vscode';
import type { FixScope, NinjaRule, NinjaSeverity } from './rule';
import type { NinjaViolation } from './violation';
import type { NinjaConfig } from './config';
import type { DocumentModel } from '../services/parse-service';
import type { JinjaToken } from '../dbt/jinja-tokenizer';
import type { DialectSymbols } from '../ftl/sql-parser';
import { parseInlineSuppressions } from './config-loader';
import { parseFmtOffRegions, isInFmtOffRegion } from './jinja/directive-parser';
import type { RuleViewModel } from './editor/editor-types';

// -- Token rules --
import { keywordCapRule } from './rules/cap-keywords';
import { functionCapRule } from './rules/cap-functions';
import { literalCapRule } from './rules/cap-literals';
import { typeCapRule } from './rules/cap-types';
import { capIdentifiersRule } from './rules/cap-identifiers';
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
import { outerJoinRule } from './rules/convention-outer-join';
import { explicitInnerJoinRule } from './rules/convention-explicit-inner-join';
import { coalesceRule } from './rules/convention-coalesce';
import { unionStyleRule } from './rules/convention-union-style';
import { trailingCommaRule } from './rules/convention-trailing-comma';
import { statementTerminatorRule } from './rules/convention-statement-terminator';
import { quotedLiteralsRule } from './rules/convention-quoted-literals';
import { castStyleRule } from './rules/convention-cast-style';
import { blockedWordsRule } from './rules/convention-blocked-words';

// -- Ambiguity rules --
import { qualifiedColumnsRule } from './rules/ambiguity-qualified-columns';
import { bareUnionRule } from './rules/ambiguity-bare-union';
import { implicitJoinRule } from './rules/ambiguity-implicit-join';
import { distinctGroupByRule } from './rules/ambiguity-distinct-groupby';
import { orderByDirectionRule } from './rules/ambiguity-order-by-direction';
import { starWithSetOpRule } from './rules/ambiguity-star-with-setop';
import { joinWithoutOnRule } from './rules/ambiguity-join-without-on';
import { setopColumnCountRule } from './rules/ambiguity-setop-column-count';

// -- Reference rules --
import { refInFromRule } from './rules/reference-ref-in-from';
import { qualifyMultiTableRule } from './rules/reference-qualify-multi-table';
import { consistentSingleTableRule } from './rules/reference-consistent-single-table';
import { keywordsAsIdentifiersRule } from './rules/reference-keywords-as-identifiers';
import { quotingPolicyRule } from './rules/reference-quoting-policy';

// -- Aliasing rules --
import { columnAsRule } from './rules/alias-column-as';
import { tableAsRule } from './rules/alias-table-as';
import { requireTableAliasRule } from './rules/alias-require-table-alias';
import { selfAliasRule } from './rules/alias-self-alias';
import { uniqueTableRule } from './rules/alias-unique-table';
import { unusedAliasRule } from './rules/alias-unused';
import { expressionNoAliasRule } from './rules/alias-expression-no-alias';
import { aliasLengthRule } from './rules/alias-length';
import { aliasUniqueColumnsRule } from './rules/alias-unique-columns';

// -- Structure rules (additional) --
import { distinctParensRule } from './rules/structure-distinct-parens';
import { unusedJoinRule } from './rules/structure-unused-join';
import { elseNullRule } from './rules/structure-else-null';
import { simpleCaseRule } from './rules/structure-simple-case';
import { subqueryToCteRule } from './rules/structure-subquery-to-cte';
import { columnOrderRule } from './rules/structure-column-order';
import { onVsUsingRule } from './rules/structure-on-vs-using';
import { joinTableOrderRule } from './rules/structure-join-table-order';

// -- Jinja rules --
import { jinjaArgumentSpacingRule } from './rules/jinja-argument-spacing';

// -- Layout rules --
import { indentOnRule } from './rules/layout-indent-on';
import { indentJoinsRule } from './rules/layout-indent-joins';
import { indentThenRule } from './rules/layout-indent-then';
import { indentCommentsRule } from './rules/layout-indent-comments';
import { indentBodyRule } from './rules/layout-indent-body';
import { indentBracketRule } from './rules/layout-indent-bracket';
import { indentFromRule } from './rules/layout-indent-from';
import { indentWhereRule } from './rules/layout-indent-where';
import { indentGroupByRule } from './rules/layout-indent-group-by';
import { indentHavingRule } from './rules/layout-indent-having';
import { indentOrderByRule } from './rules/layout-indent-order-by';
import { indentLimitRule } from './rules/layout-indent-limit';
import { indentSetOpRule } from './rules/layout-indent-set-op';
import { selectTargetsRule } from './rules/layout-select-targets';
import { selectModifiersRule } from './rules/layout-select-modifiers';
import { cteBracketRule } from './rules/layout-cte-bracket';
import { cteBlankLineRule } from './rules/layout-cte-blank-line';
import { trailingWhitespaceRule } from './rules/layout-trailing-whitespace';
import { trailingNewlineRule } from './rules/layout-trailing-newline';
import { leadingWhitespaceRule } from './rules/layout-leading-whitespace';
import { maxBlankLinesRule } from './rules/layout-max-blank-lines';
import { longLinesRule } from './rules/layout-long-lines';
import { indentRule } from './rules/layout-indent';
import { functionSpacingRule } from './rules/layout-function-spacing';
import { setOperatorRule } from './rules/layout-set-operator';
import { clauseKeywordRule } from './rules/layout-clause-keyword';
import { bracketSpacingRule } from './rules/layout-spacing';
import { binaryOperatorSpacingRule } from './rules/layout-binary-operator-spacing';
import { commaSpacingRule } from './rules/layout-comma-spacing';

/** All built-in rules. Order does not matter — they all run independently. */
const ALL_RULES: NinjaRule[] = [
	keywordCapRule,
	functionCapRule,
	literalCapRule,
	typeCapRule,
	capIdentifiersRule,
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
	outerJoinRule,
	explicitInnerJoinRule,
	qualifiedColumnsRule,
	bareUnionRule,
	implicitJoinRule,
	distinctGroupByRule,
	orderByDirectionRule,
	starWithSetOpRule,
	joinWithoutOnRule,
	setopColumnCountRule,
	refInFromRule,
	qualifyMultiTableRule,
	consistentSingleTableRule,
	keywordsAsIdentifiersRule,
	quotingPolicyRule,
	columnAsRule,
	tableAsRule,
	requireTableAliasRule,
	selfAliasRule,
	uniqueTableRule,
	unusedAliasRule,
	expressionNoAliasRule,
	aliasLengthRule,
	aliasUniqueColumnsRule,
	distinctParensRule,
	unusedJoinRule,
	elseNullRule,
	simpleCaseRule,
	subqueryToCteRule,
	columnOrderRule,
	onVsUsingRule,
	joinTableOrderRule,
	coalesceRule,
	unionStyleRule,
	trailingCommaRule,
	statementTerminatorRule,
	quotedLiteralsRule,
	castStyleRule,
	blockedWordsRule,
	trailingWhitespaceRule,
	trailingNewlineRule,
	leadingWhitespaceRule,
	maxBlankLinesRule,
	longLinesRule,
	indentRule,
	indentOnRule,
	indentJoinsRule,
	indentThenRule,
	indentCommentsRule,
	indentBodyRule,
	indentBracketRule,
	indentFromRule,
	indentWhereRule,
	indentGroupByRule,
	indentHavingRule,
	indentOrderByRule,
	indentLimitRule,
	indentSetOpRule,
	functionSpacingRule,
	setOperatorRule,
	clauseKeywordRule,
	bracketSpacingRule,
	binaryOperatorSpacingRule,
	commaSpacingRule,
	selectTargetsRule,
	selectModifiersRule,
	cteBracketRule,
	cteBlankLineRule,
	jinjaArgumentSpacingRule,
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
		case 'mute': return undefined; // violations kept for formatter, not shown as diagnostics
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
	const suppressions = parseInlineSuppressions(lines);
	const fmtOffRegions = parseFmtOffRegions(lines);

	const violations: NinjaViolation[] = [];
	const severityMap = new Map<string, vscode.DiagnosticSeverity>();

	const disabledSet = new Set(config.disabledRules);

	for (const rule of ALL_RULES) {
		if (disabledSet.has(rule.id)) continue;

		const sev = effectiveSeverity(rule, config);
		const vsSev = toVsSeverity(sev);
		// mute: vsSev is undefined — rule still runs for autofix, just no diagnostic.

		let ruleViolations: NinjaViolation[];
		try {
			if (rule.type === 'token') {
				ruleViolations = rule.check({ model, document, jinjaTokens, config, dialectSymbols });
			} else {
				ruleViolations = rule.check({ text, lines, jinjaTokens, document, config, model });
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
			if (isInFmtOffRegion(v.range.start.line, fmtOffRegions)) continue;
			violations.push(v);
			// fix-only violations are kept in the array for the formatter but not
			// added to severityMap, so the diagnostic provider won't show them.
			if (vsSev !== undefined) severityMap.set(v.rule, vsSev);
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
		actionKinds: r.actionKinds,
		autoFixable: r.autoFixable,
		fixable: !!r.actionKinds?.includes('fix'),
		fixScope: getRuleFixScope(r),
		configOptions: r.configOptions,
	}));
}

/**
 * Centralized classification of how each rule's violations get fixed. The
 * table lives here so we don't touch 80+ rule files when the policy shifts.
 *
 * - `surgical`   — local, single-location edit safe via code action + `source.fixAll.ninja`
 * - `structural` — layout concern owned by the reflow engine; rule is detection-only for consumers
 * - `none`       — diagnostic only (rule may still emit a FixAction for internal tests, but no consumer acts on it)
 *
 * Rules not listed here default to `none`.
 */
const FIX_SCOPE_TABLE: Record<string, FixScope> = {
	// ── Surgical: local cosmetic/semantic edits ─────────────────────────────
	'ninja.cap.keywords': 'surgical',
	'ninja.cap.functions': 'surgical',
	'ninja.cap.literals': 'surgical',
	'ninja.cap.types': 'surgical',
	'ninja.convention.is-null': 'surgical',
	'ninja.convention.not-equal': 'surgical',
	'ninja.convention.count-rows': 'surgical',
	'ninja.convention.coalesce': 'surgical',
	'ninja.convention.outer-join': 'surgical',
	'ninja.convention.explicit-inner-join': 'surgical',
	'ninja.convention.statement-terminator': 'surgical',
	'ninja.structure.unused-cte': 'surgical',
	'ninja.structure.else-null': 'surgical',
	'ninja.structure.distinct-parens': 'surgical',
	'ninja.alias.column-as': 'surgical',
	'ninja.alias.table-as': 'surgical',
	'ninja.alias.self-alias': 'surgical',
	'ninja.alias.expression-no-alias': 'surgical',
	'ninja.ambiguity.bare-union': 'surgical',
	'ninja.ambiguity.implicit-join': 'surgical',

	// ── Structural: reflow owns the fix ─────────────────────────────────────
	'ninja.convention.comma-position': 'structural',
	'ninja.convention.operator-position': 'structural',
	'ninja.convention.trailing-comma': 'structural',
	'ninja.convention.union-style': 'structural',
	'ninja.jinja.padding': 'structural',
	'ninja.jinja.argument-spacing': 'structural',
	'ninja.layout.binary-operator-spacing': 'structural',
	'ninja.layout.clause-keyword': 'structural',
	'ninja.layout.comma-spacing': 'structural',
	'ninja.layout.function-spacing': 'structural',
	'ninja.layout.spacing': 'structural',
	'ninja.layout.indent': 'structural',
	'ninja.layout.indent-body': 'structural',
	'ninja.layout.indent-bracket': 'structural',
	'ninja.layout.indent-comments': 'structural',
	'ninja.layout.indent-from': 'structural',
	'ninja.layout.indent-group-by': 'structural',
	'ninja.layout.indent-having': 'structural',
	'ninja.layout.indent-joins': 'structural',
	'ninja.layout.indent-limit': 'structural',
	'ninja.layout.indent-on': 'structural',
	'ninja.layout.indent-order-by': 'structural',
	'ninja.layout.indent-set-op': 'structural',
	'ninja.layout.indent-then': 'structural',
	'ninja.layout.indent-where': 'structural',
	'ninja.layout.leading-whitespace': 'structural',
	'ninja.layout.max-blank-lines': 'structural',
	'ninja.layout.set-operator': 'structural',
	'ninja.layout.trailing-newline': 'structural',
	'ninja.layout.trailing-whitespace': 'structural',
	'ninja.layout.cte-blank-line': 'structural',
	'ninja.layout.cte-bracket': 'structural',
	'ninja.layout.select-targets': 'structural',
	'ninja.layout.select-modifiers': 'structural',
	'ninja.layout.long-lines': 'structural',
};

/**
 * Resolve a rule's fix scope. Preference order: explicit `rule.fixScope` on the
 * rule object (if set) > central `FIX_SCOPE_TABLE` lookup > `'none'`.
 */
export function getRuleFixScope(rule: Pick<NinjaRule, 'id' | 'fixScope'>): FixScope {
	return rule.fixScope ?? FIX_SCOPE_TABLE[rule.id] ?? 'none';
}

/**
 * ID-only variant of {@link getRuleFixScope}. Use at call sites that only
 * hold a rule id (e.g. `NinjaViolation.rule`). Falls back to `'none'` when
 * the id is unknown, which keeps synthetic test violations safe.
 */
export function getRuleFixScopeById(ruleId: string): FixScope {
	return _fixScopeOverrides.get(ruleId) ?? FIX_SCOPE_TABLE[ruleId] ?? 'none';
}

const _fixScopeOverrides: Map<string, FixScope> = new Map(
	ALL_RULES.flatMap(r => (r.fixScope ? [[r.id, r.fixScope] as const] : [])),
);

/** Default arbitration priority used when a rule does not declare one. */
export const DEFAULT_RULE_PRIORITY = 100;

const _priorityById: Map<string, number> = new Map(
	ALL_RULES.map(r => [r.id, r.priority ?? DEFAULT_RULE_PRIORITY] as const),
);

/**
 * Lookup the arbitration priority for a rule by id. Lower wins when two
 * rules' fix groups overlap. Unknown ids fall back to DEFAULT_RULE_PRIORITY,
 * which keeps the planner safe for tests that synthesize violations.
 */
export function getRulePriority(ruleId: string): number {
	return _priorityById.get(ruleId) ?? DEFAULT_RULE_PRIORITY;
}
