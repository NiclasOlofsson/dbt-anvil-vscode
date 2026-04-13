# ==============================================================================
# IMPORT POLICY — READ BEFORE ADDING ANYTHING HERE
#
# This file runs inside Pyodide (WebAssembly). You MUST NOT import anything
# other than:
#   - Python standard library modules
#   - sqlglot (vendored in resources/bridge/vendor/sqlglot/)
#
# No pip packages. No third-party wheels. No dbt. No system libraries.
# Violating this will silently break column lineage for all users.
# ==============================================================================
import json as _json
import re as _re
import sys as _sys
import time as _time
import traceback as _traceback
from typing import Any as _Any

from sqlglot import exp as _exp
from sqlglot import parse_one as _parse_one
from sqlglot import serde as _serde
from sqlglot import Dialect as _Dialect
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
    schema: dict[str, _Any] = _json.loads(schema_json) if schema_json else {}
    d = dialect or None

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
        ast = _qualify(ast, schema=schema, infer_schema=True, qualify_columns=True, validate_qualify_columns=False)
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
        schema: dict[str, _Any] = _json.loads(schema_json) if schema_json else {}
        d = dialect or None

        ast = _parse_one(sql, dialect=d, error_level=None)
        ast = _deep_strip_static_unions(ast)
        ast = _wrap_final_select_from_ast(ast, column_name, d)

        try:
            ast = _qualify(ast, schema=schema, infer_schema=True, qualify_columns=True, validate_qualify_columns=False)
        except Exception:
            pass
        scope = _build_scope(ast)
        if scope is None:
            return _json.dumps({'success': False, 'error': 'Failed to build scope'})

        result = _to_node(column_name, scope=scope, dialect=d)
        return _json.dumps({'success': True, 'tree': _dump_lineage_node(result)})

    except Exception as exc:
        return _json.dumps({'success': False, 'error': f'{type(exc).__name__}: {exc}', 'traceback': _traceback.format_exc()})
