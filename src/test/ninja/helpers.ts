import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';
import { runNinja, type NinjaResult } from '../../ninja/engine';
import type { CteInfo, ColumnRefToken, TableRefToken, ColumnDefToken, DocumentModel } from '../../services/parse-service';
import type { SqlToken } from '../../ftl/parse-result';
import { mergeSqlAndJinjaTokens } from '../../ftl/ninja-sql-tokens';
import * as vscode from 'vscode';

/** Build a minimal NinjaConfig with optional overrides. */
export function cfg(overrides: Partial<NinjaConfig> = {}): NinjaConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

/** Build a minimal mock vscode.TextDocument from SQL text. */
export function mockDocument(text: string): vscode.TextDocument {
	const lines = text.split('\n');
	return {
		getText: () => text,
		positionAt(offset: number) {
			let remaining = offset;
			for (let i = 0; i < lines.length; i++) {
				if (remaining <= lines[i].length) return new vscode.Position(i, remaining);
				remaining -= lines[i].length + 1;
			}
			return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
		},
		offsetAt(pos: vscode.Position) {
			let offset = 0;
			for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
			return offset + pos.character;
		},
		lineAt(line: number) {
			return { text: lines[line], lineNumber: line, range: new vscode.Range(line, 0, line, lines[line].length) };
		},
		lineCount: lines.length,
		uri: vscode.Uri.file('/test.sql'),
		fileName: '/test.sql',
		languageId: 'sql',
		version: 1,
		isDirty: false,
		isUntitled: false,
		isClosed: false,
		eol: 1,
		save: async () => true,
		getWordRangeAtPosition: () => undefined,
		validateRange: (r: vscode.Range) => r,
		validatePosition: (p: vscode.Position) => p,
	} as unknown as vscode.TextDocument;
}

/** Empty DocumentModel (no tokens → all words are candidates for capitalisation rules). */
export const emptyModel: DocumentModel = {
	ctes: [],
	refs: [],
	sources: [],
	finalColumns: [],
	tokens: [],
	timing: { parseMs: 0, totalMs: 0 },
};

/** Run ninja and return result for convenience. */
export function run(sql: string, config?: Partial<NinjaConfig>, model?: DocumentModel): NinjaResult {
	const doc = mockDocument(sql);
	return runNinja(doc, model ?? emptyModel, [], cfg(config));
}

/** Shortcut: return just rule IDs for all violations. */
export function ruleIds(result: NinjaResult): string[] {
	return result.violations.map(v => v.rule);
}

/** Filter violations to a specific rule. */
export function violationsFor(result: NinjaResult, ruleId: string) {
	return result.violations.filter(v => v.rule === ruleId);
}

/** Build capitalisation config override for a single policy. */
export function capCfg(key: 'keywords' | 'functions' | 'literals' | 'types', policy: 'upper' | 'lower' | 'consistent') {
	return { capitalisation: { ...DEFAULT_CONFIG.capitalisation, [key]: policy } };
}

/**
 * Apply a list of TextEdits to a string, returning the result.
 * Edits are applied end-to-start (by offset) so earlier edits don't shift later ones.
 */
export function applyEditsToText(text: string, edits: vscode.TextEdit[]): string {
	const doc = mockDocument(text);
	const sorted = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
	let result = text;
	for (const edit of sorted) {
		const start = doc.offsetAt(edit.range.start);
		const end = doc.offsetAt(edit.range.end);
		result = result.slice(0, start) + edit.newText + result.slice(end);
	}
	return result;
}

// ── Model-building helpers for semantic rules ──────────────────────────

/** Build a CteInfo stub. */
export function cte(name: string, line: number, endLine: number, columns: string[] = [], col = 0, endCol?: number): CteInfo {
	return {
		name,
		line,
		col,
		endLine,
		endCol,
		columns: columns.map(c => ({ name: c, line })),
	};
}

/** Build a ColumnRefToken stub. */
export function colRef(name: string, line: number, col: number, table?: string, resolved?: TableRefToken): ColumnRefToken {
	return {
		type: 'column_ref',
		name,
		line,
		col,
		endCol: col + name.length,
		table,
		resolvedTableRef: resolved,
	};
}

/** Build a TableRefToken stub. */
export function tableRef(name: string, line: number, col: number, alias?: string): TableRefToken {
	return {
		type: 'table_ref',
		name,
		line,
		col,
		endCol: col + name.length,
		alias,
		...(alias ? { aliasLine: line, aliasCol: col + name.length + 1, aliasEndCol: col + name.length + 1 + alias.length } : {}),
	};
}

/** Build a ColumnDefToken stub. */
export function colDef(name: string, line: number, col: number): ColumnDefToken {
	return { type: 'column_def', name, line, col, endCol: col + name.length };
}

/** Build a SqlToken stub. */
export function sqlTok(type: string, start: number, end: number, line: number, col: number): SqlToken {
	return { type, start, end, line, col };
}

/**
 * Build a DocumentModel with custom fields.
 *
 * Accepts optional `sqlTokens` / `jinjaTokens` as convenience inputs — when
 * either is supplied without an explicit `ninjaSqlTokens`, the merged stream
 * is derived automatically and stored on the model. This keeps tests terse
 * (build SQL tokens, get the unified stream for free) without hand-rolling
 * `mergeSqlAndJinjaTokens` at every call site.
 */
import type { JinjaToken } from '../../ftl/jinja-tokenizer';
export function model(
	overrides: Partial<DocumentModel> & { sqlTokens?: SqlToken[]; jinjaTokens?: JinjaToken[] } = {},
): DocumentModel {
	const { sqlTokens, jinjaTokens, ...modelFields } = overrides;
	const merged: DocumentModel = { ...emptyModel, ...modelFields };
	if (merged.jinjaTokens === undefined && jinjaTokens !== undefined) merged.jinjaTokens = jinjaTokens;
	if (merged.ninjaSqlTokens === undefined && (sqlTokens || jinjaTokens)) {
		merged.ninjaSqlTokens = mergeSqlAndJinjaTokens(sqlTokens ?? [], jinjaTokens ?? []);
	}
	return merged;
}
