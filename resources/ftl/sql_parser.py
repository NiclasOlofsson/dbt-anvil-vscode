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


def _tokenize(sql, dialect):
    try:
        if not dialect:
            raise ValueError(f"dialect is required, got {dialect!r}")
        d = None if dialect == "ansi" else dialect
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


def _trace_lineage_v2(sql: str, column_name: str, schema_json: str, dialect: str) -> str:
    """New lineage entry point: parse once, strip static branches, return raw lineage tree."""
    try:
        if not dialect:
            raise ValueError(f"dialect is required, got {dialect!r}")
        schema: dict[str, _Any] = _json.loads(schema_json) if schema_json else {}
        d = None if dialect == "ansi" else dialect

        ast = _parse_one(sql, dialect=d, error_level=None)
        ast = _deep_strip_static_unions(ast)
        ast = _wrap_final_select_from_ast(ast, column_name, d)

        try:
            ast = _qualify(
                ast,
                dialect=d,
                schema=schema,
                infer_schema=True,
                qualify_columns=True,
                validate_qualify_columns=False,
            )
        except Exception:
            pass
        scope = _build_scope(ast)
        if scope is None:
            return _json.dumps({'success': False, 'error': 'Failed to build scope'})

        result = _to_node(column_name, scope=scope, dialect=d)
        return _json.dumps({'success': True, 'tree': _dump_lineage_node(result)})

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
        after = _select_start_offset(select_node)
        return token_clause_line(clause_key, after) or node_line(select_node)

    def extract_clauses(
        name: str, select_node: _Any, _cte_prefix: str
    ) -> list[dict[str, _Any]]:
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

    try:
        frames: list[dict[str, _Any]] = []
        clauses_map: dict[str, list[dict[str, _Any]]] = {}
        refs_map: dict[str, list[str]] = {}

        promote_subqueries(ast)

        with_node = ast.args.get("with_")
        if with_node:
            for cte_node in with_node.expressions:
                cte_name: str = cte_node.alias or ""
                if not cte_name:
                    continue

                select_node = cte_node.find(_exp.Select)
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

                if select_node:
                    clauses_map[cte_name] = extract_clauses(cte_name, select_node, "")
                    refs_map[cte_name] = extract_table_refs(select_node)

        if isinstance(ast, _exp.Select):
            main_select = ast
        elif hasattr(ast, "this") and isinstance(ast.this, _exp.Select):
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

        if main_select and isinstance(main_select, _exp.Select):
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
