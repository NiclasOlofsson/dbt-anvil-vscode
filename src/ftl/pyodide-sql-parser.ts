import type { PyodideInterface } from 'pyodide';
import { blankJinja } from '../dbt/jinja-blanker';
import { renderForParse, renToRawLine } from './nunjucks-renderer';
import type { LineMap } from './nunjucks-renderer';
import type { AstPayload, ParseResult } from './parse-result';
import { extractJinjaSpans } from './jinja-spans';
import type { SqlParser } from './sql-parser';

const PYTHON_SOURCE = `
import json as _json
import sys as _sys
import time as _time

from sqlglot import exp as _exp
from sqlglot import parse_one as _parse_one
from sqlglot import serde as _serde
from sqlglot.errors import ErrorLevel as _EL
from sqlglot.errors import ParseError as _ParseError
from sqlglot.optimizer.qualify import qualify as _qualify
from sqlglot.optimizer.scope import build_scope as _build_scope
from sqlglot import Dialect as _Dialect
from sqlglot.tokens import Tokenizer as _Tokenizer

_SQL_STUB = '__jinja__'


def _tokenize(sql, dialect):
    try:
        d = dialect or None
        tok = _Dialect.get_or_raise(d).tokenizer_class() if d else _Tokenizer()
        return [
            {
                'type': t.token_type.name,
                'start': t.start,
                'end': t.end,
                'line': t.line - 1,
                'col': t.col,
            }
            for t in tok.tokenize(sql)
        ]
    except Exception:
        return []


def _collect_parse_errors(warnings, errors):
    for ed in (errors or []):
        highlight = ed.get('highlight') or ''
        if _SQL_STUB in highlight:
            continue
        line_1 = ed.get('line') or 1
        col_end_0 = ed.get('col') or 1  # sqlglot col is 1-based inclusive end = 0-based exclusive end
        col_0 = max(0, col_end_0 - len(highlight))
        warnings.append({
            'type': 'syntax_error',
            'message': ed.get('description') or '',
            'line': line_1 - 1,  # 0-based
            'col': col_0,
            'endCol': col_end_0,
        })


def _ser_scopes(root):
    all_scopes = []
    idx_map = {}
    queue = [root]
    while queue:
        s = queue.pop(0)
        idx_map[id(s)] = len(all_scopes)
        all_scopes.append(s)
        queue.extend(s.cte_scopes)
        queue.extend(s.union_scopes)
        queue.extend(s.subquery_scopes)
    out = []
    for s in all_scopes:
        sel = s.expression.find(_exp.Select) if s.expression else None
        srcs = {}
        for k, v in s.sources.items():
            srcs[k] = {
                'type': 'table' if isinstance(v, _exp.Table) else 'scope',
                'name': v.alias_or_name if hasattr(v, 'alias_or_name') else str(k),
            }
        out.append({
            'type': s.scope_type.name.lower(),
            'parentIndex': idx_map.get(id(s.parent)),
            'cteScopes': [idx_map[id(c)] for c in s.cte_scopes if id(c) in idx_map],
            'unionScopes': [idx_map[id(c)] for c in s.union_scopes if id(c) in idx_map],
            'subqueryScopes': [idx_map[id(c)] for c in s.subquery_scopes if id(c) in idx_map],
            'sources': srcs,
            'columns': [c.alias_or_name for c in (sel.expressions if sel else [])],
        })
    return out


def _parse(sql, dialect, schema_json):
    schema = _json.loads(schema_json) if schema_json else {}
    d = dialect or None
    warnings = []
    t0 = _time.time()
    sql_tokens = _tokenize(sql, dialect)
    t_tok = _time.time()
    ast = None
    parse_exc = None
    try:
        ast = _parse_one(sql, dialect=d, error_level=None)
    except _ParseError as e:
        parse_exc = e
    if parse_exc is not None:
        t_err = _time.time()
        _collect_parse_errors(warnings, getattr(parse_exc, 'errors', None))
        if not warnings:
            warnings.append({'type': 'syntax_error', 'message': str(parse_exc)})
        elapsed = round((t_err - t0) * 1000, 1)
        return _json.dumps({
            'ast': [],
            'scopes': [],
            'dialect': dialect or '',
            'warnings': warnings,
            'sqlTokens': sql_tokens,
            'timing': {'tokenizeMs': round((t_tok - t0) * 1000, 1), 'parseMs': round((t_err - t_tok) * 1000, 1), 'qualifyMs': 0, 'scopeMs': 0, 'totalMs': elapsed},
        })
    if ast is None:
        t_none = _time.time()
        elapsed = round((t_none - t0) * 1000, 1)
        return _json.dumps({
            'ast': [],
            'scopes': [],
            'dialect': dialect or '',
            'warnings': warnings,
            'sqlTokens': sql_tokens,
            'timing': {'tokenizeMs': round((t_tok - t0) * 1000, 1), 'parseMs': round((t_none - t_tok) * 1000, 1), 'qualifyMs': 0, 'scopeMs': 0, 'totalMs': elapsed},
        })
    # RAISE re-parse: catches errors that error_level=None swallowed into a partial AST.
    try:
        _parse_one(sql, dialect=d, error_level=_EL.RAISE)
    except _ParseError as rerr:
        _collect_parse_errors(warnings, getattr(rerr, 'errors', None))
    except Exception:
        pass
    t1 = _time.time()
    try:
        ast = _qualify(ast, schema=schema, infer_schema=True, qualify_columns=True, validate_qualify_columns=False)
    except Exception:
        pass
    t2 = _time.time()
    root = None
    try:
        root = _build_scope(ast)
    except Exception:
        pass
    t3 = _time.time()
    return _json.dumps({
        'ast': _serde.dump(ast),
        'scopes': _ser_scopes(root) if root else [],
        'dialect': dialect or '',
        'warnings': warnings,
        'sqlTokens': sql_tokens,
        'timing': {
            'tokenizeMs': round((t_tok - t0) * 1000, 1),
            'parseMs': round((t1 - t_tok) * 1000, 1),
            'qualifyMs': round((t2 - t1) * 1000, 1),
            'scopeMs': round((t3 - t2) * 1000, 1),
            'totalMs': round((t3 - t0) * 1000, 1),
        },
    })
`;

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
        pyodide.runPython(PYTHON_SOURCE);
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
