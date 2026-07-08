import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';
import { runNinja, type NinjaResult } from '../../ninja/engine';
import type { CteInfo, DocumentModel } from '../../services/parse-service';
import type { SqlToken } from '../../ftl/sql-tokens';
import type { DialectSymbols } from '../../ftl/sql-tokens';
import { mergeSqlAndJinjaTokens } from '../../ftl/ninja-sql-tokens';
import { MAIN_FRAME } from '../../ftl/sqllens/api';
import type { PartSpan, Sym, SymbolModifier } from '../../ftl/sqllens/api';
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

/** Empty DocumentModel (no symbols → all words are candidates for capitalisation rules). */
export const emptyModel: DocumentModel = {
	ctes: [],
	refs: [],
	sources: [],
	finalColumns: [],
	symbols: [],
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

/**
 * Build a `Sym` stub.
 * `line`/`endLine` are 0-based, matching every other helper in this file — converted
 * internally to `Sym.span`'s 1-based `line`/`endLine` (the ANTLR convention sqllens
 * itself uses). `frame` defaults to `MAIN_FRAME`; pass a CTE/subquery name for a
 * symbol inside one.
 *
 * `definitionOf` wires up `.definition` (the span a REFERENCE Sym resolves to) —
 * from a declaration Sym's own span, or straight from a `CteInfo` (0-based
 * `line`/`col`, matching this file's other CTE fixtures) when there's no
 * declaration Sym in the fixture. Needed for a `cte`-kind reference fixture:
 * matching it to its declaration (`symMatchesCte`/`symsMatchSameCte`,
 * sym-spans.ts) compares structural anchors, never `.name` (a CTE's `Sym.name`
 * is sqllens's `displayName` — the declared spelling, not safe for identity
 * comparison on its own).
 *
 * `alias` wires up `Sym.alias` (a relation Sym's own alias, carried directly
 * per sqllens's native `Sym.alias` field) — pass its 0-based `line`/`col`.
 * `relationNameRangeOf` (sym-spans.ts) checks this field's presence to decide
 * whether a reference needs narrowing at all.
 *
 * `source` wires up `Sym.source` (a column reference's bound relation, carried
 * directly per sqllens's native field) — pass the relation Sym it resolves to.
 */
export function sym(
	kind: Sym['kind'],
	name: string,
	line: number,
	col: number,
	opts: {
		modifiers?: SymbolModifier[];
		frame?: string;
		endCol?: number;
		endLine?: number;
		definitionOf?: Sym | CteInfo;
		alias?: { name: string; line: number; col: number; endCol?: number };
		source?: Sym;
	} = {},
): Sym {
	const defSource = opts.definitionOf;
	const definition = defSource === undefined ? undefined
		: 'span' in defSource ? defSource.span
			: { line: defSource.line + 1, column: defSource.col ?? 0, endLine: defSource.line + 1, endColumn: (defSource.col ?? 0) + name.length };
	const aliasField = opts.alias === undefined ? undefined : {
		name: opts.alias.name,
		span: {
			line: opts.alias.line + 1,
			column: opts.alias.col,
			endLine: opts.alias.line + 1,
			endColumn: opts.alias.endCol ?? opts.alias.col + opts.alias.name.length,
		},
	};
	return {
		kind,
		modifiers: opts.modifiers ?? ['reference'],
		name,
		span: {
			line: line + 1,
			column: col,
			endLine: (opts.endLine ?? line) + 1,
			endColumn: opts.endCol ?? col + name.length,
		},
		frame: opts.frame ?? MAIN_FRAME,
		...(definition ? { definition } : {}),
		...(aliasField ? { alias: aliasField } : {}),
		...(opts.source ? { source: opts.source } : {}),
	};
}

/**
 * Build a column-reference `Sym` with real per-part spans, so `nameRangeOf`/
 * `qualifierRangeOf` (`src/providers/sql/sym-spans.ts`) compute the same
 * sub-ranges sqllens itself would for a dotted column ref (`o.customer_id` →
 * one span for `o`, one for `customer_id`). `line` is 0-based, matching
 * `sym()` above; each part's `col` is that part's own 0-based start column.
 * `source` wires up `Sym.source` (the relation Sym this column resolves to).
 */
export function colSym(
	line: number,
	parts: Array<{ name: string; col: number }>,
	opts: { modifiers?: SymbolModifier[]; frame?: string; source?: Sym } = {},
): Sym {
	const partSpans: PartSpan[] = parts.map(p => ({
		start: 0,
		end: 0,
		line: line + 1,
		column: p.col,
		endLine: line + 1,
		endColumn: p.col + p.name.length,
	}));
	return {
		kind: 'column',
		modifiers: opts.modifiers ?? ['reference'],
		name: parts.map(p => p.name).join('.'),
		span: {
			line: line + 1,
			column: parts[0].col,
			endLine: line + 1,
			endColumn: partSpans[partSpans.length - 1].endColumn,
		},
		frame: opts.frame ?? MAIN_FRAME,
		partSpans,
		...(opts.source ? { source: opts.source } : {}),
	};
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
 * Stub `DialectSymbols` for unit tests that want to exercise the reflow engine's
 * capitalisation LOGIC in isolation from a real dialect's actual keyword/function/
 * type lists — a small curated set keeps assertions legible and stable regardless
 * of what a given dialect happens to define. Real dialect-aware integration
 * coverage (parsing real SQL, calling the real `getDialectSymbols()`) already
 * exists in corpus-fixtures.test.ts / rule-fixtures.test.ts / format-roundtrip.test.ts;
 * this fixture intentionally lives in test helpers, not production, so no
 * production code depends on hardcoded keyword/type lists.
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
