/**
 * Shared structural-indentation engine for Ninja layout rules.
 *
 * Rules that need to verify WHERE a token sits relative to its governing
 * clause keyword (e.g. ON relative to JOIN, THEN relative to WHEN) subscribe
 * to this engine. One traversal of the ninjaSqlTokens stream produces all
 * events; each rule filters by diagnostic tag.
 *
 * ## Algorithm
 * For each trigger token (ON, JOIN, THEN, …):
 *   1. Find the "anchor" — the first SQL token on the trigger's line.
 *   2. Validate the anchor type against the spec's anchorTypes set.
 *   3. Backtrack (with L_PAREN/R_PAREN depth tracking) to the nearest
 *      governing token (JOIN, FROM, WHEN, …).
 *   4. Use the first token on the governor's line as the indent reference.
 *   5. Compute expected vs actual column; emit an event on mismatch.
 *
 * ## Governor line anchor
 * Using the first token on the governor's line (rather than the governor
 * token itself) handles `left join` correctly: JOIN is the governor for ON,
 * but LEFT precedes JOIN on the line — its column (0) is the clean base.
 */

import * as vscode from 'vscode';
import type { SqlToken } from '../../ftl/parse-result';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';
import { sqlOnly, jinjaLeadingLines } from '../../ftl/ninja-sql-tokens';
import type { NinjaConfig } from '../config';
import { tokenStartCol } from '../fix-utils';
import { replaceOp, type FixOp } from '../fix-op';

export interface IndentSpec {
	/** Token types that trigger an indentation check. */
	triggerTypes: ReadonlySet<string>;
	/**
	 * Valid types for the first-on-line anchor token.
	 * Defaults to triggerTypes when absent.
	 * For JOIN: includes LEFT, RIGHT, FULL, etc. so `left join` is covered.
	 */
	anchorTypes?: ReadonlySet<string>;
	/** Token types that act as the indent base (governor). */
	governorTypes: ReadonlySet<string>;
	/** Rule ID / diagnostic tag. */
	diagnostic: string;
	/** Whether to add one extra indent level beyond the governor's level. */
	shouldIndent: (config: NinjaConfig) => boolean;
}

export interface IndentEvent {
	diagnostic: string;
	/** First content token on the offending line (the "anchor"). */
	token: SqlToken;
	/** First content token on the governor's line. */
	governor: SqlToken;
	expectedLevel: number;
	actualCol: number;
	expectedCol: number;
	range: vscode.Range;
	message: string;
	fix?: { ops: FixOp[]; autoFix: boolean };
}

/**
 * Run the structural indent engine over a document's SQL token stream.
 */
export function runIndentEngine(
	ninjaSqlTokens: NinjaSqlToken[] | undefined,
	_document: vscode.TextDocument,
	config: NinjaConfig,
	specs: IndentSpec[],
	filterDiagnostic?: string,
): IndentEvent[] {
	const sqlTokens = sqlOnly(ninjaSqlTokens);
	if (sqlTokens.length === 0) return [];

	const indentStep = config.indentation.unit === 'tab' ? 1 : config.indentation.size;
	const events: IndentEvent[] = [];

	// Lines whose first content is a jinja tag — re-indenting these would
	// silently delete the jinja content that sits before the first SQL token.
	const jinjaLines = jinjaLeadingLines(ninjaSqlTokens);

	for (let i = 0; i < sqlTokens.length; i++) {
		const tok = sqlTokens[i];
		if (jinjaLines.has(tok.line)) continue;

		for (const spec of specs) {
			if (!spec.triggerTypes.has(tok.type)) continue;
			if (filterDiagnostic && spec.diagnostic !== filterDiagnostic) continue;

			// Anchor: first content token on this line
			const anchor = firstOnLine(sqlTokens, tok.line);
			if (!anchor) continue;

			// Anchor type must match the spec
			const validAnchorTypes = spec.anchorTypes ?? spec.triggerTypes;
			if (!validAnchorTypes.has(anchor.type)) continue;

			// Governor: nearest matching token scanning backwards (bracket-aware)
			const governor = findGovernorLineAnchor(sqlTokens, i, spec.governorTypes);
			if (!governor) continue;

			// Skip when anchor and governor share the same line (inline expression)
			if (governor.line === anchor.line) continue;

			// Use the governor's EXACT column as the base (no rounding). This keeps
			// the rule convergent across iterations: if the governor is wrong its own
			// rule will fix it, and downstream rules just follow whatever it settles on.
			// Rounding would cause oscillation when the governor sits on an odd column.
			const govStartCol = tokenStartCol(governor);
			const actualStartCol = tokenStartCol(anchor);
			const extraLevel = spec.shouldIndent(config) ? 1 : 0;
			const expectedCol = govStartCol + extraLevel * indentStep;

			if (actualStartCol === expectedCol) continue;

			const line = anchor.line;
			const range = new vscode.Range(line, 0, line, actualStartCol);
			const label = anchor.type.toLowerCase().replace(/_/g, ' ');
			const message = actualStartCol < expectedCol
				? `'${label}' expected at column ${expectedCol} (currently column ${actualStartCol}).`
				: `'${label}' is over-indented at column ${actualStartCol} (expected column ${expectedCol}).`;

			const indentText = config.indentation.unit === 'tab'
				? '\t'.repeat(Math.floor(expectedCol / indentStep))
				: ' '.repeat(expectedCol);

			events.push({
				diagnostic: spec.diagnostic,
				token: anchor,
				governor,
				expectedLevel: Math.floor(expectedCol / indentStep),
				actualCol: actualStartCol,
				expectedCol,
				range,
				message,
				fix: { ops: [replaceOp(range, indentText)], autoFix: true },
			});

			break; // first matching spec wins for this token position
		}
	}

	return events;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function firstOnLine(tokens: SqlToken[], line: number): SqlToken | undefined {
	for (const t of tokens) {
		if (t.line === line) return t;
		if (t.line > line) return undefined;
	}
	return undefined;
}

/**
 * Scan backwards from `fromIdx`, tracking L/R paren depth.
 * Returns the first token in `governorTypes` found at depth 0.
 * Returns undefined if we exit a bracket group before finding one.
 */
function findGovernorLineAnchor(
	tokens: SqlToken[],
	fromIdx: number,
	governorTypes: ReadonlySet<string>,
): SqlToken | undefined {
	let depth = 0;
	for (let i = fromIdx - 1; i >= 0; i--) {
		const t = tokens[i];
		if (t.type === 'R_PAREN' || t.type === 'RPAREN') {
			depth++;
		} else if (t.type === 'L_PAREN' || t.type === 'LPAREN') {
			if (depth > 0) {
				depth--;
			} else {
				return undefined; // exited bracket scope
			}
		} else if (depth === 0 && governorTypes.has(t.type)) {
			return firstOnLine(tokens, t.line) ?? t;
		}
	}
	return undefined;
}
