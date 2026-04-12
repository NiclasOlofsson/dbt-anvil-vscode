import type { PyodideInterface } from 'pyodide';
import { blankJinja } from '../dbt/jinja-blanker';
import { renderForParse, renToRawLine } from './nunjucks-renderer';
import type { LineMap } from './nunjucks-renderer';
import type { AstPayload, ParseResult } from './parse-result';
import { extractJinjaSpans } from './jinja-spans';
import type { SqlParser } from './sql-parser';

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

    private constructor(pyodide: PyodideInterface) {
        this.#pyodide = pyodide;
        const source = pyodide.FS.readFile('/scripts/sql_parser.py', { encoding: 'utf8' }) as string;
        pyodide.runPython(source);
        this.#fn = pyodide.globals.get('_parse') as (sql: string, dialect: string, schemaJson: string) => string;
    }

    static create(pyodide: PyodideInterface): PyodideSqlParser {
        return new PyodideSqlParser(pyodide);
    }

    async parse(rawSql: string, dialect: string, schema?: Record<string, Record<string, string>>): Promise<ParseResult> {
        const schemaJson = schema ? JSON.stringify(schema) : '';
        const jinjaTags = extractJinjaSpans(rawSql);

        // Pass 1: length-preserving blank, identifier mode — preserves exact source offsets.
        const pass1 = this.#fn(blankJinja(rawSql), dialect, schemaJson);
        const result1 = JSON.parse(pass1) as ParseResult;
        if (!result1.warnings.some(w => w.type === 'syntax_error')) {
            result1.jinjaTags = jinjaTags;
            return result1;
        }

        // Pass 1b: length-preserving blank, comment mode — replaces unknown macros with
        // /* ... */ block comments (valid in any SQL position, same byte length).
        // Handles statement-level macros like {{ generic_is_deleted(col, 'where') }}
        // that produce a bare identifier in identifier mode and break the parse.
        const pass1b = this.#fn(blankJinja(rawSql, 'comment'), dialect, schemaJson);
        const result1b = JSON.parse(pass1b) as ParseResult;
        if (!result1b.warnings.some(w => w.type === 'syntax_error')) {
            result1b.jinjaTags = jinjaTags;
            return result1b;
        }

        // Pass 2: nunjucks stub render — valid SQL everywhere, offsets not preserved.
        // lineMap is used to remap rendered AST line numbers back to raw-source space.
        const { rendered, lineMap } = renderForParse(rawSql);
        const pass2 = this.#fn(rendered, dialect, schemaJson);
        const result2 = JSON.parse(pass2) as ParseResult;
        remapAstLines(result2, lineMap);
        for (const w of result2.warnings) {
            if (w.line !== undefined) w.line = renToRawLine(w.line, lineMap);
        }
        result2.jinjaTags = jinjaTags;
        return result2;
    }
}
