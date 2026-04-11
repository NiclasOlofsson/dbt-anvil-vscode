import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { CapitalisationPolicy } from '../config';

// Boolean/null literals that should follow capitalisation policy.
const SQL_LITERALS = new Set(['null', 'true', 'false']);

function checkPolicy(word: string, policy: CapitalisationPolicy, expected: Map<string, string>): string | undefined {
	if (policy === 'upper') {
		const upper = word.toUpperCase();
		return word !== upper ? upper : undefined;
	}
	if (policy === 'lower') {
		const lower = word.toLowerCase();
		return word !== lower ? lower : undefined;
	}
	const key = word.toLowerCase();
	const first = expected.get(key);
	if (!first) {
		expected.set(key, word);
		return undefined;
	}
	return word !== first ? first : undefined;
}

export const literalCapRule: TokenRule = {
	id: 'ninja.cap.literals',
	type: 'token',
	category: NinjaCategory.Capitalisation,
	defaultSeverity: 'warning',
	description: 'SQL literals (NULL, TRUE, FALSE) should follow the configured capitalisation policy',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const policy = ctx.config.capitalisation.literals;
		const violations: NinjaViolation[] = [];
		const consistentMap = new Map<string, string>();

		const text = ctx.document.getText();
		const lines = text.split('\n');

		// Build identifier positions to skip
		const identifierPositions = new Set<string>();
		for (const token of ctx.model.tokens) {
			identifierPositions.add(`${token.line}:${token.col}`);
		}

		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			const line = lines[lineIdx];
			let i = 0;
			while (i < line.length) {
				const ch = line.charCodeAt(i);
				if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95) {
					const start = i;
					i++;
					while (i < line.length) {
						const c = line.charCodeAt(i);
						if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) {
							i++;
						} else {
							break;
						}
					}
					const word = line.slice(start, i);
					if (SQL_LITERALS.has(word.toLowerCase()) && !identifierPositions.has(`${lineIdx}:${start}`)) {
						const fix = checkPolicy(word, policy, consistentMap);
						if (fix !== undefined) {
							const range = new vscode.Range(lineIdx, start, lineIdx, start + word.length);
							violations.push({
								rule: 'ninja.cap.literals',
								message: `Expected literal '${word}' to be '${fix}'`,
								range,
								fix: [vscode.TextEdit.replace(range, fix)],
							});
						}
					}
				} else {
					i++;
				}
			}
		}

		return violations;
	},
};
