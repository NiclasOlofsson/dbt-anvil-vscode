import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';

/**
 * LT05: Lines should not exceed the configured max length.
 * Lines that are mostly jinja (>50% inside jinja tokens) are skipped
 * since they can't be easily reformatted.
 */
export const longLinesRule: LayoutRule = {
	id: 'ninja.layout.long-lines',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'info',
	description: 'Lines should not exceed the configured maximum length',
	configOptions: [{ settingPath: 'maxLineLength', label: 'Max length', type: 'number', min: 40, max: 500 }],

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		const maxLen = ctx.config.maxLineLength;

		// Build a set of line numbers that are mostly jinja
		const jinjaCharsPerLine = new Map<number, number>();
		for (const token of ctx.jinjaTokens) {
			if (token.type === 'text') continue;
			// Count characters of this jinja token per line
			const raw = token.raw;
			let offset = token.start;
			for (let i = 0; i < raw.length; i++, offset++) {
				const pos = ctx.document.positionAt(offset);
				jinjaCharsPerLine.set(pos.line, (jinjaCharsPerLine.get(pos.line) ?? 0) + 1);
			}
		}

		for (let i = 0; i < ctx.lines.length; i++) {
			const line = ctx.lines[i];
			let lineLen = line.length;
			// Strip \r for CRLF
			if (lineLen > 0 && line[lineLen - 1] === '\r') lineLen--;

			if (lineLen <= maxLen) continue;

			// Skip lines that are mostly jinja
			const jinjaChars = jinjaCharsPerLine.get(i) ?? 0;
			if (jinjaChars > lineLen * 0.5) continue;

			const range = new vscode.Range(i, maxLen, i, lineLen);
			violations.push({
				rule: 'ninja.layout.long-lines',
				message: `Line is ${lineLen} characters long (max ${maxLen})`,
				range,
				// Not auto-fixable — line breaking requires semantic understanding
			});
		}

		return violations;
	},
};
