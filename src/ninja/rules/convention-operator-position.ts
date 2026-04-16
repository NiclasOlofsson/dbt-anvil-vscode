import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

/**
 * Enforces consistent boolean operator placement (trailing or leading).
 *
 * In trailing mode: AND/OR must be at the end of a line (before the next condition).
 * In leading mode: AND/OR must be at the start of a line.
 *
 * Uses sqlTokens (AND, OR types) to find operator positions.
 */
export const operatorPositionRule: TokenRule = {
	id: 'ninja.convention.operator-position',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Enforce consistent boolean operator placement (trailing or leading).',
	fixes: 'auto',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const policy = config.layout.operatorPosition;
		const operators = model.sqlTokens.filter(t => t.type === 'AND' || t.type === 'OR');
		if (operators.length === 0) return [];

		const text = document.getText();
		const lines = text.split('\n');
		const violations: NinjaViolation[] = [];

		for (const op of operators) {
			const line = op.line;
			if (line >= lines.length) continue;

			const lineText = lines[line];
			const opStart = op.start - offsetOfLine(lines, line);
			const opLen = op.end - op.start + 1;

			if (policy === 'trailing') {
				// Leading operator violation: operator is the first non-whitespace on line
				const beforeOp = lineText.slice(0, opStart).trim();
				if (beforeOp === '' && line > 0) {
					const range = new vscode.Range(line, opStart, line, opStart + opLen);
					const opText = lineText.slice(opStart, opStart + opLen).trim();
					const prevLineText = lines[line - 1];
					const trailingSpace = lineText[opStart + opLen] === ' ' ? 1 : 0;
					violations.push({
						rule: 'ninja.convention.operator-position',
						message: `'${opText}' should be at the end of the previous line (trailing), not at the start.`,
						range,
						fix: [
							vscode.TextEdit.insert(new vscode.Position(line - 1, prevLineText.length), ` ${opText}`),
							vscode.TextEdit.delete(new vscode.Range(line, opStart, line, opStart + opLen + trailingSpace)),
						],
					});
				}
			} else {
				// Trailing operator violation: operator is at the end of line (possibly with whitespace/comment after)
				const afterOp = lineText.slice(opStart + opLen).trim();
				if (afterOp === '' || afterOp.startsWith('--')) {
					if (line + 1 < lines.length && lines[line + 1].trim() !== '') {
						const range = new vscode.Range(line, opStart, line, opStart + opLen);
						const opText = lineText.slice(opStart, opStart + opLen).trim();
						const nextLineText = lines[line + 1];
						const nextIndent = nextLineText.length - nextLineText.trimStart().length;
						const spaceBefore = opStart > 0 && lineText[opStart - 1] === ' ' ? 1 : 0;
						violations.push({
							rule: 'ninja.convention.operator-position',
							message: `'${opText}' should be at the start of the next line (leading), not at the end.`,
							range,
							fix: [
								vscode.TextEdit.delete(new vscode.Range(line, opStart - spaceBefore, line, opStart + opLen)),
								vscode.TextEdit.insert(new vscode.Position(line + 1, nextIndent), `${opText} `),
							],
						});
					}
				}
			}
		}

		return violations;
	},
};

function offsetOfLine(lines: string[], targetLine: number): number {
	let offset = 0;
	for (let i = 0; i < targetLine; i++) {
		offset += lines[i].length + 1;
	}
	return offset;
}
