import type { PyodideInterface } from 'pyodide';
import { blankJinja } from '../dbt/jinja-blanker';
import { renderForParse, renToRawLine } from './nunjucks-renderer';
import type { LineMap } from './nunjucks-renderer';
import type { AstPayload, ParseResult } from './parse-result';
import { extractJinjaSpans } from './jinja-spans';
import type { DialectSymbols, SqlParser } from './sql-parser';

/**
 * Wraps an error that escaped the Python/Pyodide boundary without being caught.
 * Any unhandled Python exception or internal Pyodide fault surfaces as this.
 */
export class PyodideError extends Error {
	readonly cause: unknown;
	constructor(fn: string, cause: unknown) {
		const msg = cause instanceof Error ? cause.message : String(cause);
		super(`Pyodide error in ${fn}(): ${msg}`);
		this.name = 'PyodideError';
		this.cause = cause;
	}
}

/** Call a Pyodide-hosted Python function, re-throwing any exception as PyodideError. */
function callPython<T>(fn: string, callable: () => T): T {
	try {
		return callable();
	} catch (err) {
		throw new PyodideError(fn, err);
	}
}

/**
 * Remap AST node line numbers from rendered-space to raw-source space.
 * m.line is 1-based; line map breakpoints are 0-based — convert accordingly.
 */
function remapAstLines(result: ParseResult, lineMap: LineMap): void {
	for (const node of result.ast as AstPayload[]) {
		if (node.m?.line !== undefined) {
			node.m.line = renToRawLine(node.m.line - 1, lineMap) + 1;
		}
	}
}

export class PyodideSqlParser implements SqlParser {
	readonly #pyodide: PyodideInterface;
	readonly #fn: (sql: string, dialect: string, schemaJson: string) => string;
	readonly #lineageFn: (compiledSql: string, columnName: string, schemaJson: string, dialect: string) => string;
	readonly #lineageFnV2: (sql: string, columnName: string, schemaJson: string, dialect: string) => string;
	readonly #decomposeFn: (compiledSql: string, dialect: string) => string;
	readonly #symbolsFn: (dialect: string) => string;

	private constructor(pyodide: PyodideInterface) {
		this.#pyodide = pyodide;
		const source = pyodide.FS.readFile('/scripts/sql_parser.py', { encoding: 'utf8' }) as string;
		callPython('runPython', () => pyodide.runPython(source));
		this.#fn = pyodide.globals.get('_parse') as (sql: string, dialect: string, schemaJson: string) => string;
		this.#lineageFn = pyodide.globals.get('_trace_lineage') as (compiledSql: string, columnName: string, schemaJson: string, dialect: string) => string;
		this.#lineageFnV2 = pyodide.globals.get('_trace_lineage_v2') as (sql: string, columnName: string, schemaJson: string, dialect: string) => string;
		this.#decomposeFn = pyodide.globals.get('_decompose_query') as (compiledSql: string, dialect: string) => string;
		this.#symbolsFn = pyodide.globals.get('_get_dialect_symbols') as (dialect: string) => string;
	}

	static create(pyodide: PyodideInterface): PyodideSqlParser {
		return new PyodideSqlParser(pyodide);
	}

	traceLineage(_compiledSql: string, _columnName: string, _dialect: string, _schemaJson: string): string {
		throw new Error('traceLineage (v1) is deprecated — use traceLineageV2');
	}

	traceLineageV2(sql: string, columnName: string, dialect: string, schemaJson: string): string {
		const result1 = callPython('_trace_lineage_v2', () => this.#lineageFnV2(blankJinja(sql), columnName, schemaJson, dialect));
		if ((JSON.parse(result1) as { success: boolean }).success) return result1;

		const result2 = callPython('_trace_lineage_v2', () => this.#lineageFnV2(blankJinja(sql, 'comment'), columnName, schemaJson, dialect));
		if ((JSON.parse(result2) as { success: boolean }).success) return result2;

		const { rendered } = renderForParse(sql);
		return callPython('_trace_lineage_v2', () => this.#lineageFnV2(rendered, columnName, schemaJson, dialect));
	}

	decomposeQuery(compiledSql: string, dialect: string): string {
		return callPython('_decompose_query', () => this.#decomposeFn(compiledSql, dialect));
	}

	getDialectSymbols(dialect: string): Promise<DialectSymbols> {
		const raw = callPython('_get_dialect_symbols', () => this.#symbolsFn(dialect));
		const payload = JSON.parse(raw) as { functions: string[]; keywordTokenTypes: string[]; types: string[] };
		return Promise.resolve({
			functions: new Set(payload.functions),
			keywordTokenTypes: new Set(payload.keywordTokenTypes),
			types: new Set(payload.types),
		});
	}

	async parse(rawSql: string, dialect: string, schema?: Record<string, Record<string, string>>): Promise<ParseResult> {
		const schemaJson = schema ? JSON.stringify(schema) : '';
		const jinjaTags = extractJinjaSpans(rawSql);

		// Pass 1: length-preserving blank, identifier mode — preserves exact source offsets.
		const pass1 = callPython('_parse', () => this.#fn(blankJinja(rawSql), dialect, schemaJson));
		const result1 = JSON.parse(pass1) as ParseResult;
		if (!result1.warnings.some(w => w.type === 'syntax_error')) {
			result1.jinjaTags = jinjaTags;
			return result1;
		}

		// Pass 1b: length-preserving blank, comment mode — replaces unknown macros with
		// /* ... */ block comments (valid in any SQL position, same byte length).
		// Handles statement-level macros like {{ generic_is_deleted(col, 'where') }}
		// that produce a bare identifier in identifier mode and break the parse.
		const pass1b = callPython('_parse', () => this.#fn(blankJinja(rawSql, 'comment'), dialect, schemaJson));
		const result1b = JSON.parse(pass1b) as ParseResult;
		if (!result1b.warnings.some(w => w.type === 'syntax_error')) {
			result1b.jinjaTags = jinjaTags;
			return result1b;
		}

		// Pass 2: nunjucks stub render — valid SQL everywhere, offsets not preserved.
		// lineMap is used to remap rendered AST line numbers back to raw-source space.
		const { rendered, lineMap } = renderForParse(rawSql);
		const pass2 = callPython('_parse', () => this.#fn(rendered, dialect, schemaJson));
		const result2 = JSON.parse(pass2) as ParseResult;
		remapAstLines(result2, lineMap);
		for (const w of result2.warnings) {
			if (w.line !== undefined) w.line = renToRawLine(w.line, lineMap);
		}
		result2.jinjaTags = jinjaTags;
		return result2;
	}
}
