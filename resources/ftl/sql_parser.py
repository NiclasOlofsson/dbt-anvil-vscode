# ==============================================================================
# IMPORT POLICY — READ BEFORE ADDING ANYTHING HERE
#
# This file runs inside Pyodide (WebAssembly). You MUST NOT import anything
# other than:
#   - Python standard library modules
#   - sqlglot (vendored in resources/ftl/vendor/sqlglot/)
#
# No pip packages. No third-party wheels. No dbt. No system libraries.
# Violating this will silently break column lineage for all users.
# ==============================================================================
import bisect as _bisect
import json as _json
import re as _re
import time as _time
import traceback as _traceback
from typing import Any as _Any

from sqlglot import Dialect as _Dialect
from sqlglot import exp as _exp
from sqlglot import parse_one as _parse_one
from sqlglot import serde as _serde
from sqlglot.errors import ErrorLevel as _EL
from sqlglot.errors import ParseError as _ParseError
from sqlglot.errors import SqlglotError as _SqlglotError
from sqlglot.lineage import lineage as _lineage
from sqlglot.lineage import to_node as _to_node
from sqlglot.optimizer.qualify import qualify as _qualify
from sqlglot.optimizer.scope import build_scope as _build_scope
from sqlglot.tokens import Tokenizer as _Tokenizer

_SQL_STUB = '__jinja__'


def _comment_positions(sql, tokens):
    """Post-process a token list to compute absolute positions for attached comments.

    sqlglot never emits standalone COMMENT tokens.  Instead it accumulates comment
    text in an internal list and attaches it to an adjacent Token object:
      - Comments before the first real token or between two tokens → attached to the
        *following* token (via _add() receiving comments=self._comments).
      - Comments that appear after the last token in the stream → attached to the
        *preceding* token (via the end-of-scan cleanup).

    IMPORTANT: sqlglot silently *strips* block comments (/* ... */) from the token
    stream without attaching them to any token.  To catch those, we scan every
    inter-token gap for comment markers regardless of whether sqlglot attached any
    comment text to that token.

    Returns a list (one entry per token) of lists of dicts: {start, end, text}.
    start is inclusive, end is exclusive (points to char *after* the comment).
    """
    n = len(tokens)
    result = []
    for idx, t in enumerate(tokens):
        if idx == n - 1:
            gap_start = t.end + 1
            gap_end = len(sql)
        else:
            gap_start = (tokens[idx - 1].end + 1) if idx > 0 else 0
            gap_end = t.start

        comments_with_pos = []
        # Build a lookup of comment texts attached by sqlglot so we can match them
        # to positions as we scan the gap.  For block comments sqlglot stripped,
        # t.comments will be empty and we still need to scan the gap.
        remaining_texts = list(t.comments) if t.comments else []
        pos = gap_start
        text_idx = 0
        while pos < gap_end:
            while pos < gap_end and sql[pos] in " \t\r\n":
                pos += 1
            if pos >= gap_end:
                break
            two = sql[pos : pos + 2]
            if two == "--":
                c_start = pos
                nl = sql.find("\n", pos)
                c_end = nl if nl != -1 else len(sql)
                comment_text = (
                    remaining_texts[text_idx]
                    if text_idx < len(remaining_texts)
                    else sql[c_start:c_end]
                )
                text_idx += 1
                comments_with_pos.append(
                    {"start": c_start, "end": c_end, "text": comment_text}
                )
                pos = c_end
            elif two == "/*":
                c_start = pos
                close = sql.find("*/", pos + 2)
                c_end = (close + 2) if close != -1 else len(sql)
                comment_text = (
                    remaining_texts[text_idx]
                    if text_idx < len(remaining_texts)
                    else sql[c_start:c_end]
                )
                text_idx += 1
                comments_with_pos.append(
                    {"start": c_start, "end": c_end, "text": comment_text}
                )
                pos = c_end
            elif sql[pos : pos + 2] == "{#":
                c_start = pos
                close = sql.find("#}", pos + 2)
                c_end = (close + 2) if close != -1 else len(sql)
                comment_text = (
                    remaining_texts[text_idx]
                    if text_idx < len(remaining_texts)
                    else sql[c_start:c_end]
                )
                text_idx += 1
                comments_with_pos.append(
                    {"start": c_start, "end": c_end, "text": comment_text}
                )
                pos = c_end
            else:
                break
        result.append(comments_with_pos)
    return result


def _tokenize(sql, dialect):
    try:
        if not dialect:
            raise ValueError(f"dialect is required, got {dialect!r}")
        d = None if dialect == "ansi" else dialect
        tok = _Dialect.get_or_raise(d).tokenizer_class() if d else _Tokenizer()
        tokens = list(tok.tokenize(sql))
        comment_pos = _comment_positions(sql, tokens)
        return [
            {
                "type": t.token_type.name,
                "start": t.start,
                "end": t.end,
                "line": t.line - 1,
                "col": t.col,
                "comments": comment_pos[i],
            }
            for i, t in enumerate(tokens)
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


def _collect_select_star_metas(ast: _exp.Expression) -> dict:
    """Before qualify() expands SELECT *, capture the _meta of each Star expression
    keyed by the parent SELECT node's source position (line, col).  This lets
    _annotate_synthesized_columns anchor the synthesised Column nodes to the '*' that
    produced them — the most semantically accurate source position."""
    result = {}
    for select in ast.find_all(_exp.Select):
        if select._meta is None:
            continue
        sel_key = (select._meta.get("line"), select._meta.get("col"))
        if sel_key == (None, None):
            continue
        for expr in select.expressions:
            if (
                isinstance(expr, _exp.Star)
                and expr._meta
                and expr._meta.get("line") is not None
            ):
                result[sel_key] = dict(expr._meta)
                break  # a SELECT list can only contain one Star
    return result


def _annotate_synthesized_columns(
    ast: _exp.Expression, select_star_metas: dict | None = None
) -> int:
    """Annotate Column nodes that have no source position (synthesised by qualify()'s
    SELECT * expansion).  Without a position, the TypeScript extractTokens() call skips
    them silently and the column_ref tokens are never emitted, which makes
    structure-unused-columns incorrectly flag every column in the source CTE as unused.

    Anchor priority:
      1. The '*' position captured before qualify() via select_star_metas.
      2. The FROM clause's Table identifier (fallback when star meta is unavailable).

    Returns the number of Identifier nodes that were annotated.
    """
    annotated = 0
    for select in ast.find_all(_exp.Select):
        # Only process SELECTs that originated as a pure SELECT * (i.e. all columns are
        # synthesised by qualify()'s star expansion and none have a source position).
        # If any Column in the SELECT list already has a _meta position, this was a
        # mixed or explicit SELECT — skip it to avoid stamping duplicate positions that
        # would collide with existing tokens and break resolveAtPosition lookups.
        has_positioned_column = False
        for expr in select.expressions:
            col = (
                expr
                if isinstance(expr, _exp.Column)
                else (
                    expr.this
                    if isinstance(expr, _exp.Alias)
                    and isinstance(expr.this, _exp.Column)
                    else None
                )
            )
            if col is None:
                continue
            ident = col.args.get("this")
            if (
                ident
                and isinstance(ident, _exp.Identifier)
                and ident._meta
                and ident._meta.get("line") is not None
            ):
                has_positioned_column = True
                break

        if has_positioned_column:
            continue

        # Anchor priority 1: the '*' position captured before qualify().
        anchor_meta: dict | None = None
        if select_star_metas and select._meta:
            sel_key = (select._meta.get("line"), select._meta.get("col"))
            anchor_meta = select_star_metas.get(sel_key)

        # Anchor priority 2: FROM clause's Table identifier.
        if anchor_meta is None:
            from_clause = select.args.get("from_")
            if from_clause:
                tbl = from_clause.find(_exp.Table)
                if tbl:
                    tbl_ident = tbl.args.get("this")
                    if (
                        tbl_ident
                        and isinstance(tbl_ident, _exp.Identifier)
                        and tbl_ident._meta
                    ):
                        anchor_meta = tbl_ident._meta

        if anchor_meta is None:
            continue

        # Stamp anchor position onto every Column.this Identifier that lacks one.
        for expr in select.expressions:
            col = (
                expr
                if isinstance(expr, _exp.Column)
                else (
                    expr.this
                    if isinstance(expr, _exp.Alias)
                    and isinstance(expr.this, _exp.Column)
                    else None
                )
            )
            if col is None:
                continue
            ident = col.args.get("this")
            if (
                ident
                and isinstance(ident, _exp.Identifier)
                and (ident._meta is None or ident._meta.get("line") is None)
            ):
                ident._meta = dict(anchor_meta)
                annotated += 1

    return annotated


def _parse(sql, dialect, schema_json):
    if not dialect:
        raise ValueError(f"dialect is required, got {dialect!r}")
    schema = _json.loads(schema_json) if schema_json else {}
    d = None if dialect == "ansi" else dialect
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
    # Before qualify() expands SELECT *, record which CTEs are wildcard selects and their star line.
    wildcard_ctes = []
    for cte in ast.find_all(_exp.CTE):
        body = cte.this
        if (isinstance(body, _exp.Select)
                and len(body.expressions) == 1
                and isinstance(body.expressions[0], _exp.Star)):
            star = body.expressions[0]
            m = getattr(star, 'meta', None) or {}
            line_1 = m.get('line', 1)
            col_1 = m.get("col")
            entry = {"name": cte.alias, "line": line_1 - 1}
            if col_1 is not None:
                entry["col"] = col_1 - 1
            wildcard_ctes.append(entry)
    # Build a schema supplement from CTE output columns so that qualify()'s
    # expand_stars() can expand SELECT * even when the external schema is absent
    # or when infer_schema can't determine a CTE's columns (e.g. GROUP BY ALL).
    cte_schema_supplement = {}
    for cte in ast.find_all(_exp.CTE):
        cte_name = cte.alias
        body = cte.this
        if not isinstance(body, _exp.Select):
            continue
        cte_cols: dict = {}
        has_star = False
        for expr in body.expressions:
            if isinstance(expr, _exp.Star):
                has_star = True
                break
            elif isinstance(expr, _exp.Alias):
                cte_cols[expr.alias] = "TEXT"
            elif isinstance(expr, _exp.Column):
                col_name = expr.name
                if col_name:
                    cte_cols[col_name] = "TEXT"
        if cte_cols and not has_star:
            cte_schema_supplement[cte_name] = cte_cols
    merged_schema = {**cte_schema_supplement, **(schema or {})} or None
    # Capture Star positions before qualify() replaces them with explicit Column nodes.
    select_star_metas = _collect_select_star_metas(ast)
    try:
        ast = _qualify(
            ast,
            dialect=d,
            schema=merged_schema,
            infer_schema=True,
            qualify_columns=True,
            validate_qualify_columns=False,
        )
    except Exception as _qe:
        warnings.append(
            {
                "message": f"qualify() failed: {type(_qe).__name__}: {_qe}",
                "rule": "qualify",
            }
        )
    # After qualify(), synthesised Column nodes (from SELECT * expansion) have no _meta
    # (no source position). Annotate them with the '*' position (or FROM table as fallback)
    # so extractTokens() in TypeScript can emit column_ref tokens for them.
    _annotate_synthesized_columns(ast, select_star_metas)
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
        'wildcardCtes': wildcard_ctes,
        'timing': {
            'tokenizeMs': round((t_tok - t0) * 1000, 1),
            'parseMs': round((t1 - t_tok) * 1000, 1),
            'qualifyMs': round((t2 - t1) * 1000, 1),
            'scopeMs': round((t3 - t2) * 1000, 1),
            'totalMs': round((t3 - t0) * 1000, 1),
        },
    })


# ---------------------------------------------------------------------------
# Column lineage
# ---------------------------------------------------------------------------

def _is_all_static_branch(branch: _Any) -> bool:
    """Return True if all SELECT expressions in a branch are literals or NULLs."""
    select = (
        branch
        if isinstance(branch, _exp.Select)
        else branch.find(_exp.Select)
        if hasattr(branch, 'find')
        else None
    )
    if not select:
        return False
    return all(isinstance(e, (_exp.Literal, _exp.Null)) for e in select.expressions)


def _clean_static_union_branches(ast: _Any) -> _Any:
    """Replace static UNION branches (all literals/NULLs) with the dynamic branch."""
    for union in list(ast.find_all(_exp.Union)):
        left = union.left
        right = union.right
        if _is_all_static_branch(left) and not _is_all_static_branch(right):
            union.replace(right)
        elif _is_all_static_branch(right) and not _is_all_static_branch(left):
            union.replace(left)
    return ast


def _collect_union_selects(expr: _Any) -> list[_Any]:
    """Recursively collect all SELECT leaf nodes from a UNION tree."""
    if isinstance(expr, _exp.Union):
        return _collect_union_selects(expr.this) + _collect_union_selects(
            expr.args.get('expression') or expr.right
        )
    if isinstance(expr, _exp.Select):
        return [expr]
    return []


def _get_source_name(node: _Any) -> str | None:
    if node is None:
        return None
    alias = getattr(node, 'alias', None)
    if alias:
        return str(alias).lower()
    name = getattr(node, 'name', None)
    if name:
        return str(name).lower()
    return None


def _trace_col_in_select(
    sel: _Any,
    col: str,
    ctes: dict[str, _Any],
    visited: set[str],
    queue: list[tuple[str, str]],
    dependencies: list[dict[str, _Any]],
    via_ctes: list[str],
) -> None:
    exprs = sel.expressions
    from_clause = sel.args.get('from_')
    from_name = _get_source_name(from_clause.this) if from_clause else None

    if any(
        isinstance(e, (_exp.Star, _exp.Column)) and getattr(e, 'name', None) == '*'
        or isinstance(e, _exp.Star)
        for e in exprs
    ):
        if from_name:
            if from_name in ctes and from_name not in visited:
                if from_name not in via_ctes:
                    via_ctes.append(from_name)
                queue.append((from_name, col))
            elif from_name not in ctes:
                dependencies.append({'column': col, 'table': from_name})
        return

    for expr in exprs:
        if isinstance(expr, _exp.Alias) and expr.alias.lower() == col:
            inner: _Any = expr.this
        elif isinstance(expr, _exp.Column) and expr.name.lower() == col:
            inner = expr
        else:
            continue

        col_refs = (
            [inner]
            if isinstance(inner, _exp.Column)
            else list(inner.find_all(_exp.Column))
        )
        for col_ref in col_refs:
            src_table = (str(col_ref.table) if col_ref.table else '').lower()
            src_col = col_ref.name.lower()
            if not src_table and from_name:
                src_table = from_name
            if src_table and src_table in ctes and src_table not in visited:
                if src_table not in via_ctes:
                    via_ctes.append(src_table)
                queue.append((src_table, src_col))
            elif src_table:
                dependencies.append({'column': src_col, 'table': src_table})
        break


def _trace_column_simple(
    compiled_sql: str,
    column_name: str,
    dialect: str,
) -> dict[str, _Any]:
    """Simple CTE-walking fallback for column lineage (no sqlglot.lineage())."""
    try:
        ast = _parse_one(compiled_sql, dialect=dialect or None)

        def _extract_ctes(node: _Any) -> dict[str, _Any]:
            leftmost = node
            while isinstance(leftmost, _exp.Union):
                leftmost = leftmost.this
            result: dict[str, _Any] = {}
            if isinstance(leftmost, _exp.Select):
                with_ = leftmost.args.get('with_')
                if with_:
                    for cte in with_.expressions:
                        result[cte.alias.lower()] = cte.this
            return result

        if isinstance(ast, _exp.Union):
            ctes = _extract_ctes(ast)
            branches = _collect_union_selects(ast)
            dependencies: list[dict[str, _Any]] = []
            via_ctes: list[str] = []
            visited: set[str] = set()
            for branch_sel in branches:
                from_clause = branch_sel.args.get('from_')
                if not from_clause:
                    continue
                from_name = _get_source_name(from_clause.this)
                if not from_name:
                    continue
                branch_queue: list[tuple[str, str]] = [(from_name, column_name.lower())]
                while branch_queue:
                    name, col = branch_queue.pop(0)
                    if name not in ctes:
                        dep = {'column': col, 'table': name}
                        if dep not in dependencies:
                            dependencies.append(dep)
                        continue
                    if name in visited:
                        continue
                    visited.add(name)
                    cte_body = ctes[name]
                    sub_selects = (
                        _collect_union_selects(cte_body)
                        if not isinstance(cte_body, _exp.Select)
                        else [cte_body]
                    )
                    for sub_sel in sub_selects:
                        _trace_col_in_select(sub_sel, col, ctes, visited, branch_queue, dependencies, via_ctes)
            return {'dependencies': dependencies, 'via_ctes': list(dict.fromkeys(via_ctes)), 'transformations': []}

        if not isinstance(ast, _exp.Select):
            return {'dependencies': [], 'via_ctes': [], 'transformations': []}

        ctes = _extract_ctes(ast)
        outer_from = ast.args.get('from_')
        if not outer_from:
            return {'dependencies': [], 'via_ctes': [], 'transformations': []}
        root_name = _get_source_name(outer_from.this)
        if not root_name:
            return {'dependencies': [], 'via_ctes': [], 'transformations': []}

        dependencies = []
        via_ctes = []
        visited = set()
        queue: list[tuple[str, str]] = [(root_name, column_name.lower())]
        while queue:
            name, col = queue.pop(0)
            if name not in ctes:
                dependencies.append({'column': col, 'table': name})
                continue
            if name in visited:
                continue
            visited.add(name)
            cte_body = ctes[name]
            selects = (
                _collect_union_selects(cte_body)
                if not isinstance(cte_body, _exp.Select)
                else [cte_body]
            )
            for sel in selects:
                _trace_col_in_select(sel, col, ctes, visited, queue, dependencies, via_ctes)

        return {'dependencies': dependencies, 'via_ctes': list(dict.fromkeys(via_ctes)), 'transformations': []}
    except Exception:
        return {'dependencies': [], 'via_ctes': [], 'transformations': []}


def _wrap_final_select_from_ast(ast: _Any, column_name: str, dialect: str | None) -> _Any:
    """Wrap a pre-parsed AST's final SELECT in a CTE for lineage tracing."""
    ast = ast.copy()
    if isinstance(ast, _exp.Union):
        leftmost: _Any = ast
        while isinstance(leftmost, _exp.Union):
            leftmost = leftmost.this
        with_clause = None
        if isinstance(leftmost, _exp.Select):
            with_clause = leftmost.args.get('with_')
            if with_clause:
                leftmost.set('with_', None)
        union_cte = _exp.CTE(
            this=ast,
            alias=_exp.TableAlias(this=_exp.Identifier(this='__lineage_final__')),
        )
        if with_clause:
            with_clause.expressions.append(union_cte)
        else:
            with_clause = _exp.With(expressions=[union_cte])
        outer = _exp.Select()
        outer.set('with_', with_clause)
        outer.set('expressions', [_exp.Column(this=_exp.Identifier(this=column_name))])
        outer.set('from_', _exp.From(this=_exp.Table(this=_exp.Identifier(this='__lineage_final__'))))
        return outer

    root_select = ast if isinstance(ast, _exp.Select) else ast.find(_exp.Select)
    if not root_select:
        return ast

    with_clause = root_select.args.get('with_')
    wrapper_select = root_select.copy()
    wrapper_select.set('with_', None)
    wrapper_cte = _exp.CTE(
        this=wrapper_select,
        alias=_exp.TableAlias(this=_exp.Identifier(this='__lineage_final__')),
    )
    for key in list(root_select.args.keys()):
        root_select.set(key, None)
    if with_clause:
        with_clause.expressions.append(wrapper_cte)
    else:
        with_clause = _exp.With(expressions=[wrapper_cte])
    root_select.set('with_', with_clause)
    root_select.set('expressions', [_exp.Column(this=_exp.Identifier(this=column_name))])
    root_select.set('from_', _exp.From(this=_exp.Table(this=_exp.Identifier(this='__lineage_final__'))))
    return ast


def _wrap_final_select(compiled_sql: str, column_name: str, dialect: str) -> _Any:
    """Wrap the final SELECT in a CTE so lineage() can trace through SELECT *."""
    ast = _parse_one(compiled_sql, dialect=dialect or None)

    if isinstance(ast, _exp.Union):
        leftmost: _Any = ast
        while isinstance(leftmost, _exp.Union):
            leftmost = leftmost.this
        with_clause = None
        if isinstance(leftmost, _exp.Select):
            with_clause = leftmost.args.get('with_')
            if with_clause:
                leftmost.set('with_', None)
        union_cte = _exp.CTE(
            this=ast,
            alias=_exp.TableAlias(this=_exp.Identifier(this='__lineage_final__')),
        )
        if with_clause:
            with_clause.expressions.append(union_cte)
        else:
            with_clause = _exp.With(expressions=[union_cte])
        outer = _exp.Select()
        outer.set('with_', with_clause)
        outer.set('expressions', [_exp.Column(this=_exp.Identifier(this=column_name))])
        outer.set('from_', _exp.From(this=_exp.Table(this=_exp.Identifier(this='__lineage_final__'))))
        return outer

    root_select = ast if isinstance(ast, _exp.Select) else ast.find(_exp.Select)
    if not root_select:
        return ast

    with_clause = root_select.args.get('with_')
    wrapper_select = root_select.copy()
    wrapper_select.set('with_', None)
    wrapper_cte = _exp.CTE(
        this=wrapper_select,
        alias=_exp.TableAlias(this=_exp.Identifier(this='__lineage_final__')),
    )
    for key in list(root_select.args.keys()):
        root_select.set(key, None)
    if with_clause:
        with_clause.expressions.append(wrapper_cte)
    else:
        with_clause = _exp.With(expressions=[wrapper_cte])
    root_select.set('with_', with_clause)
    root_select.set('expressions', [_exp.Column(this=_exp.Identifier(this=column_name))])
    root_select.set('from_', _exp.From(this=_exp.Table(this=_exp.Identifier(this='__lineage_final__'))))
    return ast


def _extract_transformations(lineage_node: _Any) -> list[dict[str, _Any]]:
    """Extract namespaced transformation IDs, types, and source references."""
    transform_map: dict[str, dict[str, _Any]] = {}
    cte_to_id: dict[str, str] = {}
    nodes_with_data: list[tuple[str, _Any, str]] = []
    outer_query_sources: set[str] = set()
    union_branches: dict[str, list[dict[str, _Any]]] = {}

    for node in lineage_node.walk():
        if not hasattr(node, 'name') or not node.name:
            continue

        if '.' not in node.name:
            if hasattr(node, 'reference_node_name') and node.reference_node_name:
                ref_cte = node.reference_node_name
                branch_info: dict[str, _Any] = {}
                if hasattr(node, 'expression') and node.expression:
                    expr_str = str(node.expression)
                    branch_info['expression'] = expr_str if len(expr_str) <= 200 else expr_str[:197] + '...'
                    if ' AS ' in expr_str:
                        branch_info['column'] = expr_str.split(' AS ')[-1].strip()
                    branch_info['_full_expr'] = expr_str
                union_branches.setdefault(ref_cte, []).append(branch_info)
            continue

        parts = node.name.split('.', 1)
        cte_or_table = parts[0]
        col_name = parts[1] if len(parts) > 1 else node.name

        if cte_or_table == '__lineage_final__':
            if hasattr(node, 'expression') and node.expression:
                expr_str = str(node.expression)
                for ref_name in _re.findall(r'\b([A-Za-z_]\w*)\.' , expr_str):
                    if not ref_name.isdigit():
                        outer_query_sources.add(ref_name)
            continue

        source_type = type(node.source).__name__ if hasattr(node, 'source') else None
        actual = cte_or_table
        if hasattr(node, 'source') and hasattr(node.source, 'this') and node.source.this:
            actual = str(node.source.this)

        transform_id = f'table:{actual}' if source_type == 'Table' else f'cte:{actual}'
        transform_type = 'table' if source_type == 'Table' else 'cte'
        cte_to_id[actual] = transform_id

        if hasattr(node, 'expression') and node.expression:
            nodes_with_data.append((transform_id, node, str(node.expression)))

        if transform_id in transform_map:
            continue

        transform: dict[str, _Any] = {'id': transform_id, 'type': transform_type, 'column': col_name}
        if hasattr(node, 'expression') and node.expression:
            expr_sql = str(node.expression)
            if expr_sql and expr_sql.strip() != col_name:
                transform['expression'] = expr_sql if len(expr_sql) <= 200 else expr_sql[:197] + '...'
        transform_map[transform_id] = transform

    for ref_cte in union_branches:
        cte_to_id[ref_cte] = f'cte:{ref_cte}'

    for ref_cte, branches in union_branches.items():
        if not branches:
            continue
        transform_id = f'cte:{ref_cte}'
        column = branches[0].get('column', '')
        formatted: list[dict[str, _Any]] = []
        for bi in branches:
            entry: dict[str, _Any] = {}
            if 'expression' in bi:
                entry['expression'] = bi['expression']
            source_ids: set[str] = set()
            full_expr = bi.get('_full_expr', '')
            if full_expr:
                for cte_name, cte_id in cte_to_id.items():
                    if f'{cte_name}.' in full_expr:
                        source_ids.add(cte_id)
            entry['sources'] = sorted(source_ids)
            formatted.append(entry)
        transform_map[transform_id] = {'id': transform_id, 'type': 'union', 'column': column, 'branches': formatted}

    sources_map: dict[str, set[str]] = {}
    for transform_id, node, expr_str in nodes_with_data:
        src_ids: set[str] = set()
        if (
            expr_str.strip() == '*'
            and hasattr(node, 'source')
            and hasattr(node.source, 'find')
        ):
            table_node = node.source.find(_exp.Table)
            if table_node and hasattr(table_node, 'this'):
                src_ids.add(f'table:{table_node.this}')
        for cte_name, cte_id in cte_to_id.items():
            if cte_id != transform_id and f'{cte_name}.' in expr_str:
                src_ids.add(cte_id)
        sources_map.setdefault(transform_id, set()).update(src_ids)

    transformations: list[dict[str, _Any]] = []
    for trans in transform_map.values():
        if trans.get('type') != 'union':
            trans['sources'] = sorted(sources_map.get(trans['id'], set()))
        transformations.append(trans)

    if outer_query_sources:
        column_for_query = next((t.get('column', '') for t in transformations), '')
        resolved: list[str] = []
        for ref_name in outer_query_sources:
            resolved.append(cte_to_id[ref_name] if ref_name in cte_to_id else f'table:{ref_name}')
        transformations.insert(0, {
            'id': 'query',
            'type': 'outer_query',
            'column': column_for_query,
            'sources': sorted(resolved),
        })

    return transformations


def _trace_lineage(compiled_sql: str, column_name: str, schema_json: str, dialect: str) -> str:
    """Entry point: trace column lineage and return JSON result."""
    try:
        return _trace_lineage_inner(compiled_sql, column_name, schema_json, dialect)
    except Exception as exc:
        return _json.dumps({'success': False, 'error': f'{type(exc).__name__}: {exc}', 'traceback': _traceback.format_exc()})


def _trace_lineage_inner(compiled_sql: str, column_name: str, schema_json: str, dialect: str) -> str:
    """Inner implementation — called by _trace_lineage which wraps with top-level error handling."""
    if not dialect:
        raise ValueError(f"dialect is required, got {dialect!r}")
    schema: dict[str, _Any] = _json.loads(schema_json) if schema_json else {}
    d = None if dialect == "ansi" else dialect

    wrapped_ast = _wrap_final_select(compiled_sql, column_name, dialect)

    result = None
    for attempt in range(3):
        try:
            result = _lineage(column=column_name, sql=wrapped_ast, schema=schema, dialect=d)
            break
        except (IndexError, _SqlglotError):
            if attempt < 2:
                wrapped_ast = _clean_static_union_branches(wrapped_ast)

    if result is None:
        return _json.dumps({'success': True, **_trace_column_simple(compiled_sql, column_name, dialect)})

    dependencies: list[dict[str, _Any]] = []
    via_ctes: list[str] = []

    for node in result.walk():
        if not hasattr(node, 'name') or not node.name:
            continue
        name = node.name
        if '.' in name:
            parts = name.split('.', 1)
            table_or_cte = parts[0]
            col = parts[1]
        else:
            table_or_cte = None
            col = name

        is_table = False
        if hasattr(node, 'source'):
            source = node.source
            is_table = hasattr(source, 'catalog') or getattr(source, 'db', None) is not None

        if is_table and table_or_cte:
            actual_table = getattr(node.source, 'name', table_or_cte) or table_or_cte
            dep: dict[str, _Any] = {'column': col, 'table': actual_table}
            src_db = getattr(node.source, 'db', None)
            if src_db:
                dep['schema'] = str(src_db).strip('"')
            src_catalog = getattr(node.source, 'catalog', None)
            if src_catalog:
                dep['database'] = str(src_catalog).strip('"')
            dependencies.append(dep)
        elif table_or_cte and table_or_cte != '__lineage_final__':
            if table_or_cte not in via_ctes:
                via_ctes.append(table_or_cte)

    transformations = _extract_transformations(result)
    return _json.dumps({'success': True, 'dependencies': dependencies, 'via_ctes': via_ctes, 'transformations': transformations})


# ---------------------------------------------------------------------------
# Column lineage v2 — parse once, strip statics, then trace
# ---------------------------------------------------------------------------

def _parse_to_ast(sql: str, schema: dict, dialect: str | None) -> tuple[_Any, _Any]:
    """Parse, qualify and build scope. Returns (ast, scope). Scope may be None on failure."""
    ast = _parse_one(sql, dialect=dialect, error_level=None)
    try:
        ast = _qualify(
            ast,
            dialect=dialect,
            schema=schema,
            infer_schema=True,
            qualify_columns=True,
            validate_qualify_columns=False,
        )
    except Exception:
        pass
    scope = None
    try:
        scope = _build_scope(ast)
    except Exception:
        pass
    return ast, scope


def _is_static_expr(expr: _Any) -> bool:
    """Return True if expr is a constant — literal, NULL, boolean, or unary minus on a literal."""
    if isinstance(expr, (_exp.Literal, _exp.Null, _exp.Boolean)):
        return True
    if isinstance(expr, _exp.Neg) and isinstance(expr.this, _exp.Literal):
        return True
    return False


def _is_all_static_select(select: _Any) -> bool:
    """Return True if every expression in the SELECT list is a constant."""
    if not isinstance(select, _exp.Select):
        return False
    exprs = select.expressions
    return bool(exprs) and all(_is_static_expr(e.this if isinstance(e, _exp.Alias) else e) for e in exprs)


def _deep_strip_static_unions(ast: _Any) -> _Any:
    """Walk the full AST and replace every UNION where one side is all-static with the dynamic side."""
    changed = True
    while changed:
        changed = False
        for union in list(ast.find_all(_exp.Union)):
            left_sel = union.left.find(_exp.Select) if hasattr(union.left, 'find') else None
            right_sel = union.right.find(_exp.Select) if hasattr(union.right, 'find') else None
            left_static = _is_all_static_select(left_sel) if left_sel else _is_all_static_select(union.left)
            right_static = _is_all_static_select(right_sel) if right_sel else _is_all_static_select(union.right)
            if left_static and not right_static:
                replacement = union.right
                if union is ast:
                    ast = replacement
                else:
                    union.replace(replacement)
                changed = True
            elif right_static and not left_static:
                replacement = union.left
                if union is ast:
                    ast = replacement
                else:
                    union.replace(replacement)
                changed = True
    return ast


def _dump_lineage_node(node: _Any) -> dict[str, _Any]:
    """Serialize a sqlglot lineage Node to a plain dict (recursive)."""
    source = node.source
    if isinstance(source, _exp.Table):
        source_out: _Any = {
            'type': 'Table',
            'name': source.name or None,
            'db': source.db or None,
            'catalog': source.catalog or None,
        }
    elif source is not None:
        source_out = {'type': type(source).__name__}
    else:
        source_out = None
    return {
        'name': node.name,
        'expression': str(node.expression) if node.expression else None,
        'source': source_out,
        'referenceNodeName': getattr(node, 'reference_node_name', None),
        'downstream': [_dump_lineage_node(c) for c in node.downstream],
    }


def _has_placeholder_leaf(node: dict) -> bool:
    """Return True if any leaf of the lineage tree is a Placeholder (unresolved column)."""
    if not node.get("downstream"):
        return (node.get("source") or {}).get("type") == "Placeholder"
    return any(_has_placeholder_leaf(c) for c in node["downstream"])


def _trace_lineage_v2(sql: str, column_name: str, schema_json: str, dialect: str) -> str:
    """New lineage entry point: parse once, strip static branches, return raw lineage tree."""
    try:
        if not dialect:
            raise ValueError(f"dialect is required, got {dialect!r}")
        schema: dict[str, _Any] = _json.loads(schema_json) if schema_json else {}
        d = None if dialect == "ansi" else dialect

        def _run(s: dict) -> dict | None:
            a = _parse_one(sql, dialect=d, error_level=None)
            a = _deep_strip_static_unions(a)
            a = _wrap_final_select_from_ast(a, column_name, d)
            try:
                a = _qualify(
                    a,
                    dialect=d,
                    schema=s,
                    infer_schema=True,
                    qualify_columns=True,
                    validate_qualify_columns=False,
                )
            except Exception:
                pass
            scope = _build_scope(a)
            if scope is None:
                return None
            result = _to_node(column_name, scope=scope, dialect=d)
            return _dump_lineage_node(result)

        tree = _run(schema)
        if tree is None:
            return _json.dumps({'success': False, 'error': 'Failed to build scope'})

        # A partial schema can confuse qualify() on UNION ALL queries: columns from
        # tables not fully represented in the schema become Placeholder leaves.
        # Retry with an empty schema so sqlglot infers column provenance from the SQL.
        if schema and _has_placeholder_leaf(tree):
            fallback = _run({})
            if fallback is not None and not _has_placeholder_leaf(fallback):
                tree = fallback

        return _json.dumps({"success": True, "tree": tree})

    except Exception as exc:
        return _json.dumps({'success': False, 'error': f'{type(exc).__name__}: {exc}', 'traceback': _traceback.format_exc()})


# ==============================================================================
# DECOMPOSE QUERY
# Decompose compiled SQL into debug frames (CTEs + _main_) and per-frame clauses.
# ==============================================================================


def _decompose_query(compiled_sql: str, dialect: str) -> str:
    """Decompose compiled SQL into debug frames (CTEs + _main_) and per-frame clauses.

    Returns JSON: {"success": true, "frames": [...], "clauses": {...}, "refs": {...}}
    """
    from sqlglot.tokens import TokenType as _TT  # noqa: PLC0415

    if not dialect:
        raise ValueError(f"dialect is required, got {dialect!r}")
    sqlglot_dialect: str | None = None if dialect == "ansi" else dialect

    if not compiled_sql:
        return _json.dumps({"success": False, "error": "compiled_sql is required"})

    try:
        ast = _parse_one(compiled_sql, dialect=sqlglot_dialect, error_level=None)
    except Exception as exc:
        return _json.dumps({"success": False, "error": f"Parse error: {exc}"})

    # Build line_starts for offset→line conversion (0-based lines).
    line_starts: list[int] = [0]
    for i, ch in enumerate(compiled_sql):
        if ch == "\n":
            line_starts.append(i + 1)

    def offset_to_line(offset: int) -> int:
        return max(0, _bisect.bisect_right(line_starts, offset) - 1)

    def node_line(node: _Any) -> int:
        """Best-effort 0-based line for an AST node via its leftmost Identifier."""
        for ident in node.find_all(_exp.Identifier):
            raw_line = ident.meta.get("line")
            if raw_line is not None:
                return max(0, raw_line - 1)
        return 0

    try:
        _tok = (
            _Dialect.get_or_raise(sqlglot_dialect).tokenizer_class()
            if sqlglot_dialect
            else _Tokenizer()
        )
        _token_list = _tok.tokenize(compiled_sql)
    except Exception:
        _token_list = []

    _token_positions: list[tuple[_TT, int, int]] = [
        (t.token_type, t.line - 1, t.start) for t in _token_list
    ]

    _CLAUSE_TOKEN_TYPES: dict[str, _TT] = {
        "select": _TT.SELECT,
        "from_": _TT.FROM,
        "where": _TT.WHERE,
        "group": _TT.GROUP_BY,
        "having": _TT.HAVING,
        "order": _TT.ORDER_BY,
        "sort": _TT.SORT_BY,
        "cluster": _TT.CLUSTER_BY,
        "distribute": _TT.DISTRIBUTE_BY,
        "offset": _TT.OFFSET,
    }

    def token_clause_line(clause_key: str, after_offset: int) -> int | None:
        token_type = _CLAUSE_TOKEN_TYPES.get(clause_key)
        if token_type is None:
            return None
        for tt, tline, tstart in _token_positions:
            if tt == token_type and tstart >= after_offset:
                return tline
        return None

    def node_end_line(node: _Any) -> int:
        first_start: int | None = None
        for child in node.walk():
            s = child.meta.get("start")
            if s is not None and (first_start is None or s < first_start):
                first_start = s
        if first_start is None:
            return 0
        open_idx = compiled_sql.find("(", first_start)
        if open_idx < 0:
            return offset_to_line(first_start)
        depth = 0
        for idx in range(open_idx, len(compiled_sql)):
            if compiled_sql[idx] == "(":
                depth += 1
            elif compiled_sql[idx] == ")":
                depth -= 1
                if depth == 0:
                    return offset_to_line(idx)
        return offset_to_line(open_idx)

    def _select_start_offset(select_node: _Any) -> int:
        line = node_line(select_node)
        return line_starts[line] if line < len(line_starts) else 0

    def find_clause_line(select_node: _Any, clause_key: str) -> int:
        # The SELECT keyword sits BEFORE the first projected identifier, so
        # forward-searching from node_line (which uses the first identifier)
        # would skip past it. For "select" we instead pick the SELECT token
        # whose offset is ≤ the first identifier's offset and largest — the
        # nearest preceding SELECT keyword. All other clause keys (FROM,
        # WHERE, GROUP, …) come AFTER projections, so the forward search is
        # correct for them.
        if clause_key == "select":
            first_ident_start: int | None = None
            for ident in select_node.find_all(_exp.Identifier):
                s = ident.meta.get("start")
                if s is not None:
                    first_ident_start = s
                    break
            if first_ident_start is not None:
                best_line: int | None = None
                best_start = -1
                for tt, tline, tstart in _token_positions:
                    if tt == _TT.SELECT and tstart <= first_ident_start and tstart > best_start:
                        best_start = tstart
                        best_line = tline
                if best_line is not None:
                    return best_line
            return node_line(select_node)

        after = _select_start_offset(select_node)
        return token_clause_line(clause_key, after) or node_line(select_node)

    def extract_clauses(
        name: str, select_node: _Any, _cte_prefix: str
    ) -> list[dict[str, _Any]]:
        # UNION-aware: if the node is a Union, flatten its legs and concatenate
        # their clauses in source order. Each leg contributes its own FROM/
        # JOIN/WHERE/SELECT clauses with their own source line numbers, so the
        # concatenated list is already sorted by line. Breakpoints and stepping
        # treat the UNION as a single linear clause sequence within the frame.
        if isinstance(select_node, _exp.Union):
            legs = _collect_union_selects(select_node)
            combined: list[dict[str, _Any]] = []
            for leg_index, leg in enumerate(legs, start=1):
                leg_clauses = extract_clauses(name, leg, _cte_prefix)
                # Tag each clause with its 1-based UNION leg position so the
                # debug adapter can disambiguate identical-stage clauses
                # ("select", "where") that come from different legs.
                for c in leg_clauses:
                    c["union_leg"] = leg_index
                    c["union_total"] = len(legs)
                combined.extend(leg_clauses)
            for idx, clause in enumerate(combined):
                clause["order"] = idx
            return combined

        clauses: list[dict[str, _Any]] = []

        with_node = ast.args.get("with_")
        prefix_ctes: list[_Any] = []
        if with_node:
            for cte_node in with_node.expressions:
                cte_alias = cte_node.alias or ""
                if cte_alias == name and name != "_main_":
                    break
                prefix_ctes.append(cte_node)

        def with_prefix(sql: str) -> str:
            if not prefix_ctes:
                return sql
            cte_parts = [c.sql(dialect=sqlglot_dialect) for c in prefix_ctes]
            return f"WITH {', '.join(cte_parts)}\n{sql}"

        from_node = select_node.args.get("from_")
        if from_node:
            from_sql = f"SELECT * {from_node.sql(dialect=sqlglot_dialect)}"
            clauses.append(
                {
                    "stage": "from",
                    "sql": with_prefix(from_sql),
                    "line": find_clause_line(select_node, "from_"),
                }
            )

        joins = select_node.args.get("joins") or []
        if from_node and joins:
            from_part = from_node.sql(dialect=sqlglot_dialect)
            for i, join in enumerate(joins):
                join_parts = " ".join(
                    j.sql(dialect=sqlglot_dialect) for j in joins[: i + 1]
                )
                join_sql = f"SELECT * {from_part} {join_parts}"
                clauses.append(
                    {
                        "stage": "join",
                        "sql": with_prefix(join_sql),
                        "line": node_line(join),
                    }
                )

        where_node = select_node.args.get("where")
        if where_node and from_node:
            base = from_node.sql(dialect=sqlglot_dialect)
            join_parts = (
                " ".join(j.sql(dialect=sqlglot_dialect) for j in joins) if joins else ""
            )
            where_sql = f"SELECT * {base} {join_parts} {where_node.sql(dialect=sqlglot_dialect)}"
            clauses.append(
                {
                    "stage": "where",
                    "sql": with_prefix(where_sql.strip()),
                    "line": find_clause_line(select_node, "where"),
                }
            )

        group_node = select_node.args.get("group")
        if group_node and from_node:
            base = from_node.sql(dialect=sqlglot_dialect)
            join_parts = (
                " ".join(j.sql(dialect=sqlglot_dialect) for j in joins) if joins else ""
            )
            where_part = where_node.sql(dialect=sqlglot_dialect) if where_node else ""
            projections = ", ".join(
                e.sql(dialect=sqlglot_dialect) for e in select_node.expressions
            )
            group_sql = f"SELECT {projections} {base} {join_parts} {where_part} {group_node.sql(dialect=sqlglot_dialect)}"
            clauses.append(
                {
                    "stage": "group",
                    "sql": with_prefix(group_sql.strip()),
                    "line": find_clause_line(select_node, "group"),
                }
            )

        having_node = select_node.args.get("having")
        if having_node and group_node and from_node:
            base = from_node.sql(dialect=sqlglot_dialect)
            join_parts = (
                " ".join(j.sql(dialect=sqlglot_dialect) for j in joins) if joins else ""
            )
            where_part = where_node.sql(dialect=sqlglot_dialect) if where_node else ""
            projections = ", ".join(
                e.sql(dialect=sqlglot_dialect) for e in select_node.expressions
            )
            having_sql = f"SELECT {projections} {base} {join_parts} {where_part} {group_node.sql(dialect=sqlglot_dialect)} {having_node.sql(dialect=sqlglot_dialect)}"
            clauses.append(
                {
                    "stage": "having",
                    "sql": with_prefix(having_sql.strip()),
                    "line": find_clause_line(select_node, "having"),
                }
            )

        windows = select_node.args.get("windows")
        if windows:
            clauses.append(
                {
                    "stage": "window",
                    "sql": "",
                    "line": node_line(windows[0])
                    if isinstance(windows, list) and windows
                    else find_clause_line(select_node, "windows"),
                }
            )

        qualify_node = select_node.args.get("qualify")
        if qualify_node:
            clauses.append(
                {
                    "stage": "qualify",
                    "sql": "",
                    "line": find_clause_line(select_node, "qualify"),
                }
            )

        select_sql = select_node.sql(dialect=sqlglot_dialect)
        if select_sql.lstrip().upper().startswith("WITH"):
            final_select_sql = select_sql
        else:
            final_select_sql = with_prefix(select_sql)
        clauses.append(
            {
                "stage": "select",
                "sql": final_select_sql,
                "line": find_clause_line(select_node, "select"),
            }
        )

        order_node = select_node.args.get("order")
        if order_node and from_node:
            clauses.append(
                {
                    "stage": "order",
                    "sql": with_prefix(select_node.sql(dialect=sqlglot_dialect))
                    if not select_sql.lstrip().upper().startswith("WITH")
                    else select_sql,
                    "line": find_clause_line(select_node, "order"),
                }
            )

        limit_node = select_node.args.get("limit")
        if limit_node:
            clauses.append(
                {
                    "stage": "limit",
                    "sql": with_prefix(select_node.sql(dialect=sqlglot_dialect))
                    if not select_sql.lstrip().upper().startswith("WITH")
                    else select_sql,
                    "line": find_clause_line(select_node, "limit"),
                }
            )

        # ── OFFSET (standard SQL / Spark: skip first N rows, always follows LIMIT) ──
        offset_node = select_node.args.get("offset")
        if offset_node:
            clauses.append(
                {
                    "stage": "offset",
                    "sql": with_prefix(select_node.sql(dialect=sqlglot_dialect))
                    if not select_sql.lstrip().upper().startswith("WITH")
                    else select_sql,
                    "line": find_clause_line(select_node, "offset"),
                }
            )

        # ── SORT BY (Spark/Databricks: per-partition sort, alternative to ORDER BY) ──
        sort_node = select_node.args.get("sort")
        if sort_node and from_node:
            clauses.append(
                {
                    "stage": "sort",
                    "sql": with_prefix(select_node.sql(dialect=sqlglot_dialect))
                    if not select_sql.lstrip().upper().startswith("WITH")
                    else select_sql,
                    "line": find_clause_line(select_node, "sort"),
                }
            )

        # ── CLUSTER BY (Spark/Databricks: combined DISTRIBUTE BY + SORT BY) ──
        cluster_node = select_node.args.get("cluster")
        if cluster_node and from_node:
            clauses.append(
                {
                    "stage": "cluster",
                    "sql": with_prefix(select_node.sql(dialect=sqlglot_dialect))
                    if not select_sql.lstrip().upper().startswith("WITH")
                    else select_sql,
                    "line": find_clause_line(select_node, "cluster"),
                }
            )

        # ── DISTRIBUTE BY (Spark/Databricks: controls output file partitioning) ──
        distribute_node = select_node.args.get("distribute")
        if distribute_node and from_node:
            clauses.append(
                {
                    "stage": "distribute",
                    "sql": with_prefix(select_node.sql(dialect=sqlglot_dialect))
                    if not select_sql.lstrip().upper().startswith("WITH")
                    else select_sql,
                    "line": find_clause_line(select_node, "distribute"),
                }
            )

        for idx, clause in enumerate(clauses):
            clause["order"] = idx

        return clauses

    def extract_table_refs(select_node: _Any) -> list[str]:
        refs: list[str] = []
        for tbl in select_node.find_all(_exp.Table):
            name = tbl.name
            if name:
                refs.append(name)
        return refs

    def promote_subqueries(the_ast: _Any) -> None:
        the_with_node: _Any = the_ast.args.get("with_")

        existing_names: set[str] = set()
        if the_with_node:
            for _c in the_with_node.expressions:
                if _c.alias:
                    existing_names.add(_c.alias)

        counter: list[int] = [0]

        def make_name(preferred: str) -> str:
            if preferred and preferred not in existing_names:
                existing_names.add(preferred)
                return preferred
            counter[0] += 1
            name = f"__subq_{counter[0]}__"
            existing_names.add(name)
            return name

        def insert_before(new_cte: _Any, before_alias: str) -> None:
            nonlocal the_with_node
            if the_with_node is None:
                the_with_node = _exp.With(expressions=[new_cte])
                the_ast.set("with_", the_with_node)
            else:
                exprs = list(the_with_node.expressions)
                idx = next(
                    (i for i, c in enumerate(exprs) if (c.alias or "") == before_alias),
                    len(exprs),
                )
                exprs.insert(idx, new_cte)
                the_with_node.set("expressions", exprs)

        def promote_in_select(select_node: _Any, before_alias: str) -> None:
            from_node = select_node.args.get("from_")
            if from_node and isinstance(from_node.this, _exp.Subquery):
                _promote(from_node, from_node.this, before_alias)
            for join in list(select_node.args.get("joins") or []):
                if isinstance(join.this, _exp.Subquery):
                    _promote(join, join.this, before_alias)

        def _promote(parent: _Any, subq: _Any, before_alias: str) -> None:
            alias_str: str = subq.alias or ""
            cte_name = make_name(alias_str)

            inner_select = subq.find(_exp.Select)
            if not inner_select:
                return

            promote_in_select(inner_select, cte_name)

            inner_select = subq.find(_exp.Select)
            if not inner_select:
                return

            new_cte = _exp.CTE(
                this=inner_select.copy(),
                alias=_exp.TableAlias(this=_exp.Identifier(this=cte_name)),
            )

            new_table = _exp.Table(this=_exp.Identifier(this=cte_name))
            if alias_str and alias_str != cte_name:
                new_table.set(
                    "alias",
                    _exp.TableAlias(this=_exp.Identifier(this=alias_str)),
                )
            parent.set("this", new_table)

            insert_before(new_cte, before_alias)

        if the_with_node:
            original_ctes = list(the_with_node.expressions)
            for cte_node in original_ctes:
                cte_alias = cte_node.alias or ""
                inner = cte_node.find(_exp.Select)
                if inner:
                    promote_in_select(inner, cte_alias)

        if isinstance(the_ast, _exp.Select):
            main_sel: _Any = the_ast
        elif hasattr(the_ast, "this") and isinstance(the_ast.this, _exp.Select):
            main_sel = the_ast.this
        else:
            main_sel = the_ast.find(_exp.Select)
        if main_sel:
            promote_in_select(main_sel, "_main_")

    # Maps synthetic __union_N__ CTE name → (startLine, endLine) in the
    # compiled-SQL coordinate system. Populated by promote_unions and
    # consulted during frame enumeration so the synthetic CTE gets a precise
    # line range rather than node_end_line's paren-matching heuristic (UNION
    # legs aren't parenthesised in source).
    synthetic_frame_ranges: dict[str, tuple[int, int]] = {}

    def promote_unions(the_ast: _Any) -> None:
        """Promote each leg of a UNION into its own __union_N__ CTE.

        Runs after promote_subqueries. For any Union found at the top of a
        scope (main AST or a CTE body), each leg becomes a separate CTE so
        breakpoints inside a branch match the branch's frame range and
        stepping produces accurate per-branch clauses.

        The original Union structure is preserved in the main/CTE body. We
        only ADD new CTEs referencing copies of the legs; we do not rewrite
        the Union to stubs. That keeps source positions intact (the original
        leg nodes retain their meta) and leaves the existing UNION SQL
        executable as-is.
        """
        the_with_node: _Any = the_ast.args.get("with_")

        existing_names: set[str] = set()
        if the_with_node:
            for _c in the_with_node.expressions:
                if _c.alias:
                    existing_names.add(_c.alias)

        counter: list[int] = [0]

        def make_union_name() -> str:
            while True:
                counter[0] += 1
                name = f"__union_{counter[0]}__"
                if name not in existing_names:
                    existing_names.add(name)
                    return name

        def insert_before(new_cte: _Any, before_alias: str) -> None:
            nonlocal the_with_node
            if the_with_node is None:
                the_with_node = _exp.With(expressions=[new_cte])
                the_ast.set("with_", the_with_node)
            else:
                exprs = list(the_with_node.expressions)
                idx = next(
                    (i for i, c in enumerate(exprs) if (c.alias or "") == before_alias),
                    len(exprs),
                )
                exprs.insert(idx, new_cte)
                the_with_node.set("expressions", exprs)

        def leg_last_line(leg: _Any) -> int:
            """Line of the last positioned descendant of leg. Bounds the
            branch to the tightest range around its real source content, so
            the UNION keyword line (which usually sits between legs on its
            own line) falls outside any frame range.
            """
            last_start: int | None = None
            for node in leg.walk():
                s = node.meta.get("start")
                if s is not None and (last_start is None or s > last_start):
                    last_start = s
            if last_start is None:
                return node_line(leg)
            return offset_to_line(last_start)

        def promote_legs(union_node: _Any, before_alias: str, enclosing_end: int) -> None:
            legs = _collect_union_selects(union_node)
            if len(legs) < 2:
                return
            for i, leg in enumerate(legs):
                cte_name = make_union_name()
                start_line = node_line(leg)
                if i + 1 < len(legs):
                    # endLine = last positioned token in this leg. Lines
                    # after the last token (including a bare UNION ALL
                    # keyword line between legs) fall outside every frame,
                    # so setBreakpoints returns verified:false for them.
                    end_line = max(start_line, leg_last_line(leg))
                else:
                    end_line = max(start_line, enclosing_end)
                synthetic_frame_ranges[cte_name] = (start_line, end_line)
                new_cte = _exp.CTE(
                    this=leg.copy(),
                    alias=_exp.TableAlias(this=_exp.Identifier(this=cte_name)),
                )
                insert_before(new_cte, before_alias)

        # Top-level UNION as the main query.
        if isinstance(the_ast, _exp.Union):
            promote_legs(the_ast, "_main_", compiled_sql.count("\n"))

        # UNION as a CTE body (skip the __union_N__ CTEs we just added).
        if the_with_node:
            for cte_node in list(the_with_node.expressions):
                cte_alias = cte_node.alias or ""
                if cte_alias in synthetic_frame_ranges:
                    continue
                body = cte_node.this
                if isinstance(body, _exp.Union):
                    # Containing CTE's own end line (paren-matched — works
                    # because a real CTE body is wrapped in parens).
                    promote_legs(body, cte_alias, node_end_line(cte_node))

    try:
        frames: list[dict[str, _Any]] = []
        clauses_map: dict[str, list[dict[str, _Any]]] = {}
        refs_map: dict[str, list[str]] = {}

        promote_subqueries(ast)
        promote_unions(ast)

        with_node = ast.args.get("with_")
        if with_node:
            for cte_node in with_node.expressions:
                cte_name: str = cte_node.alias or ""
                if not cte_name:
                    continue

                # Body may be a Select OR a Union (e.g. `foo AS (SELECT a UNION
                # ALL SELECT b)`). Pass the full body to extract_clauses — it
                # handles both shapes.
                body: _Any = cte_node.this
                if not isinstance(body, (_exp.Select, _exp.Union)):
                    # Fallback: walk to find a Select (covers edge cases like
                    # a CTE wrapping a Subquery).
                    body = cte_node.find(_exp.Select)

                if cte_name in synthetic_frame_ranges:
                    start_line, end_line = synthetic_frame_ranges[cte_name]
                else:
                    start_line = node_line(cte_node)
                    end_line = node_end_line(cte_node)

                frames.append(
                    {
                        "name": cte_name,
                        "type": "cte",
                        "line": start_line,
                        "endLine": end_line,
                    }
                )

                if body is not None:
                    clauses_map[cte_name] = extract_clauses(cte_name, body, "")
                    refs_map[cte_name] = extract_table_refs(body)

        # _main_ node: pass Union directly (extract_clauses handles it) when
        # the top-level query is a UNION.
        if isinstance(ast, (_exp.Select, _exp.Union)):
            main_select = ast
        elif hasattr(ast, "this") and isinstance(ast.this, (_exp.Select, _exp.Union)):
            main_select = ast.this
        else:
            main_select = ast.find(_exp.Select)

        main_line = node_line(main_select) if main_select else 0
        main_end_line = compiled_sql.count("\n")

        frames.append(
            {
                "name": "_main_",
                "type": "select",
                "line": main_line,
                "endLine": main_end_line,
            }
        )

        if main_select and isinstance(main_select, (_exp.Select, _exp.Union)):
            clauses_map["_main_"] = extract_clauses("_main_", main_select, "")
            refs_map["_main_"] = extract_table_refs(main_select)

        return _json.dumps(
            {
                "success": True,
                "frames": frames,
                "clauses": clauses_map,
                "refs": refs_map,
            }
        )

    except Exception as exc:
        return _json.dumps(
            {
                "success": False,
                "error": f"Decompose error: {exc}",
                "traceback": _traceback.format_exc(),
            }
        )


def _get_dialect_symbols(dialect: str) -> str:
    """Return the authoritative symbol lists for a given sqlglot dialect.

    Returns JSON:
    {
      "functions": [...],          # lowercase SQL function names
      "keywordTokenTypes": [...],  # lowercase sqlglot TokenType names for keywords
      "types": [...]               # lowercase DataType.Type enum names
    }
    """
    from sqlglot.parser import Parser as _BaseParser  # noqa: PLC0415

    sqlglot_dialect: str | None = None if dialect == "ansi" else dialect

    if sqlglot_dialect:
        d_class = _Dialect.get_or_raise(sqlglot_dialect)
        parser_cls = d_class.parser_class
        tokenizer_cls = d_class.tokenizer_class
    else:
        parser_cls = _BaseParser
        tokenizer_cls = _Tokenizer

    # Functions: all entries in FUNCTIONS dict (uppercase → lowercase).
    functions = sorted(k.lower() for k in parser_cls.FUNCTIONS)

    # Keyword token types: unique TokenType names from the KEYWORDS dict.
    # Filter to purely alphabetic names — excludes compound types like
    # NOT_IN, L_PAREN, IS_NOT, HEX, BIT, etc. that are not user-visible keywords.
    kw_types: set[str] = set()
    for tok_type in tokenizer_cls.KEYWORDS.values():
        name = tok_type.name.lower()
        if name.isalpha():
            kw_types.add(name)

    # Data types: all DataType.Type enum members (AutoName → value equals name).
    types: list[str] = sorted(
        t.value.lower() for t in _exp.DataType.Type if isinstance(t.value, str)
    )

    return _json.dumps(
        {
            "functions": functions,
            "keywordTokenTypes": sorted(kw_types),
            "types": types,
        }
    )
