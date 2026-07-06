import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';
import { runNinja, type NinjaResult } from '../../ninja/engine';
import type { CteInfo, ColumnRefToken, TableRefToken, ColumnDefToken, DocumentModel } from '../../services/parse-service';
import type { SqlToken } from '../../ftl/sql-tokens';
import type { DialectSymbols } from '../../ftl/sql-tokens';
import { mergeSqlAndJinjaTokens } from '../../ftl/ninja-sql-tokens';
import * as vscode from 'vscode';

type ConfigOverride = Omit<Partial<NinjaConfig>, 'indentation' | 'layout' | 'capitalisation'> & {
	indentation?: Partial<NinjaConfig['indentation']>;
	layout?: Partial<Omit<NinjaConfig['layout'], 'alwaysWrap'>> & {
		alwaysWrap?: Partial<NinjaConfig['layout']['alwaysWrap']>;
	};
	capitalisation?: Partial<NinjaConfig['capitalisation']>;
};

/** Build a minimal NinjaConfig with optional overrides. */
export function cfg(overrides: ConfigOverride = {}): NinjaConfig {
	return {
		...DEFAULT_CONFIG,
		...overrides,
		indentation: { ...DEFAULT_CONFIG.indentation, ...overrides.indentation },
		capitalisation: { ...DEFAULT_CONFIG.capitalisation, ...overrides.capitalisation },
		layout: {
			...DEFAULT_CONFIG.layout,
			...overrides.layout,
			alwaysWrap: { ...DEFAULT_CONFIG.layout.alwaysWrap, ...overrides.layout?.alwaysWrap },
		},
	};
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
export function run(sql: string, config?: ConfigOverride, model?: DocumentModel): NinjaResult {
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
 * Apply a list of FixOps to a string, returning the result.
 * Ops are applied end-to-start (by offset) so earlier ops don't shift later ones.
 */
export function applyEditsToText(text: string, ops: import('../../ninja/fix-op').FixOp[]): string {
	const doc = mockDocument(text);
	type Segment = { start: number; end: number; replacement: string };
	const segments: Segment[] = ops.map(op => {
		if (op.kind === 'replace') {
			return { start: doc.offsetAt(op.range.start), end: doc.offsetAt(op.range.end), replacement: op.text };
		} else if (op.kind === 'delete') {
			return { start: doc.offsetAt(op.range.start), end: doc.offsetAt(op.range.end), replacement: '' };
		} else {
			// insert or linebreak — both have a position
			const offset = doc.offsetAt(op.kind === 'insert' ? op.position : op.position);
			return { start: offset, end: offset, replacement: op.kind === 'insert' ? op.text : '\n' };
		}
	});
	const sorted = segments.sort((a, b) => b.start - a.start);
	let result = text;
	for (const seg of sorted) {
		result = result.slice(0, seg.start) + seg.replacement + result.slice(seg.end);
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

/**
 * Stub `DialectSymbols` for unit tests that want to exercise recasing
 * without running the full parser. Production always gets the real dialect-aware
 * sets from the active dialect — this fixture intentionally lives in test helpers
 * so no production code depends on hardcoded keyword/type lists.
 *
 * Callers can override any of the three sets; defaults cover the common
 * shapes used across reflow unit tests (SELECT/FROM/WHERE keywords,
 * count/coalesce/etc. functions, int/varchar/timestamp types).
 */
export function stubDialectSymbols(overrides: Partial<{
	keywordTokenTypes: Iterable<string>;
	functions: Iterable<string>;
	types: Iterable<string>;
}> = {}): DialectSymbols {
	return {
		keywordTokenTypes: new Set(overrides.keywordTokenTypes ?? [
			'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
			'as', 'alias', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross',
			'group', 'by', 'order', 'having', 'limit', 'offset', 'union', 'all',
			'group_by', 'order_by', 'not_in',
			'distinct', 'case', 'when', 'then', 'else', 'end', 'with',
			'between', 'like', 'ilike', 'asc', 'desc', 'over', 'partition',
			'except', 'intersect', 'true', 'false', 'cast', 'using',
			'qualify', 'pivot', 'unpivot',
		]),
		functions: new Set(overrides.functions ?? [
			'count', 'coalesce', 'nullif', 'cast', 'lower', 'upper',
			'sum', 'avg', 'min', 'max', 'round', 'abs', 'trim',
		]),
		types: new Set(overrides.types ?? [
			'int', 'integer', 'bigint', 'smallint', 'varchar', 'char', 'text',
			'boolean', 'bool', 'date', 'datetime', 'timestamp', 'timestamptz',
			'float', 'double', 'decimal', 'numeric', 'real', 'json', 'uuid',
		]),
	};
}
