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
