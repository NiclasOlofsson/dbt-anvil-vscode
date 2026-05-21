import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';
import { replaceOp } from '../fix-op';

/**
 * LT02: Indentation should use consistent units and sizes.
 * Checks that each indented line uses the configured unit (space/tab) and
 * that the indentation width is a multiple of the configured size.
 * Skips blank lines and lines that start inside a jinja block.
 */
export const indentRule: LayoutRule = {
	id: 'ninja.layout.indent',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'Indentation should use the configured style',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [
		{ settingPath: 'indentation.unit', label: 'Unit', type: 'enum', choices: ['space', 'tab'] },
		{ settingPath: 'indentation.size', label: 'Size', type: 'number', min: 1, max: 8 },
	],

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		const unit = ctx.config.indentation.unit;
		const size = ctx.config.indentation.size;

		// Build a set of line indices that start inside a jinja token (skip these).
		// 'text' tokens are plain SQL between jinja constructs, not jinja interiors,
		// so they must not mark their middle lines as internal.
		const jinjaLines = new Set<number>();
		for (const tok of ctx.jinjaTokens) {
			if (tok.type === 'text') continue;
			const startLine = ctx.document.positionAt(tok.start).line;
			const endLine = ctx.document.positionAt(tok.end).line;
			// Lines between start and end are "inside" jinja (not the first/last if they have SQL too)
			for (let l = startLine + 1; l < endLine; l++) {
				jinjaLines.add(l);
			}
		}

		for (let i = 0; i < ctx.lines.length; i++) {
			const line = ctx.lines[i];
			if (line.length === 0 || line.trim().length === 0) continue;
			if (jinjaLines.has(i)) continue;

			// Count leading whitespace
			let spaces = 0;
			let tabs = 0;
			let j = 0;
			while (j < line.length) {
				if (line[j] === ' ') { spaces++; j++; }
				else if (line[j] === '\t') { tabs++; j++; }
				else break;
			}

			// No indentation — nothing to check
			if (spaces === 0 && tabs === 0) continue;

			// Check for mixed indentation
			if (spaces > 0 && tabs > 0) {
				const endCol = j;
				const range = new vscode.Range(i, 0, i, endCol);
				const expectedIndent = unit === 'space'
					? ' '.repeat(Math.round((spaces + tabs * size) / size) * size)
					: '\t'.repeat(Math.round((tabs + Math.ceil(spaces / size)) / 1));
				violations.push({
					rule: 'ninja.layout.indent',
					message: 'Mixed spaces and tabs in indentation',
					range,
					action: { type: FixAction.TYPE, ops: [replaceOp(range, expectedIndent)], autoFix: true },
				});
				continue;
			}

			// Check wrong unit type
			if (unit === 'space' && tabs > 0) {
				const range = new vscode.Range(i, 0, i, tabs);
				const replacement = ' '.repeat(tabs * size);
				violations.push({
					rule: 'ninja.layout.indent',
					message: 'Expected spaces for indentation, found tabs',
					range,
					action: { type: FixAction.TYPE, ops: [replaceOp(range, replacement)], autoFix: true },
				});
				continue;
			}

			if (unit === 'tab' && spaces > 0) {
				const range = new vscode.Range(i, 0, i, spaces);
				const replacement = '\t'.repeat(Math.ceil(spaces / size));
				violations.push({
					rule: 'ninja.layout.indent',
					message: 'Expected tabs for indentation, found spaces',
					range,
					action: { type: FixAction.TYPE, ops: [replaceOp(range, replacement)], autoFix: true },
				});
				continue;
			}

			// Check indentation size (only for spaces — tab width is ambiguous)
			if (unit === 'space' && spaces % size !== 0) {
				const range = new vscode.Range(i, 0, i, spaces);
				const nearest = Math.round(spaces / size) * size;
				const replacement = ' '.repeat(nearest || size);
				violations.push({
					rule: 'ninja.layout.indent',
					message: `Indentation is ${spaces} spaces (expected multiple of ${size})`,
					range,
					action: { type: FixAction.TYPE, ops: [replaceOp(range, replacement)], autoFix: true },
				});
			}
		}

		return violations;
	},
};
