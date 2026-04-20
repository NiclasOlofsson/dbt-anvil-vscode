import type { PyodideInterface } from 'pyodide';
import { renToRawLine } from './nunjucks-renderer';
import type { LineMap } from './nunjucks-renderer';
import type { AstPayload, ParseResult } from './parse-result';
import { tokenizeJinja } from './jinja-tokenizer';
import { parseWithJinjaFallback } from './parse-with-jinja-fallback';
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
		const { result } = parseWithJinjaFallback(
			sql,
			passSql => callPython('_trace_lineage_v2', () => this.#lineageFnV2(passSql, columnName, schemaJson, dialect)),
			r => (JSON.parse(r) as { success: boolean }).success,
		);
		return result;
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
		const jinjaTokens = tokenizeJinja(rawSql);

		// Three-pass cascade:
		//   pass1   — length-preserving blank, identifier mode (preserves source offsets)
		//   pass1b  — length-preserving blank, comment mode (handles statement-level macros)
		//   pass2   — nunjucks stub render (valid SQL everywhere; offsets shift, lineMap used to remap)
		let pass1Result: ParseResult | undefined;
		const { result, pass, lineMap } = parseWithJinjaFallback(
			rawSql,
			(passSql, p) => {
				const raw = callPython('_parse', () => this.#fn(passSql, dialect, schemaJson));
				const parsed = JSON.parse(raw) as ParseResult;
				if (p === 'pass1') pass1Result = parsed;
				return parsed;
			},
			r => !r.warnings.some(w => w.type === 'syntax_error'),
		);

		result.jinjaTokens = jinjaTokens;
		if (pass !== 'pass2') return result;

		remapAstLines(result, lineMap!);
		for (const w of result.warnings) {
			if (w.line !== undefined) w.line = renToRawLine(w.line, lineMap!);
		}
		// Pass 2 sqlTokens are in rendered-space (nunjucks-compiled), not raw-source
		// space. Pass 1 always uses length-preserving blanking, so its sqlTokens are
		// always in raw-source space — even when the parser failed. Use them instead.
		if (pass1Result) result.sqlTokens = pass1Result.sqlTokens;
		// Column numbers from the pass 2 AST are in rendered-space and are NOT
		// remapped — only line numbers are. Rules that build vscode.Range from AST
		// column positions must skip this result to avoid negative-character errors.
		result.isPass2 = true;
		return result;
	}
}
