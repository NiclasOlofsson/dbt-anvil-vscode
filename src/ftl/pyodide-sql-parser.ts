import type { PyodideInterface } from 'pyodide';
import type { ParseResult } from './parse-result';
import type { DialectSymbols, SqlParser } from './sql-parser';
import { parseTemplated, toSqllensDialect, type TagNode } from './sqllens/api';
import { jinjaTokensFromStream } from './sqllens/extract/jinja-stream';

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
 * Write each ref/source tag's real relation name over the sqllens placeholder,
 * left-aligned and space-padded within the tag span (newlines untouched) — the
 * same write `blankJinja` used to do. sqlglot binds relations from the TEXT it
 * parses (unlike sqllens, whose tag-applied ast rebinds real names after the
 * parse), so schema-based qualify + lineage need the real names in the fill.
 * Transitional: dies with this engine at cutover.
 */
function overlayRelationNames(placeholder: string, tags: TagNode[]): string {
	let buf: string[] | undefined;
	for (const tag of tags) {
		const name = tag.kind === 'ref' ? tag.model : tag.kind === 'source' ? tag.tableName : undefined;
		if (name === undefined) continue;
		buf ??= placeholder.split('');
		let j = 0;
		for (let i = tag.tagSpan.start; i < tag.tagSpan.end; i++) {
			if (buf[i] === '\n') continue;
			buf[i] = j < name.length ? name[j] : ' ';
			j++;
		}
	}
	return buf === undefined ? placeholder : buf.join('');
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
		const templated = parseTemplated(sql, toSqllensDialect(dialect));
		const passSql = overlayRelationNames(templated.placeholder, templated.tags);
		return callPython('_trace_lineage_v2', () => this.#lineageFnV2(passSql, columnName, schemaJson, dialect));
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

		// sqllens's templated front end handles the jinja: ONE length-/newline-
		// preserving fill (all positions stay in raw-source coordinates), with real
		// ref/source names overlaid for sqlglot's text-bound relation binding. The
		// old three-pass blank/render cascade is gone — when the filled text still
		// fails to parse, the result's syntax_error warnings ARE the answer, the
		// same as a pass1 failure was.
		const templated = parseTemplated(rawSql, toSqllensDialect(dialect));
		const passSql = overlayRelationNames(templated.placeholder, templated.tags);

		const raw = callPython('_parse', () => this.#fn(passSql, dialect, schemaJson));
		const result = JSON.parse(raw) as ParseResult;
		// jinjaTokens come from the SAME unified stream the fill came from, not a
		// second independent lex.
		result.jinjaTokens = jinjaTokensFromStream(templated.tokens, templated.tags, rawSql);
		return result;
	}
}
