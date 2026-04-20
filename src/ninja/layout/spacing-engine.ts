/**
 * Shared spacing/line-position engine for Ninja layout rules.
 *
 * Rules that need to check WHERE a token sits on a line (leading, trailing,
 * alone) or HOW MUCH space surrounds it subscribe to this engine. One
 * traversal of the `ninjaSqlTokens` stream produces all events; each rule
 * filters by `diagnostic` tag to keep rule IDs distinct while sharing code.
 *
 * ## Event model
 * The engine emits `SpacingEvent` objects — either a `line-position` event
 * (token in wrong position on line) or a `spacing` event (wrong amount of
 * whitespace between two adjacent tokens). Each event carries an optional
 * pre-computed fix so rules don't have to re-derive positions.
 *
 * ## Spec shape
 * Each `TokenSpec` is keyed by one or more *sqlglot token type strings*
 * (not TokenKind — we need per-type precision for COMMA vs AND vs UNION).
 * Specs declare:
 *   - `diagnostic`       — the rule's tag (e.g. 'ninja.convention.comma-position')
 *   - `linePosition`     — expected position on the line (optional)
 *   - `configLinePosition` — override from NinjaConfig at runtime (optional)
 *   - `spaceBefore`      — space expected before the token (optional)
 *   - `spaceAfter`       — space expected after the token (optional)
 */

import * as vscode from 'vscode';
import type { SqlToken } from '../../ftl/parse-result';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';
import type { NinjaConfig } from '../config';
import { lastContentTokenOnLine, firstContentTokenOnLine, tokenStartCol } from '../fix-utils';

export type LinePositionPolicy = 'leading' | 'trailing' | 'alone';
export type SpacingPolicy = 'space' | 'no-space';

export interface TokenSpec {
	/** One or more sqlglot token type strings this spec applies to. */
	tokenTypes: string | string[];
	/** Rule id / diagnostic tag used to filter events. */
	diagnostic: string;
	/** Static expected line position. Overridden by configLinePosition when present. */
	linePosition?: LinePositionPolicy;
	/** Dynamic line position read from config at check time. Takes priority over linePosition. */
	configLinePosition?: (config: NinjaConfig) => LinePositionPolicy | undefined;
	/** Expected whitespace to the LEFT of this token. */
	spaceBefore?: SpacingPolicy;
	/** Expected whitespace to the RIGHT of this token. */
	spaceAfter?: SpacingPolicy;
}

export interface LinePositionEvent {
	kind: 'line-position';
	diagnostic: string;
	token: SqlToken;
	policy: LinePositionPolicy;
	/** Where it actually sits: true = is leading, etc. */
	isLeading: boolean;
	isTrailing: boolean;
	range: vscode.Range;
	message: string;
	fix?: { edits: vscode.TextEdit[]; autoFix: boolean };
}

export interface SpacingEvent {
	kind: 'spacing';
	diagnostic: string;
	token: SqlToken;
	prevToken: SqlToken | null;
	expectedSpace: boolean;
	actualSpace: boolean;
	range: vscode.Range;
	message: string;
	fix?: { edits: vscode.TextEdit[]; autoFix: boolean };
}

export type EngineEvent = LinePositionEvent | SpacingEvent;

/**
 * Run the spacing/line-position engine over a document's SQL token stream.
 *
 * @param ninjaSqlTokens  Unified stream from DocumentModel.
 * @param document        Live VS Code document (for offsetAt/positionAt).
 * @param config          Current Ninja config.
 * @param specs           The rule-defined specifications to check against.
 * @param filterDiagnostic  If provided, only events with this diagnostic are returned.
 *                          Omit (or pass undefined) to return all events.
 */
export function runSpacingEngine(
	ninjaSqlTokens: NinjaSqlToken[] | undefined,
	document: vscode.TextDocument,
	config: NinjaConfig,
	specs: TokenSpec[],
	filterDiagnostic?: string,
): EngineEvent[] {
	const sqlTokens = sqlOnly(ninjaSqlTokens);
	if (sqlTokens.length === 0) return [];

	// Build a lookup map: token type → spec (last registration wins on collision).
	const specByType = new Map<string, TokenSpec>();
	for (const spec of specs) {
		const types = Array.isArray(spec.tokenTypes) ? spec.tokenTypes : [spec.tokenTypes];
		for (const t of types) specByType.set(t, spec);
	}

	const text = document.getText();
	const lines = text.split('\n');
	const events: EngineEvent[] = [];

	for (let i = 0; i < sqlTokens.length; i++) {
		const tok = sqlTokens[i];
		const spec = specByType.get(tok.type);
		if (!spec) continue;
		if (filterDiagnostic && spec.diagnostic !== filterDiagnostic) continue;

		const prev = i > 0 ? sqlTokens[i - 1] : null;
		const next = i < sqlTokens.length - 1 ? sqlTokens[i + 1] : null;
		const line = tok.line;
		if (line >= lines.length) continue;

		const lineText = lines[line];
		const tokStartCol = tokenStartCol(tok);

		// ── Line-position check ────────────────────────────────────────────────
		const posPolicy = spec.configLinePosition?.(config) ?? spec.linePosition;
		if (posPolicy) {
			const beforeTok = lineText.slice(0, tokStartCol).trim();
			const afterTok = lineText.slice(tok.col).trim().replace(/^--.*/, '').trim();
			const isLeading = beforeTok === '';
			const isTrailing = afterTok === '';

			let violated = false;
			// For trailing/leading policies: only flag tokens that are definitively
			// in the WRONG boundary position. A token in the middle of a line
			// (neither leading nor trailing) is on a single-line expression and is
			// never a violation — the reflow engine handles those cases.
			if (posPolicy === 'trailing' && isLeading) violated = true;   // at start of line, should be at end of prev
			if (posPolicy === 'leading' && isTrailing) violated = true;    // at end of line, should be at start of next
			if (posPolicy === 'alone' && (!isLeading || !isTrailing)) violated = true;

			if (violated) {
				const range = new vscode.Range(line, tokStartCol, line, tok.col);
				const tokenText = lineText.slice(tokStartCol, tok.col);
				const message = posPolicy === 'trailing'
					? `'${tokenText}' should be at the end of the previous line (trailing), not at the start.`
					: posPolicy === 'leading'
						? `'${tokenText}' should be at the start of the next line (leading), not at the end.`
						: `'${tokenText}' should be on its own line.`;

				const fix = buildLinePositionFix(tok, posPolicy, isLeading, isTrailing, lines, sqlTokens, document);
				events.push({ kind: 'line-position', diagnostic: spec.diagnostic, token: tok, policy: posPolicy, isLeading, isTrailing, range, message, fix });
			}
		}

		// ── Space-before check ─────────────────────────────────────────────────
		if (spec.spaceBefore !== undefined && prev && prev.line === tok.line) {
			// Only check within the same line (cross-line spacing is a line-position concern).
			const gapStart = prev.end + 1; // inclusive end → exclusive start of gap
			const gapEnd = tok.start;
			const gapLen = gapEnd - gapStart;
			const expectedSpace = spec.spaceBefore === 'space';
			const actualSpace = gapLen > 0;

			if (expectedSpace !== actualSpace) {
				const range = actualSpace
					? new vscode.Range(document.positionAt(gapStart), document.positionAt(gapEnd))
					: new vscode.Range(document.positionAt(gapEnd), document.positionAt(gapEnd));

				const tokenText = lineText.slice(tokStartCol, tok.col);
				const message = expectedSpace
					? `Expected a space before '${tokenText}'.`
					: `Unexpected space before '${tokenText}'.`;

				const fix = buildSpacingFix(gapStart, gapEnd, expectedSpace, document);
				events.push({ kind: 'spacing', diagnostic: spec.diagnostic, token: tok, prevToken: prev, expectedSpace, actualSpace, range, message, fix });
			}
		}

		// ── Space-after check ──────────────────────────────────────────────────
		if (spec.spaceAfter !== undefined && next && next.line === tok.line) {
			const gapStart = tok.end + 1;
			const gapEnd = next.start;
			const gapLen = gapEnd - gapStart;
			const expectedSpace = spec.spaceAfter === 'space';
			const actualSpace = gapLen > 0;

			if (expectedSpace !== actualSpace) {
				const range = actualSpace
					? new vscode.Range(document.positionAt(gapStart), document.positionAt(gapEnd))
					: new vscode.Range(document.positionAt(gapEnd), document.positionAt(gapEnd));

				const tokenText = lineText.slice(tokStartCol, tok.col);
				const message = expectedSpace
					? `Expected a space after '${tokenText}'.`
					: `Unexpected space after '${tokenText}'.`;

				const fix = buildSpacingFix(gapStart, gapEnd, expectedSpace, document);
				events.push({ kind: 'spacing', diagnostic: spec.diagnostic, token: tok, prevToken: tok as unknown as SqlToken, expectedSpace, actualSpace, range, message, fix });
			}
		}
	}

	return events;
}

// ── Fix builders ────────────────────────────────────────────────────────────

function buildSpacingFix(
	gapStart: number,
	gapEnd: number,
	expectedSpace: boolean,
	document: vscode.TextDocument,
): { edits: vscode.TextEdit[]; autoFix: boolean } | undefined {
	if (expectedSpace) {
		// Insert a space where there is none.
		const pos = document.positionAt(gapEnd);
		return { edits: [vscode.TextEdit.insert(pos, ' ')], autoFix: true };
	} else {
		// Delete the whitespace gap.
		const range = new vscode.Range(document.positionAt(gapStart), document.positionAt(gapEnd));
		return { edits: [vscode.TextEdit.delete(range)], autoFix: true };
	}
}

/** Build a fix for a line-position violation. Returns undefined for complex cases. */
export function buildLinePositionFix(
	tok: SqlToken,
	policy: LinePositionPolicy,
	isLeading: boolean,
	isTrailing: boolean,
	lines: string[],
	sqlTokens: SqlToken[],
	_document: vscode.TextDocument,
): { edits: vscode.TextEdit[]; autoFix: boolean } | undefined {
	const line = tok.line;
	const tokStartCol = tokenStartCol(tok);
	const lineText = lines[line];

	if (policy === 'trailing' && isLeading && line > 0) {
		// Token is at the start of a line but should be at the end of the previous line.
		// Pattern: move token from current line start → previous line end.
		const tokenStr = lineText.slice(tokStartCol, tok.col).trim();
		const trailingSpace = lineText[tok.col] === ' ' ? 1 : 0;

		// Find the best insert point on the previous line.
		let prevSqlLine = line - 1;
		while (prevSqlLine > 0 && !lastContentTokenOnLine(sqlTokens, prevSqlLine)) prevSqlLine--;
		const prevAnchor = lastContentTokenOnLine(sqlTokens, prevSqlLine);
		const insertCol = prevAnchor?.col ?? lines[prevSqlLine].length;

		return {
			edits: [
				vscode.TextEdit.insert(new vscode.Position(prevSqlLine, insertCol), ` ${tokenStr}`),
				vscode.TextEdit.delete(new vscode.Range(line, tokStartCol, line, tok.col + trailingSpace)),
			],
			autoFix: true,
		};
	}

	if (policy === 'leading' && isTrailing && line < lines.length - 1) {
		// Token is at the end of a line but should be at the start of the next line.
		const tokenStr = lineText.slice(tokStartCol, tok.col).trim();
		const spaceBefore = tokStartCol > 0 && lineText[tokStartCol - 1] === ' ' ? 1 : 0;
		const nextLine = line + 1;
		const nextAnchor = firstContentTokenOnLine(sqlTokens, nextLine);
		const insertCol = nextAnchor ? tokenStartCol(nextAnchor) : (lines[nextLine].length - lines[nextLine].trimStart().length);

		return {
			edits: [
				vscode.TextEdit.delete(new vscode.Range(line, tokStartCol - spaceBefore, line, tok.col)),
				vscode.TextEdit.insert(new vscode.Position(nextLine, insertCol), `${tokenStr} `),
			],
			autoFix: true,
		};
	}

	if (policy === 'alone' && line > 0 && line < lines.length - 1) {
		// Token should be alone on its own line. If it isn't leading, we need a newline
		// before it; if it isn't trailing, we need a newline after.
		// Simple case: token is in the middle of a line — we'd need to split the line,
		// which is a multi-edit operation. Return undefined to keep this detection-only
		// until the reflow engine (Layer 3) can handle it properly.
		if (!isLeading || !isTrailing) return undefined;
	}

	return undefined;
}
