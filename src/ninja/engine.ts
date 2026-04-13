import type * as vscode from 'vscode';
import type { NinjaRule, NinjaSeverity } from './rule';
import type { NinjaViolation } from './violation';
import type { NinjaConfig } from './config';
import type { DocumentModel } from '../services/parse-service';
import type { JinjaToken } from '../dbt/jinja-tokenizer';
import { parseInlineSuppressions } from './config-loader';

// -- Token rules --
import { keywordCapRule } from './rules/cap-keywords';
import { functionCapRule } from './rules/cap-functions';
import { literalCapRule } from './rules/cap-literals';
import { typeCapRule } from './rules/cap-types';
import { jinjaPaddingRule } from './rules/jinja-padding';

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
		if (rule.type === 'token') {
			ruleViolations = rule.check({ model, document, config });
		} else {
			ruleViolations = rule.check({ text, lines, jinjaTokens, document, config });
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
