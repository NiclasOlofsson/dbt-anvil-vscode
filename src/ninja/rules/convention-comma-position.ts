import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { SqlToken } from '../../ftl/parse-result';

/**
 * Enforces consistent comma placement (trailing or leading).
 *
 * In trailing mode: commas must be at the end of a line (or on a single line).
 * In leading mode: commas must be at the start of a line (or on a single line).
 *
 * Uses sqlTokens (COMMA type) to find comma positions, then checks
 * whether the rest of the line matches the expected style.
 */
export const commaPositionRule: TokenRule = {
	id: 'ninja.convention.comma-position',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Enforce consistent comma placement (trailing or leading).',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const policy = config.layout.commaPosition;
		const commas = model.sqlTokens.filter(t => t.type === 'COMMA');
		if (commas.length === 0) return [];

		const text = document.getText();
		const lines = text.split('\n');
		const violations: NinjaViolation[] = [];

		for (const comma of commas) {
			const line = comma.line;
			if (line >= lines.length) continue;

			const lineText = lines[line];
			const commaCol = comma.start - offsetOfLine(lines, line);

			if (policy === 'trailing') {
				// Leading comma violation: comma is the first non-whitespace on a line
				const beforeComma = lineText.slice(0, commaCol).trim();
				if (beforeComma === '') {
					const range = new vscode.Range(line, commaCol, line, commaCol + 1);
					violations.push({
						rule: 'ninja.convention.comma-position',
						message: 'Comma should be at the end of the previous line (trailing), not at the start.',
						range,
					});
				}
			} else {
				// Trailing comma violation: comma is followed by content on the next line
				const afterComma = lineText.slice(commaCol + 1).trim();
				if (afterComma === '' || afterComma.startsWith('--')) {
					// Comma at end of line, but policy says leading — violation only if next line has content
					if (line + 1 < lines.length && lines[line + 1].trim() !== '') {
						const range = new vscode.Range(line, commaCol, line, commaCol + 1);
						violations.push({
							rule: 'ninja.convention.comma-position',
							message: 'Comma should be at the start of the next line (leading), not at the end.',
							range,
						});
					}
				}
			}
		}

		return violations;
	},
};

/** 0-based char offset of the start of a 0-based line. */
function offsetOfLine(lines: string[], targetLine: number): number {
	let offset = 0;
	for (let i = 0; i < targetLine; i++) {
		offset += lines[i].length + 1; // +1 for \n
	}
	return offset;
}
