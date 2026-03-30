#!/usr/bin/env python3
"""
dbt Studio VS Code Extension — Python Bridge

This script is bundled with the extension and executed in the user's Python
environment (which must have dbt installed). It exposes dbt execution via a
JSON stdin/stdout protocol so the TypeScript extension can call dbt without
spawning the CLI as a subprocess each time.

Protocol:
  Startup:  prints {"type": "ready"} to stdout
  Request:  reads {"command": ["run", "--select", "my_model"]} from stdin
            or    {"get_columns": true, "compiled_sql": "...", "schema_mapping": {...}, "dialect": "duckdb"}
  Response: prints dbt output lines, then {"success": true/false, ...} on its own line
  Shutdown: reads {"shutdown": true} from stdin → exits cleanly
"""

import json
import os
import re
import sys
from typing import Any

# Prepend vendored dependencies (sqlglot) bundled with the extension.
# This ensures bridge.py works regardless of what the user's project has installed.
_VENDOR_DIR = os.path.join(os.path.dirname(__file__), "vendor")
if os.path.isdir(_VENDOR_DIR) and _VENDOR_DIR not in sys.path:
    sys.path.insert(0, _VENDOR_DIR)


def configure_stdio() -> None:
    """Ensure line-buffered I/O so messages are flushed immediately."""
    sys.stdin.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[union-attr]
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[union-attr]


def configure_dbt_env() -> None:
    """Set environment variables that make dbt output suitable for parsing."""
    os.environ["DBT_USE_COLORS"] = "0"
    os.environ["DBT_PRINTER_WIDTH"] = "120"
    os.environ.setdefault("DBT_LOG_LEVEL_FILE", "none")


def import_dbt_runner():  # type: ignore[return]
    """Import dbtRunner, or return None if dbt is not installed.

    Returns None instead of exiting so the bridge can still serve
    parse_document / get_column_lineage requests in environments where dbt
    is not installed (e.g. a plain Python env used only for SQL parsing).
    Callers that need dbt must handle the None return themselves.
    """
    try:
        from dbt.cli.main import dbtRunner  # type: ignore[import-not-found]

        return dbtRunner
    except ImportError as exc:
        error = {
            "type": "error",
            "error": f"dbt is not installed in this Python environment: {exc}",
        }
        print(json.dumps(error), flush=True)
        return None


def resolve_profiles_dir(project_dir: str) -> str:
    """Return the profiles directory: project dir if profiles.yml exists, else ~/.dbt."""
    import os.path

    project_profiles = os.path.join(project_dir, "profiles.yml")
    if os.path.exists(project_profiles):
        return project_dir
    return os.path.expanduser("~/.dbt")


def run_command(dbt, args: list, project_dir: str, profiles_dir: str) -> bool:
    """
    Invoke a dbt command. dbt output goes directly to stdout (print statements).
    Returns True if successful, False otherwise.
    """
    # Always inject --profiles-dir and --log-format unless caller provided them
    if "--profiles-dir" not in args:
        args = [*args, "--profiles-dir", profiles_dir]
    if "--log-format" not in args and len(args) > 0 and args[0] not in ("deps",):
        args = [*args, "--log-format", "text"]

    try:
        print(f"[bridge] Running: {' '.join(args)}", file=sys.stderr, flush=True)
        result = dbt.invoke(args)
        sys.stdout.flush()
        sys.stderr.flush()
        return bool(result.success)
    except Exception as exc:
        print(f"[bridge] Error: {exc}", file=sys.stderr, flush=True)
        sys.stdout.flush()
        return False


def _find_table_columns(schema_mapping: dict[str, Any], table_name: str) -> list[str]:
    """Walk {db: {schema: {table: {col: type}}}} and return column names for table_name."""
    table_lower = table_name.lower()
    for db_mapping in schema_mapping.values():
        for schema_dict in db_mapping.values():
            if table_lower in schema_dict:
                return list(schema_dict[table_lower].keys())
    return []


def _merge_alias(aliases: dict[str, list[str]], alias: str, cols: list[str]) -> None:
    """Merge cols into aliases[alias], deduplicating case-insensitively.

    The same alias name can appear in multiple SQL scopes (e.g. a CTE body and
    the outer SELECT both aliasing different tables as `map`).  Because the
    diagnostic regex is not scope-aware it validates against a single column
    list per alias, so we union the lists to avoid false positive warnings.
    """
    if alias not in aliases:
        aliases[alias] = cols
        return
    existing_lower = {c.lower() for c in aliases[alias]}
    aliases[alias] = aliases[alias] + [
        c for c in cols if c.lower() not in existing_lower
    ]


def _get_output_columns(
    compiled_sql: str,
    dialect: str,
    schema_mapping: dict[str, Any],
) -> list[str]:
    """Extract output column names from compiled SQL using sqlglot.

    Handles explicit SELECT lists and SELECT * (resolved via CTE projections
    or the schema_mapping for external table references).

    Ported from dbt-core-mcp get_column_lineage._get_output_columns_from_sql.
    """
    try:
        from sqlglot import exp, parse_one  # type: ignore[import-not-found]
        from sqlglot.optimizer.scope import (
            build_scope,  # type: ignore[import-not-found]
        )
    except ImportError:
        return []

    try:
        ast = parse_one(compiled_sql, dialect=dialect)
    except Exception:
        return []

    root_scope = build_scope(ast)
    if not root_scope:
        return []

    select = (
        root_scope.expression
        if isinstance(root_scope.expression, exp.Select)
        else root_scope.expression.find(exp.Select)
    )
    if not select:
        return []

    projections = list(select.expressions)

    # SELECT * — try to resolve via single source
    if projections and all(isinstance(p, exp.Star) for p in projections):
        if len(root_scope.selected_sources) == 1:
            _, (_, source) = next(iter(root_scope.selected_sources.items()))
            if isinstance(source, exp.Table):
                return _find_table_columns(schema_mapping, source.name)
            # CTE or subquery — read its projection
            if hasattr(source, "expression"):
                cte_select = (
                    source.expression
                    if isinstance(source.expression, exp.Select)
                    else source.expression.find(exp.Select)
                )
                if cte_select:
                    return [
                        p.alias_or_name
                        for p in cte_select.expressions
                        if p.alias_or_name
                    ]
        return []

    return [p.alias_or_name for p in projections if p.alias_or_name]


def _aliases_from_scope(
    root_scope: Any,
    schema_mapping: dict[str, Any],
) -> dict[str, list[str]]:
    """Return {alias: [col, ...]} for every alias/CTE reachable in a sqlglot scope tree.

    Accepts an already-built root_scope so that handle_parse_document can reuse
    the scope computed during the single parse pass instead of re-parsing the SQL.
    """
    try:
        from sqlglot import exp  # type: ignore[import-not-found]
    except ImportError:
        return {}

    aliases: dict[str, list[str]] = {}

    def _cols_from_scope_select(scope_node: Any) -> list[str]:
        """Extract explicit projection column names from a scope's SELECT."""
        sel = (
            scope_node.expression
            if isinstance(scope_node.expression, exp.Select)
            else scope_node.expression.find(exp.Select)
        )
        if not sel:
            return []
        projs = list(sel.expressions)
        if projs and all(isinstance(p, exp.Star) for p in projs):
            # SELECT * — try single source
            if len(scope_node.selected_sources) == 1:
                _, (_, src) = next(iter(scope_node.selected_sources.items()))
                if isinstance(src, exp.Table):
                    return _find_table_columns(schema_mapping, src.name)
                if hasattr(src, "expression"):
                    cte_sel = (
                        src.expression
                        if isinstance(src.expression, exp.Select)
                        else src.expression.find(exp.Select)
                    )
                    if cte_sel:
                        return [
                            p.alias_or_name
                            for p in cte_sel.expressions
                            if p.alias_or_name
                        ]
            return []
        return [p.alias_or_name for p in projs if p.alias_or_name]

    # Step 1: Register CTE output columns (CTE name → what it SELECTs).
    # Traverse all scopes to find cte_scopes, but only record the CTE's output
    # columns — not the internal aliases used inside the CTE body.
    # Use a cycle-safe manual traversal — sqlglot's build_scope can create
    # circular union_scopes references when the SQL contains a jinja macro stub
    # (e.g. __jinja__) in a UNION-level position, causing traverse() to loop.
    _visited_scopes: set[int] = set()
    _scope_stack: list[Any] = [root_scope]
    while _scope_stack:
        _scope = _scope_stack.pop()
        _scope_id = id(_scope)
        if _scope_id in _visited_scopes:
            continue
        _visited_scopes.add(_scope_id)
        if hasattr(_scope, "cte_scopes"):
            for cte_scope in _scope.cte_scopes:
                cte_name = cte_scope.expression.parent.alias
                if cte_name:
                    cols = _cols_from_scope_select(cte_scope)
                    if cols:
                        aliases[cte_name] = cols
            _scope_stack.extend(_scope.cte_scopes)
        for _child_attr in ("union_scopes", "subquery_scopes", "table_scopes"):
            if hasattr(_scope, _child_attr):
                _scope_stack.extend(getattr(_scope, _child_attr))

    # Step 2: Register selected sources from the ROOT scope only.
    # CTE-internal aliases must NOT pollute the top-level alias dict — they are
    # local to that CTE's scope and merging them causes false positives when the
    # same alias name is reused in the outer query.
    for alias, (_, source) in root_scope.selected_sources.items():
        if isinstance(source, exp.Table):
            table_name = source.name
            cols = _find_table_columns(schema_mapping, table_name)
            if cols:
                aliases[alias] = cols
                if alias != table_name.lower():
                    aliases[table_name.lower()] = cols
            elif table_name in aliases:
                aliases[alias] = aliases[table_name]
        else:
            # CTE/subquery reference — use the already-registered CTE output
            cols = aliases.get(alias) or (
                _cols_from_scope_select(source) if hasattr(source, "expression") else []
            )
            if not cols and hasattr(source, "expression"):
                parent = getattr(source.expression, "parent", None)
                parent_alias = getattr(parent, "alias", None) if parent else None
                if parent_alias:
                    cols = aliases.get(parent_alias, [])
            if cols:
                aliases[alias] = cols

    return aliases


def handle_compile_inline(
    request: dict[str, Any], dbt: Any, project_dir: str, profiles_dir: str
) -> None:
    """Compile a Jinja SQL string without executing it.

    Runs `dbt compile --inline <sql>` and returns the compiled SQL so that
    direct database providers can strip Jinja before sending the query.
    """
    sql: str = request.get("compile_inline", "")
    if not sql:
        print(
            json.dumps({"success": False, "error": "compile_inline sql is required"}),
            flush=True,
        )
        return

    args = [
        "--no-populate-cache",
        "compile",
        "--inline",
        sql,
        "--output",
        "json",
        "--no-introspect",
        "--project-dir",
        project_dir,
        "--profiles-dir",
        profiles_dir,
        "--log-format",
        "json",
    ]

    try:
        print(
            "[bridge] compile_inline: compiling inline SQL", file=sys.stderr, flush=True
        )
        result = dbt.invoke(args)
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}), flush=True)
        return

    compiled_sql: str | None = None
    try:
        run_results = getattr(result, "result", None)
        if run_results and hasattr(run_results, "results") and run_results.results:
            first = run_results.results[0]
            node = getattr(first, "node", None)
            if node is not None:
                compiled_sql = getattr(node, "compiled_code", None)
    except Exception as exc:
        print(
            f"[bridge] compile_inline parse error: {exc}", file=sys.stderr, flush=True
        )

    if compiled_sql is None:
        print(
            json.dumps({"success": False, "error": "Could not extract compiled SQL"}),
            flush=True,
        )
        return

    print(json.dumps({"success": True, "compiled_sql": compiled_sql}), flush=True)


def handle_describe_table(
    request: dict[str, Any], dbt: Any, project_dir: str, profiles_dir: str
) -> None:
    """Handle a describe_table request using dbt show to query the actual database.

    Runs `dbt show --inline "DESCRIBE {{ ref('name') }}"` via the live dbt runner
    and parses the column list from the output JSON. This works even when the
    manifest has no compiled_code or YAML column documentation.
    """
    name: str = request.get("name", "")
    source_name: str | None = request.get("source_name")

    if not name:
        print(json.dumps({"success": False, "error": "name is required"}), flush=True)
        return

    if source_name:
        inline_sql = f"DESCRIBE {{{{ source('{source_name}', '{name}') }}}}"
    else:
        inline_sql = f"DESCRIBE {{{{ ref('{name}') }}}}"

    args = [
        "show",
        "--inline",
        inline_sql,
        "--output",
        "json",
        "--limit",
        "-1",
        "--no-populate-cache",
        "--project-dir",
        project_dir,
        "--profiles-dir",
        profiles_dir,
        "--log-format",
        "json",
    ]

    try:
        print(f"[bridge] describe_table: {inline_sql}", file=sys.stderr, flush=True)
        result = dbt.invoke(args)
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}), flush=True)
        return

    # DESCRIBE returns one row per column: {column_name, column_type, null, key, default, extra}
    # agate_table.column_names are the result-set headers (e.g. "column_name", "column_type", ...)
    # agate_table.rows contains the actual data rows — we want the "column_name" value from each.
    columns: list[str] = []
    try:
        run_results = getattr(result, "result", None)
        if run_results and hasattr(run_results, "results") and run_results.results:
            first = run_results.results[0]
            agate_table = getattr(first, "agate_table", None)
            if agate_table is not None:
                headers = list(agate_table.column_names)
                # Find which header position holds the column name
                name_idx = next(
                    (
                        i
                        for i, h in enumerate(headers)
                        if h.lower() in ("column_name", "name")
                    ),
                    0,
                )
                for row in agate_table.rows:
                    col_name = row[name_idx]
                    if col_name:
                        columns.append(str(col_name))
        if not columns and not result.success:
            print(
                json.dumps(
                    {"success": False, "error": "dbt show failed", "columns": []}
                ),
                flush=True,
            )
            return
    except Exception as exc:
        print(
            f"[bridge] describe_table parse error: {exc}", file=sys.stderr, flush=True
        )

    print(json.dumps({"success": True, "columns": columns}), flush=True)


def _is_all_static_branch(branch: Any) -> bool:
    """Return True if all SELECT expressions in a branch are literals or NULLs."""
    try:
        from sqlglot import exp  # type: ignore[import-not-found]
    except ImportError:
        return False
    select = (
        branch
        if isinstance(branch, exp.Select)
        else branch.find(exp.Select)
        if hasattr(branch, "find")
        else None
    )
    if not select:
        return False
    return all(isinstance(e, (exp.Literal, exp.Null)) for e in select.expressions)


def _clean_static_union_branches(ast: Any, column_name: str, dialect: str) -> Any:
    """Replace static UNION branches (all literals/NULLs) with the dynamic branch."""
    try:
        from sqlglot import exp  # type: ignore[import-not-found]
    except ImportError:
        return ast
    for union in list(ast.find_all(exp.Union)):
        left = union.left
        right = union.right
        left_static = _is_all_static_branch(left)
        right_static = _is_all_static_branch(right)
        if left_static and not right_static:
            union.replace(right)
        elif right_static and not left_static:
            union.replace(left)
    return ast


def _extract_transformations_with_sources(lineage_node: Any) -> list[dict[str, Any]]:
    """Extract transformations with namespaced IDs, types, and source references.

    Two-pass approach:
    1. First pass: create all transforms, build cte_to_id lookup, detect UNION branches
    2. Second pass: extract sources by scanning expressions for CTE/table references

    Ported from dbt-core-mcp get_column_lineage._extract_transformations_with_sources.
    """
    try:
        from sqlglot import exp  # type: ignore[import-not-found]
    except ImportError:
        return []

    transform_map: dict[str, dict[str, Any]] = {}
    cte_to_id: dict[str, str] = {}
    nodes_with_data: list[tuple[str, Any, str]] = []
    outer_query_sources: set[str] = set()
    union_branches: dict[str, list[dict[str, Any]]] = {}

    # FIRST PASS
    for node in lineage_node.walk():
        if not hasattr(node, "name") or not node.name:
            continue

        if "." not in node.name:
            if hasattr(node, "reference_node_name") and node.reference_node_name:
                ref_cte = node.reference_node_name
                branch_info: dict[str, Any] = {}
                if hasattr(node, "expression") and node.expression:
                    expr_str = str(node.expression)
                    branch_info["expression"] = (
                        expr_str if len(expr_str) <= 200 else expr_str[:197] + "..."
                    )
                    if " AS " in expr_str:
                        branch_info["column"] = expr_str.split(" AS ")[-1].strip()
                    branch_info["_full_expr"] = expr_str
                union_branches.setdefault(ref_cte, []).append(branch_info)
            continue

        parts = node.name.split(".", 1)
        cte_or_table = parts[0]
        col_name = parts[1] if len(parts) > 1 else node.name

        if cte_or_table == "__lineage_final__":
            if hasattr(node, "expression") and node.expression:
                expr_str = str(node.expression)
                # Extract `identifier.` patterns — handles function-wrapped refs
                # like LOWER(omls.fno_id) correctly (yields "omls", not "LOWER(omls").
                for ref_name in re.findall(r"\b([A-Za-z_]\w*)\.", expr_str):
                    if not ref_name.isdigit():
                        outer_query_sources.add(ref_name)
            continue

        source_type = type(node.source).__name__ if hasattr(node, "source") else None
        actual_cte_or_table = cte_or_table
        if (
            hasattr(node, "source")
            and hasattr(node.source, "this")
            and node.source.this
        ):
            actual_cte_or_table = str(node.source.this)

        if source_type == "Table":
            transform_id = f"table:{actual_cte_or_table}"
            transform_type = "table"
        else:
            transform_id = f"cte:{actual_cte_or_table}"
            transform_type = "cte"

        cte_to_id[actual_cte_or_table] = transform_id

        if hasattr(node, "expression") and node.expression:
            nodes_with_data.append((transform_id, node, str(node.expression)))

        if transform_id in transform_map:
            continue

        transform: dict[str, Any] = {
            "id": transform_id,
            "type": transform_type,
            "column": col_name,
        }
        if hasattr(node, "expression") and node.expression:
            expr_sql = str(node.expression)
            if expr_sql and expr_sql.strip() != col_name:
                transform["expression"] = (
                    expr_sql if len(expr_sql) <= 200 else expr_sql[:197] + "..."
                )

        transform_map[transform_id] = transform

    # Register UNION CTEs in cte_to_id
    for ref_cte in union_branches:
        cte_to_id[ref_cte] = f"cte:{ref_cte}"

    # Create UNION transformations
    for ref_cte, branches in union_branches.items():
        if not branches:
            continue
        transform_id = f"cte:{ref_cte}"
        column = branches[0].get("column", "")
        formatted_branches: list[dict[str, Any]] = []
        for branch_info in branches:
            branch_entry: dict[str, Any] = {}
            if "expression" in branch_info:
                branch_entry["expression"] = branch_info["expression"]
            source_ids: set[str] = set()
            full_expr = branch_info.get("_full_expr", "")
            if full_expr:
                for cte_name, cte_id in cte_to_id.items():
                    if f"{cte_name}." in full_expr:
                        source_ids.add(cte_id)
            branch_entry["sources"] = sorted(source_ids)
            formatted_branches.append(branch_entry)
        transform_map[transform_id] = {
            "id": transform_id,
            "type": "union",
            "column": column,
            "branches": formatted_branches,
        }

    # SECOND PASS: extract sources per non-union transform
    sources_map: dict[str, set[str]] = {}
    for transform_id, node, expr_str in nodes_with_data:
        source_ids_2: set[str] = set()
        if (
            expr_str.strip() == "*"
            and hasattr(node, "source")
            and hasattr(node.source, "find")
        ):
            table_node = node.source.find(exp.Table)
            if table_node and hasattr(table_node, "this"):
                source_ids_2.add(f"table:{table_node.this}")
        for cte_name, cte_id in cte_to_id.items():
            if cte_id != transform_id and f"{cte_name}." in expr_str:
                source_ids_2.add(cte_id)
        sources_map.setdefault(transform_id, set()).update(source_ids_2)

    transformations: list[dict[str, Any]] = []
    for trans in transform_map.values():
        if trans.get("type") != "union":
            trans["sources"] = sorted(sources_map.get(trans["id"], set()))
        transformations.append(trans)

    if outer_query_sources:
        column_for_query = next((t.get("column", "") for t in transformations), "")
        resolved_sources: list[str] = []
        for ref_name in outer_query_sources:
            if ref_name in cte_to_id:
                resolved_sources.append(cte_to_id[ref_name])
            else:
                resolved_sources.append(f"table:{ref_name}")
        transformations.insert(
            0,
            {
                "id": "query",
                "type": "outer_query",
                "column": column_for_query,
                "sources": sorted(resolved_sources),
            },
        )

    return transformations


def _wrap_final_select(
    compiled_sql: str,
    column_name: str,
    dialect: str,
) -> Any:
    """Wrap the final SELECT in a CTE to enable lineage tracing through SELECT *.

    Transforms:
        SELECT * FROM final
    Into:
        WITH __lineage_final__ AS (SELECT * FROM final)
        SELECT column_name FROM __lineage_final__

    Ported from dbt-core-mcp get_column_lineage._wrap_final_select.
    """
    from sqlglot import exp, parse_one  # type: ignore[import-not-found]

    ast = parse_one(compiled_sql, dialect=dialect)

    # Handle top-level UNION ALL: the WITH clause lives on the leftmost SELECT
    # branch but the overall query body is a Union node.  Wrap the full union
    # (stripped of its WITH) as __lineage_final__ so lineage() sees a single
    # outer SELECT and can trace the column through all branches.
    if isinstance(ast, exp.Union):
        # Walk to the leftmost SELECT to borrow its WITH clause.
        leftmost: Any = ast
        while isinstance(leftmost, exp.Union):
            leftmost = leftmost.this
        with_clause = None
        if isinstance(leftmost, exp.Select):
            with_clause = leftmost.args.get("with_")
            if with_clause:
                leftmost.set("with_", None)  # detach; will move to outer SELECT
        # Wrap the union body (now without WITH) as __lineage_final__.
        union_cte = exp.CTE(
            this=ast,
            alias=exp.TableAlias(this=exp.Identifier(this="__lineage_final__")),
        )
        if with_clause:
            with_clause.expressions.append(union_cte)
        else:
            with_clause = exp.With(expressions=[union_cte])
        # Build: WITH <original CTEs>, __lineage_final__ AS (<union>)
        #        SELECT <column_name> FROM __lineage_final__
        outer = exp.Select()
        outer.set("with_", with_clause)
        outer.set(
            "expressions",
            [exp.Column(this=exp.Identifier(this=column_name))],
        )
        outer.set(
            "from_",
            exp.From(this=exp.Table(this=exp.Identifier(this="__lineage_final__"))),
        )
        return outer

    root_select = ast if isinstance(ast, exp.Select) else ast.find(exp.Select)
    if not root_select:
        return ast

    with_clause = root_select.args.get("with_")

    wrapper_select = root_select.copy()
    wrapper_select.set("with_", None)

    wrapper_cte = exp.CTE(
        this=wrapper_select,
        alias=exp.TableAlias(this=exp.Identifier(this="__lineage_final__")),
    )

    for key in list(root_select.args.keys()):
        root_select.set(key, None)

    if with_clause:
        with_clause.expressions.append(wrapper_cte)
    else:
        with_clause = exp.With(expressions=[wrapper_cte])

    root_select.set("with_", with_clause)
    root_select.set(
        "expressions",
        [exp.Column(this=exp.Identifier(this=column_name))],
    )
    root_select.set(
        "from_",
        exp.From(this=exp.Table(this=exp.Identifier(this="__lineage_final__"))),
    )

    return ast


def _collect_union_selects(expr: Any) -> list[Any]:
    """Recursively collect all SELECT leaf nodes from a UNION tree."""
    from sqlglot import exp  # type: ignore[import-not-found]

    if isinstance(expr, exp.Union):
        return _collect_union_selects(expr.this) + _collect_union_selects(
            expr.args.get("expression") or expr.right
        )
    if isinstance(expr, exp.Select):
        return [expr]
    return []


def _get_source_name(node: Any) -> str | None:
    """Extract the table/CTE name from a FROM-clause source node."""
    if node is None:
        return None
    alias = getattr(node, "alias", None)
    if alias:
        return str(alias).lower()
    name = getattr(node, "name", None)
    if name:
        return str(name).lower()
    return None


def _trace_col_in_select(
    sel: Any,
    col: str,
    ctes: dict[str, Any],
    visited: set[str],
    queue: list[tuple[str, str]],
    dependencies: list[dict[str, Any]],
    via_ctes: list[str],
) -> None:
    """Trace *col* within a single SELECT node, enqueuing sources for further traversal."""
    from sqlglot import exp  # type: ignore[import-not-found]

    exprs = sel.expressions
    from_clause = sel.args.get("from_")
    from_name = _get_source_name(from_clause.this) if from_clause else None

    # SELECT * — treat as passthrough: same column name, continue into source
    if any(
        isinstance(e, (exp.Star, exp.Column))
        and getattr(e, "name", None) == "*"
        or isinstance(e, exp.Star)
        for e in exprs
    ):
        if from_name:
            if from_name in ctes and from_name not in visited:
                if from_name not in via_ctes:
                    via_ctes.append(from_name)
                queue.append((from_name, col))
            elif from_name not in ctes:
                dependencies.append({"column": col, "table": from_name})
        return

    # Explicit column list — find the expression that defines *col*
    for expr in exprs:
        if isinstance(expr, exp.Alias) and expr.alias.lower() == col:
            inner: Any = expr.this
        elif isinstance(expr, exp.Column) and expr.name.lower() == col:
            inner = expr
        else:
            continue

        # Collect all column references inside the expression.
        # For a plain column reference this is just [inner]; for expressions like
        # SUM(amount), COALESCE(a, b), LOWER(x), or CASE WHEN ... THEN amount ...
        # it walks inside the function/expression and finds every referenced column.
        col_refs = (
            [inner]
            if isinstance(inner, exp.Column)
            else list(inner.find_all(exp.Column))
        )
        for col_ref in col_refs:
            src_table = (str(col_ref.table) if col_ref.table else "").lower()
            src_col = col_ref.name.lower()
            if not src_table and from_name:
                src_table = from_name
            if src_table and src_table in ctes and src_table not in visited:
                if src_table not in via_ctes:
                    via_ctes.append(src_table)
                queue.append((src_table, src_col))
            elif src_table:
                dependencies.append({"column": src_col, "table": src_table})
        # Found the target column — stop scanning this SELECT
        break


def _trace_column_simple(
    compiled_sql: str,
    column_name: str,
    dialect: str,
) -> dict[str, Any]:
    """Simple CTE-walking fallback for column lineage.

    Used when sqlglot.lineage() fails. Traces *column_name* through the CTE
    chain by inspecting SELECT lists.  SELECT * is treated as a column
    passthrough so unknown-schema tables don't cause crashes.
    """
    try:
        from sqlglot import exp, parse_one  # type: ignore[import-not-found]

        ast = parse_one(compiled_sql, dialect=dialect)

        # Build CTE name → expression from whichever node carries the WITH clause.
        # For a top-level UNION the WITH clause lives on the leftmost SELECT branch.
        def _extract_ctes(node: Any) -> dict[str, Any]:
            leftmost = node
            while isinstance(leftmost, exp.Union):
                leftmost = leftmost.this
            result: dict[str, Any] = {}
            if isinstance(leftmost, exp.Select):
                with_ = leftmost.args.get("with_")
                if with_:
                    for cte in with_.expressions:
                        result[cte.alias.lower()] = cte.this
            return result

        # Handle a top-level UNION: trace the column through every branch.
        if isinstance(ast, exp.Union):
            ctes = _extract_ctes(ast)
            branches = _collect_union_selects(ast)

            dependencies: list[dict[str, Any]] = []
            via_ctes: list[str] = []
            visited: set[str] = set()

            for branch_sel in branches:
                from_clause = branch_sel.args.get("from_")
                if not from_clause:
                    continue
                from_name = _get_source_name(from_clause.this)
                if not from_name:
                    continue
                branch_queue: list[tuple[str, str]] = [(from_name, column_name.lower())]
                while branch_queue:
                    name, col = branch_queue.pop(0)
                    if name not in ctes:
                        dep = {"column": col, "table": name}
                        if dep not in dependencies:
                            dependencies.append(dep)
                        continue
                    if name in visited:
                        continue
                    visited.add(name)
                    cte_body = ctes[name]
                    sub_selects = (
                        _collect_union_selects(cte_body)
                        if not isinstance(cte_body, exp.Select)
                        else [cte_body]
                    )
                    for sub_sel in sub_selects:
                        _trace_col_in_select(
                            sub_sel,
                            col,
                            ctes,
                            visited,
                            branch_queue,
                            dependencies,
                            via_ctes,
                        )

            return {
                "dependencies": dependencies,
                "via_ctes": list(dict.fromkeys(via_ctes)),
                "transformations": [],
            }

        if not isinstance(ast, exp.Select):
            return {"dependencies": [], "via_ctes": [], "transformations": []}

        # Build CTE name → expression index
        ctes = _extract_ctes(ast)

        outer_from = ast.args.get("from_")
        if not outer_from:
            return {"dependencies": [], "via_ctes": [], "transformations": []}

        root_name = _get_source_name(outer_from.this)
        if not root_name:
            return {"dependencies": [], "via_ctes": [], "transformations": []}

        dependencies = []
        via_ctes = []
        visited = set()
        queue: list[tuple[str, str]] = [(root_name, column_name.lower())]

        while queue:
            name, col = queue.pop(0)
            if name not in ctes:
                dependencies.append({"column": col, "table": name})
                continue
            if name in visited:
                continue
            visited.add(name)

            cte_body = ctes[name]
            selects = (
                _collect_union_selects(cte_body)
                if not isinstance(cte_body, exp.Select)
                else [cte_body]
            )

            for sel in selects:
                _trace_col_in_select(
                    sel, col, ctes, visited, queue, dependencies, via_ctes
                )

        return {
            "dependencies": dependencies,
            "via_ctes": list(dict.fromkeys(via_ctes)),
            "transformations": [],
        }
    except Exception:
        return {"dependencies": [], "via_ctes": [], "transformations": []}


def _trace_column_lineage(
    compiled_sql: str,
    column_name: str,
    schema_mapping: dict[str, Any],
    dialect: str,
) -> dict[str, Any]:
    """Trace column lineage using sqlglot.lineage() with UNION-cleanup retry.

    Returns upstream dependencies with CTE paths and namespaced transformations.

    Ported from dbt-core-mcp get_column_lineage._analyze_column_lineage,
    _extract_transformations_with_sources, and _extract_dependencies_from_lineage.
    """
    from sqlglot.errors import SqlglotError  # type: ignore[import-not-found]
    from sqlglot.lineage import lineage  # type: ignore[import-not-found]

    wrapped_ast = _wrap_final_select(compiled_sql, column_name, dialect)

    result = None
    for attempt in range(3):
        try:
            result = lineage(
                column=column_name,
                sql=wrapped_ast,
                schema=schema_mapping,
                dialect=dialect,
            )
            break
        except (IndexError, SqlglotError):
            if attempt < 2:
                wrapped_ast = _clean_static_union_branches(
                    wrapped_ast, column_name, dialect
                )

    if result is None:
        # sqlglot.lineage() failed after all retries — fall back to simple CTE walking.
        # This handles cases where SELECT * propagation causes IndexError inside sqlglot
        # because an upstream table is absent from the schema mapping.
        return _trace_column_simple(compiled_sql, column_name, dialect)

    # Extract dependencies (table nodes) and via_ctes
    dependencies: list[dict[str, Any]] = []
    via_ctes: list[str] = []

    for node in result.walk():
        if not hasattr(node, "name") or not node.name:
            continue

        name = node.name
        if "." in name:
            parts = name.split(".", 1)
            table_or_cte = parts[0]
            col = parts[1]
        else:
            table_or_cte = None
            col = name

        is_table = False
        if hasattr(node, "source"):
            source = node.source
            is_table = (
                hasattr(source, "catalog") or getattr(source, "db", None) is not None
            )

        if is_table and table_or_cte:
            # Use the actual table name from the source expression,
            # not the SQL alias (e.g. "c" from "stg_customers AS c").
            actual_table = getattr(node.source, "name", table_or_cte) or table_or_cte
            dep: dict[str, Any] = {"column": col, "table": actual_table}
            _src_db = getattr(node.source, "db", None)
            if _src_db:
                dep["schema"] = str(_src_db).strip('"')
            _src_catalog = getattr(node.source, "catalog", None)
            if _src_catalog:
                dep["database"] = str(_src_catalog).strip('"')
            dependencies.append(dep)
        elif table_or_cte and table_or_cte != "__lineage_final__":
            if table_or_cte not in via_ctes:
                via_ctes.append(table_or_cte)

    transformations = _extract_transformations_with_sources(result)

    return {
        "dependencies": dependencies,
        "via_ctes": via_ctes,
        "transformations": transformations,
    }


_JINJA_TAG_RE = re.compile(r"\{%-?[\s\S]*?-?%\}|\{\{[\s\S]*?\}\}|\{#-?[\s\S]*?-?#\}")
# Matches {{ ref('model') }} and {{ ref("model") }}
_REF_TAG_RE = re.compile(r"\{\{[^}]*ref\(\s*['\"]([^'\"]+)['\"]\s*\)[^}]*\}\}")
# Matches {{ source('name', 'table') }} and double-quote variants
_SOURCE_TAG_RE = re.compile(
    r"\{\{[^}]*source\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)[^}]*\}\}"
)
# Matches any {{ callable(...) }} or {{ ns.callable(...) }} — captures the last
# component of the name (e.g. "generate_schema_name" from "dbt_utils.generate_schema_name()")
_MACRO_TAG_RE = re.compile(r"\{\{\s*(?:[a-zA-Z_]\w*\.)*([a-zA-Z_]\w*)\s*\(")
# dbt macros that produce NO SQL output — blanking them to spaces is correct.
_STATEMENT_MACROS = frozenset(
    {"config", "docs", "print", "log", "return", "exceptions"}
)


def _blank_jinja(sql: str) -> str:
    """Replace Jinja tags with space-padded SQL-safe placeholders.

    Preserves ``len(result) == len(sql)`` so every character offset and line
    number from the sqlglot AST maps directly back to the original source.

    Strategy (in priority order for ``{{ }}`` expression tags):
    - ``{{ ref('model') }}``               → ``model              `` (real model name)
    - ``{{ source('ns','tbl') }}``         → ``tbl                `` (real table name)
    - ``{{ config(...) }}`` / known no-SQL → all spaces (produces no SQL output)
    - ``{{ my_macro('arg') }}``            → ``my_macro            `` (macro name as identifier)
    - ``{{ ns.macro('arg') }}``            → ``macro               `` (last name component)
    - ``{{ arbitrary_expr }}``             → ``_                   `` (safe fallback identifier)
    - ``{% ... %}`` block/statement tags   → all spaces (never expression values)
    - ``{# ... #}`` comment tags           → all spaces

    Newlines inside tags are always preserved so line numbers stay correct.
    """
    buf = list(sql)

    for m in _JINJA_TAG_RE.finditer(sql):
        tag = m.group(0)
        start, end = m.start(), m.end()

        # Determine replacement: an identifier string, or blank_to_spaces=True,
        # or neither (falls back to ``_`` anchor for unknown expression tags).
        identifier: str | None = None
        blank_to_spaces = not tag.startswith("{{")  # {# #} and {% %} always spaces

        if tag.startswith("{{"):
            ref_m = _REF_TAG_RE.fullmatch(tag)
            if ref_m:
                identifier = ref_m.group(1)
            else:
                src_m = _SOURCE_TAG_RE.fullmatch(tag)
                if src_m:
                    identifier = src_m.group(2)
                else:
                    macro_m = _MACRO_TAG_RE.match(tag)
                    if macro_m:
                        name = macro_m.group(1)
                        if name in _STATEMENT_MACROS:
                            # Known no-output macros: blank completely to spaces.
                            # Do NOT fall through to the ``_`` fallback — a bare
                            # ``_`` before e.g. ``WITH`` causes a parse error.
                            blank_to_spaces = True
                        else:
                            identifier = name

        # Blank the tag character-by-character, skipping newlines.
        non_nl_positions = [i for i in range(start, end) if sql[i] != "\n"]

        if identifier and non_nl_positions:
            # Write identifier chars into the first N positions, spaces for the rest.
            for j, pos in enumerate(non_nl_positions):
                buf[pos] = identifier[j] if j < len(identifier) else " "
        elif blank_to_spaces:
            # Comment/block tags, statement macros → all spaces.
            for i in range(start, end):
                if sql[i] != "\n":
                    buf[i] = " "
        else:
            # Unknown {{ expr }} with no callable name — ``_`` as first char so
            # it remains a valid identifier if it appears in an expression position.
            first = True
            for i in range(start, end):
                if sql[i] == "\n":
                    continue
                buf[i] = "_" if first else " "
                first = False

    return "".join(buf)


# ---------------------------------------------------------------------------
# Jinja2 stub rendering — fallback when _blank_jinja produces un-parseable SQL
# ---------------------------------------------------------------------------

_SQL_STUB = "__jinja__"  # valid SQL identifier returned for unknown macro calls
_JINJA_STUB_ENV: Any = None  # lazily initialised, module-level cache


def _get_jinja_stub_env() -> Any:
    """Return a cached Jinja2 Environment with dbt stub implementations.

    All unknown variables and callables return ``_SQL_STUB`` so macro calls like
    ``{{ generic_is_deleted(col) }}`` produce a valid SQL token instead of
    raising.  Known dbt globals (``ref``, ``source``, ``config``, ``var``, …)
    are implemented with sensible defaults.

    Raises ``RuntimeError`` if jinja2 is not importable.
    """
    global _JINJA_STUB_ENV
    if _JINJA_STUB_ENV is not None:
        return _JINJA_STUB_ENV

    try:
        import jinja2  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "jinja2 is not installed in this Python environment"
        ) from exc

    class _StubUndefined(jinja2.Undefined):
        """Unknown variable or macro → stub value; usable as callable/iterable."""

        def __getattr__(self, name: str) -> "_StubUndefined":
            # jinja2.Undefined.__getattr__ raises UndefinedError for attribute
            # access (e.g. wh.is_deleted where wh is undefined).  Override to
            # return self so attribute chains stay as stubs instead of raising.
            if name[:2] == "__":
                raise AttributeError(name)
            return self

        def __call__(self, *args: Any, **kwargs: Any) -> str:
            return _SQL_STUB

        def __str__(self) -> str:
            return _SQL_STUB

        def __iter__(self):  # type: ignore[override]
            return iter([])

        def __bool__(self) -> bool:
            return False

        def __add__(self, other: Any) -> str:
            return _SQL_STUB

        def __radd__(self, other: Any) -> str:
            return _SQL_STUB

    env = jinja2.Environment(undefined=_StubUndefined, keep_trailing_newline=True)
    env.globals.update(
        {
            "ref": lambda *args: args[-1] if args else _SQL_STUB,
            "source": lambda *args: args[-1] if args else _SQL_STUB,
            "config": lambda *args, **kwargs: "",
            "var": lambda name, default="": default,
            "env_var": lambda name, default="": default,
            "is_incremental": lambda: False,
            "execute": False,
            "run_started_at": "",
            "invocation_id": "",
        }
    )
    _JINJA_STUB_ENV = env
    return env


def _render_jinja_for_parse(
    raw_sql: str,
) -> tuple[str, list[tuple[int, int]]]:
    """Render dbt Jinja SQL via stub env; return ``(rendered, line_map)``.

    ``line_map`` is a sorted list of ``(ren_line, raw_line)`` breakpoints
    (both 0-based).  To convert a rendered line number *R* to the corresponding
    raw line number, find the largest entry where ``ren_line <= R``, then::

        raw_line = bp.raw_line + (R - bp.ren_line)

    **Accuracy**

    - ``{{ expr }}`` expression tags: the stub env returns a single-line string,
      so no newlines are introduced or removed.  The mapping is **exact** for
      these (the common case: ``{{ my_macro(col) }}``, ``{{ ref('t') }}``, …).
    - ``{% if/for/… %}`` block tags whose inner content is *dropped* during
      rendering (e.g. ``{% if is_incremental() %}…{% endif %}`` with the stub
      returning ``False``): the dropped literal newlines are counted in *ren_line*
      when they should not be, so the mapping is **approximate** after that region.
      In practice this only affects ``{% if is_incremental() %}`` blocks which
      appear at the *end* of models — after all CTE definitions — so CTE line
      numbers remain correct.

    Raises ``RuntimeError`` if jinja2 is unavailable or the template fails to
    render even with stubs.
    """
    env = _get_jinja_stub_env()
    try:
        rendered = env.from_string(raw_sql).render()
    except Exception as exc:
        raise RuntimeError(f"Jinja2 render failed: {exc}") from exc

    # Build (ren_line, raw_line) breakpoints by walking every Jinja tag.
    # For each tag:
    #   • Literal section before the tag: both raw_line and ren_line advance by
    #     the same newline count (assumption: the literal is present in rendered;
    #     see docstring for the approximation caveat with {% if False %} blocks).
    #   • Expression tag {{ … }}: raw_line advances by the tag's newline count;
    #     ren_line does NOT (the stub value is always a single-line identifier).
    #   • Block/comment tag {% … %} / {# … #}: same as expression — raw_line
    #     may advance, ren_line stays put.
    # Whenever raw_line and ren_line diverge we emit a new breakpoint.
    raw_line = 0
    ren_line = 0
    raw_pos = 0
    breakpoints: list[tuple[int, int]] = [(0, 0)]

    for m in _JINJA_TAG_RE.finditer(raw_sql):
        # Literal section before this tag (assumed kept in rendered).
        lit_newlines = raw_sql[raw_pos : m.start()].count("\n")
        raw_line += lit_newlines
        ren_line += lit_newlines

        # The tag itself: raw may span multiple lines; rendered produces ≤0 newlines.
        tag_raw_newlines = m.group(0).count("\n")
        raw_line += tag_raw_newlines
        # ren_line does NOT advance (stub value has no newlines).
        if tag_raw_newlines > 0:
            breakpoints.append((ren_line, raw_line))

        raw_pos = m.end()

    return rendered, breakpoints


def _ren_to_raw_line(ren_line: int, line_map: list[tuple[int, int]]) -> int:
    """Map a 0-based rendered line number to the corresponding raw line number.

    Uses binary search on ``line_map`` (sorted by rendered line).  Returns
    ``ren_line`` unchanged when ``line_map`` is empty (identity mapping).
    """
    if not line_map:
        return ren_line
    import bisect

    idx = max(0, bisect.bisect_right(line_map, (ren_line, 10**9)) - 1)
    ren_bp, raw_bp = line_map[idx]
    return raw_bp + (ren_line - ren_bp)


def _projection_line(proj: Any) -> int:  # type: ignore[return]
    """Return the 0-based line number for a SELECT projection expression.

    sqlglot only populates ``meta["line"]`` on leaf ``Identifier`` nodes, not on
    the wrapper ``Column`` / ``Alias`` nodes.  We drill into the most relevant
    identifier: the alias name for ``Alias`` expressions, the column identifier
    for ``Column`` expressions, or the first identifier found anywhere in the
    projection tree as a fallback.

    Requires that sqlglot has been imported (called only from handle_parse_document
    where ``from sqlglot import exp`` has already been executed).
    """
    from sqlglot import exp  # type: ignore[import-not-found]

    # Alias: prefer the alias-name identifier (e.g. "doubled" in "total*2 as doubled")
    if isinstance(proj, exp.Alias):
        alias_id = proj.args.get("alias")
        if isinstance(alias_id, exp.Identifier):
            line = alias_id.meta.get("line")
            if line:
                return max(0, line - 1)
    # Column / bare Identifier: use .this
    this = getattr(proj, "this", None)
    if isinstance(this, exp.Identifier) and this is not None:
        line = this.meta.get("line")  # type: ignore[union-attr]
        if line:
            return max(0, line - 1)
    # Fallback: first token node with a line anywhere in the subtree.
    # sqlglot sets meta only on leaf/terminal nodes (Star, Number, Identifier,
    # string literals, etc.) — so we walk and accept the first hit of any type.
    for node in proj.walk():
        line = node.meta.get("line")
        if line:
            return max(0, line - 1)
    return 0


def handle_parse_document(request: dict[str, Any]) -> None:
    """Parse a SQL document and return a structured DocumentModel as JSON.

    Extracts CTEs (with column lists and line ranges), ref/source calls, and
    final output columns from the raw Jinja-SQL source.

    Two-pass strategy:
      Pass 1 (fast) — ``_blank_jinja``: replaces Jinja tags with space-padded
        placeholders, preserving all character offsets.  Works for the vast
        majority of dbt files.
      Pass 2 (fallback) — Jinja2 stub rendering: if pass 1 produces SQL that
        sqlglot cannot parse (e.g. a macro that emits a SQL fragment ends up as
        a bare identifier in an invalid position), we render the template with a
        stub Jinja2 environment.  All unknown macros return ``'__jinja__'`` — a
        valid SQL token.  A line-number map is built alongside so that reported
        line numbers refer back to the *raw* (unrendered) source.

    Response shape:
      {
        "success": true,
        "ctes": [
          {
            "name": str,
            "line": int,
            "col": int,           # absent if name position unavailable
            "endLine": int,
            "endCol": int,        # absent if closing paren not found; exclusive end col
            "columns": [{"name": str, "line": int}],
            "alias": str          # absent if no alias
          }
        ],
        "refs": [
          {
            "model": str,
            "line": int,
            "col": int,
            "modelCol": int,
            "modelEndCol": int,
            "jinjaCol": int,
            "jinjaEndCol": int,
            "alias": str          # absent if no alias
          }
        ],
        "sources": [
          {
            "sourceName": str,
            "tableName": str,
            "line": int,
            "col": int,
            "sourceNameCol": int,
            "sourceNameEndCol": int,
            "tableNameCol": int,
            "tableNameEndCol": int,
            "jinjaCol": int,
            "jinjaEndCol": int,
            "alias": str          # absent if no alias
          }
        ],
        "finalColumns": [{"name": str, "line": int}],
        "tokens": [
          # column_ref — a column usage, e.g. `o.order_id` or bare `city`
          {
            "type": "column_ref",
            "name": str,
            "line": int,
            "col": int,
            "endCol": int,
            "table": str,         # absent if no qualifier
            "tableLine": int,     # absent if no qualifier
            "tableCol": int,      # absent if no qualifier
            "tableEndCol": int,   # absent if no qualifier
            "resolvedTableRef":   # absent if qualifier could not be resolved
          },
          # table_ref — a FROM/JOIN target, e.g. `{{ ref('orders') }} as o`
          {
            "type": "table_ref",
            "name": str,
            "line": int,
            "col": int,
            "endCol": int,
            "alias": str,         # absent if no alias
            "aliasLine": int,     # absent if no alias
            "aliasCol": int,      # absent if no alias
            "aliasEndCol": int    # absent if no alias
          },
          # column_def — an output alias, e.g. `amt * 2 as total`
          {
            "type": "column_def",
            "name": str,
            "line": int,
            "col": int,
            "endCol": int
          }
        ],
        "aliases": {str: [str]},  # alias -> [column names] from schema-aware parse
        "sqlglotWarnings": [
          # Two sources, distinguished by the 'type' field:
          # "scope_warning" — SQL parsed OK but sqlglot can't analyse a CTE scope
          #   (e.g. bare identifier where a subquery is expected).  cteName is set.
          # "syntax_error"  — outright parse failure (typo, missing keyword, etc.).
          #   cteName is absent; line/col/endCol point directly at the bad token.
          {
            "type": "scope_warning" | "syntax_error",
            "message": str,
            "cteName": str,       # absent for syntax_error
            "line": int,          # absent if position unknown
            "col": int,           # absent for scope_warning without a position match
            "endCol": int         # absent for scope_warning without a position match
          }
        ],
        "timing": {"parseMs": float, "totalMs": float}
      }
    """
    import bisect
    import time

    t0 = time.perf_counter()

    raw_sql: str = request.get("sql", "")
    dialect: str = request.get("dialect", "ansi")

    if not raw_sql:
        print(json.dumps({"success": False, "error": "sql is required"}), flush=True)
        return

    # Build a character-offset → 0-based line number lookup for *raw* SQL.
    # bisect_right on line_starts gives O(log n) per lookup.
    line_starts: list[int] = [0]
    for i, ch in enumerate(raw_sql):
        if ch == "\n":
            line_starts.append(i + 1)

    def offset_to_line(offset: int) -> int:
        return max(0, bisect.bisect_right(line_starts, offset) - 1)

    def offset_to_col(offset: int) -> int:
        line = offset_to_line(offset)
        return offset - line_starts[line]

    # Build a lookup: (line_0, col_0) → exclusive end_col_0 of the full jinja
    # tag for every {{ ref(...) }} in the raw SQL.  Used below to extend
    # table_ref token endCol beyond the identifier to cover the whole tag.
    _jinja_ref_end: dict[tuple[int, int], int] = {}

    # Extract refs/sources from raw Jinja SQL (they live inside Jinja tags and
    # would disappear from any preprocessed version).
    ref_re = re.compile(r"ref\(\s*['\"]([^'\"]+)['\"]\s*\)")
    source_re = re.compile(
        r"source\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)"
    )
    for jinja_m in _JINJA_TAG_RE.finditer(raw_sql):
        if ref_re.search(jinja_m.group(0)) or source_re.search(jinja_m.group(0)):
            line_0 = offset_to_line(jinja_m.start())
            col_0 = offset_to_col(jinja_m.start())
            # All chars in a ref/source tag are on one line, so end col = start col + tag length.
            end_col_0 = col_0 + (jinja_m.end() - jinja_m.start())
            _jinja_ref_end[(line_0, col_0)] = end_col_0

    refs: list[dict[str, Any]] = []
    for m in ref_re.finditer(raw_sql):
        jinja_start = raw_sql.rfind("{{", 0, m.start())
        jinja_end = raw_sql.find("}}", m.end()) + 2
        refs.append(
            {
                "model": m.group(1),
                "line": offset_to_line(m.start()),
                "col": offset_to_col(m.start()),
                "modelCol": offset_to_col(m.start(1)),
                "modelEndCol": offset_to_col(m.end(1)),
                "jinjaCol": offset_to_col(jinja_start),
                "jinjaEndCol": offset_to_col(jinja_end),
            }
        )
    sources: list[dict[str, Any]] = []
    for m in source_re.finditer(raw_sql):
        jinja_start = raw_sql.rfind("{{", 0, m.start())
        jinja_end = raw_sql.find("}}", m.end()) + 2
        sources.append(
            {
                "sourceName": m.group(1),
                "tableName": m.group(2),
                "line": offset_to_line(m.start()),
                "col": offset_to_col(m.start()),
                "sourceNameCol": offset_to_col(m.start(1)),
                "sourceNameEndCol": offset_to_col(m.end(1)),
                "tableNameCol": offset_to_col(m.start(2)),
                "tableNameEndCol": offset_to_col(m.end(2)),
                "jinjaCol": offset_to_col(jinja_start),
                "jinjaEndCol": offset_to_col(jinja_end),
            }
        )

    try:
        from sqlglot import exp, parse_one  # type: ignore[import-not-found]
        from sqlglot.optimizer.scope import (
            build_scope,  # type: ignore[import-not-found]
        )
    except ImportError:
        print(
            json.dumps({"success": False, "error": "sqlglot not available"}), flush=True
        )
        return

    sqlglot_dialect: str | None = dialect if dialect not in ("ansi", "", None) else None

    # ------------------------------------------------------------------
    # Pass 1: _blank_jinja — fast, exact offsets, works for most files.
    # ------------------------------------------------------------------
    parse_t0 = time.perf_counter()
    parse_sql = _blank_jinja(raw_sql)
    # line_map is None → AST line numbers are in raw space (no remapping needed).
    line_map: list[tuple[int, int]] | None = None

    ast = None
    try:
        ast = parse_one(parse_sql, dialect=sqlglot_dialect, error_level=None)
    except Exception:
        pass

    # ------------------------------------------------------------------
    # Pass 2: Jinja2 stub rendering — handles macros emitting SQL fragments.
    # ------------------------------------------------------------------
    if ast is None:
        try:
            rendered, line_map = _render_jinja_for_parse(raw_sql)
            parse_sql = rendered
            # Try strict parse first; fall back to ErrorLevel.IGNORE when the
            # stub value (__jinja__) still ends up in a syntactically invalid
            # position (e.g. a macro that emits a WHERE fragment, landing
            # between a JOIN condition and a UNION ALL).
            try:
                ast = parse_one(rendered, dialect=sqlglot_dialect, error_level=None)
            except Exception:
                from sqlglot.errors import ErrorLevel  # type: ignore[import-not-found]

                ast = parse_one(
                    rendered, dialect=sqlglot_dialect, error_level=ErrorLevel.IGNORE
                )
        except Exception as exc:
            print(
                json.dumps({"success": False, "error": f"parse error: {exc}"}),
                flush=True,
            )
            return

    if ast is None:
        print(
            json.dumps({"success": False, "error": "parse returned no result"}),
            flush=True,
        )
        return

    parse_ms = (time.perf_counter() - parse_t0) * 1000

    def to_raw_line(ren_line: int) -> int:
        """Convert an AST line number to the raw-source line number."""
        if line_map is None:
            return ren_line
        return _ren_to_raw_line(ren_line, line_map)

    # Build a line_starts equivalent for parse_sql (needed for endLine paren scan).
    parse_line_starts: list[int] = [0]
    for i, ch in enumerate(parse_sql):
        if ch == "\n":
            parse_line_starts.append(i + 1)

    def parse_offset_to_line(offset: int) -> int:
        return max(0, bisect.bisect_right(parse_line_starts, offset) - 1)

    # Extract CTE info.
    ctes: list[dict[str, Any]] = []
    seen_cte_names: set[str] = set()
    for cte_node in ast.find_all(exp.CTE):
        cte_name: str = cte_node.alias or ""
        if not cte_name or cte_name in seen_cte_names:
            continue
        seen_cte_names.add(cte_name)

        # sqlglot only populates meta["line"] on leaf Identifier nodes.
        # CTE alias is a TableAlias whose .this is the name Identifier.
        _alias_node = cte_node.args.get("alias")
        _alias_id = (
            getattr(_alias_node, "this", None) if _alias_node is not None else None
        )
        _raw_line: int | None = (
            _alias_id.meta.get("line")  # type: ignore[union-attr]
            if isinstance(_alias_id, exp.Identifier)
            else None
        )
        _raw_col: int | None = (
            _alias_id.meta.get("col")  # type: ignore[union-attr]
            if isinstance(_alias_id, exp.Identifier)
            else None
        )
        # sqlglot line numbers are 1-based; convert to 0-based, then map to raw.
        start_line = to_raw_line(max(0, (_raw_line or 1) - 1))
        # sqlglot col is 1-based exclusive end; convert to 0-based inclusive start.
        start_col: int | None = (_raw_col - len(cte_name)) if _raw_col else None

        # Walk parse_sql from start of the CTE's line to find the opening '('
        # then scan for its matching ')' to determine end_line and end_col.
        end_line = start_line
        end_col: int | None = None
        # Use parse_line_starts for the paren scan (parse_sql may differ from raw).
        ren_start_line = max(0, (_raw_line or 1) - 1)
        search_from = parse_line_starts[min(ren_start_line, len(parse_line_starts) - 1)]
        open_idx = parse_sql.find("(", search_from)
        if open_idx >= 0:
            depth = 0
            for idx in range(open_idx, len(parse_sql)):
                if parse_sql[idx] == "(":
                    depth += 1
                elif parse_sql[idx] == ")":
                    depth -= 1
                    if depth == 0:
                        close_line_0 = parse_offset_to_line(idx)
                        end_line = to_raw_line(close_line_0)
                        # +1 so endCol is the exclusive end, consistent with all other tokens.
                        end_col = idx - parse_line_starts[close_line_0] + 1
                        break

        columns: list[dict[str, Any]] = []
        select_node = cte_node.find(exp.Select)
        if select_node:
            for proj in select_node.expressions:
                col = getattr(proj, "alias_or_name", None)
                if col:
                    col_line = to_raw_line(_projection_line(proj))
                    columns.append({"name": col, "line": col_line})

        cte_entry: dict[str, Any] = {
            "name": cte_name,
            "line": start_line,
            "endLine": end_line,
            "columns": columns,
        }
        if start_col is not None:
            cte_entry["col"] = start_col
        if end_col is not None:
            cte_entry["endCol"] = end_col
        ctes.append(cte_entry)

    # ------------------------------------------------------------------
    # Qualify — resolve bare column references to their source table/alias.
    # Run before build_scope so the scope tree is built on the prepared AST.
    # ------------------------------------------------------------------
    caller_schema: dict[str, Any] = request.get("schema", {})
    try:
        from sqlglot.optimizer.qualify import (  # type: ignore[import-not-found]
            qualify,
        )

        ast = qualify(
            ast,
            schema=caller_schema,
            infer_schema=True,
            dialect=sqlglot_dialect,
            quote_identifiers=False,
            validate_qualify_columns=False,
        )
    except Exception:
        pass  # best-effort — fall back to unqualified columns

    # ------------------------------------------------------------------
    # Build scope + capture warnings.
    # sqlglot uses Python's logging module (not warnings.warn), so we install a
    # temporary logging.Handler to intercept WARNING-level messages before they
    # reach stderr.  These indicate structural SQL issues (e.g. "Cannot traverse
    # scope X with type Aliases") that dbt won't catch at parse time; we surface
    # them as diagnostics in the Problems tab.
    # ------------------------------------------------------------------
    final_columns: list[dict[str, Any]] = []
    scope_aliases: dict[str, list[str]] = {}
    sqlglot_warnings: list[dict[str, Any]] = []
    try:
        import logging as _logging_mod

        _captured_log_messages: list[str] = []

        class _LogCapture(_logging_mod.Handler):
            def emit(self, record: _logging_mod.LogRecord) -> None:
                if record.levelno == _logging_mod.WARNING:
                    _captured_log_messages.append(record.getMessage())

        _sqlglot_logger = _logging_mod.getLogger("sqlglot")
        _capture_handler = _LogCapture()
        _sqlglot_logger.addHandler(_capture_handler)
        try:
            root_scope = build_scope(ast)
        finally:
            _sqlglot_logger.removeHandler(_capture_handler)

        _seen_scope_names: set[str] = set()
        for msg in _captured_log_messages:
            # Extract the CTE / scope name from the warning message so we can
            # point the diagnostic at the right line in the document.
            # Message format: "Cannot traverse scope <name> AS () with type <type>"
            # sqlglot may emit the same warning multiple times (once per traversal
            # pass), so deduplicate by scope name.
            _scope_name: str | None = None
            _cte_line: int | None = None
            _scope_match = re.search(r'Cannot traverse scope "?([^"<>\s]+)"? AS', msg)
            if _scope_match:
                _scope_name = _scope_match.group(1)
                _scope_name_lc = str(_scope_name).lower()
                if _scope_name_lc in _seen_scope_names:
                    continue
                _seen_scope_names.add(_scope_name_lc)
                # Look up the CTE line we already recorded
                for _cte in ctes:
                    if _cte["name"].lower() == _scope_name_lc:
                        _cte_line = _cte["line"]
                        break
            entry: dict[str, Any] = {"type": "scope_warning", "message": msg}
            if _scope_name:
                entry["cteName"] = _scope_name
            if _cte_line is not None:
                entry["line"] = _cte_line
            sqlglot_warnings.append(entry)

        # Re-parse with ErrorLevel.RAISE to get structured error positions.
        # Always runs: enriches scope warnings with exact positions AND captures
        # standalone syntax errors (e.g. a typo in a column name) that build_scope
        # never sees because the first parse (ErrorLevel.IGNORE) swallowed them.
        try:
            from sqlglot.errors import (
                ErrorLevel as _EL,  # type: ignore[import-not-found]
            )

            parse_one(parse_sql, dialect=sqlglot_dialect, error_level=_EL.RAISE)
        except Exception as _rerr:
            if hasattr(_rerr, "errors"):
                _matched_idxs: set[int] = set()
                # Pass 1: enrich existing scope warnings with exact token positions.
                for _warn in sqlglot_warnings:
                    _cte_name = (_warn.get("cteName") or "").lower()
                    for _i, _ed in enumerate(_rerr.errors):  # type: ignore[union-attr]
                        if (_ed.get("highlight") or "").lower() != _cte_name:
                            continue
                        _matched_idxs.add(_i)
                        _sc = (_ed.get("start_context") or "").rstrip()
                        _bad_match = re.search(r"\b(\w+)\s*$", _sc)
                        if not _bad_match:
                            break
                        _bad_tok = _bad_match.group(1)
                        _err_line_1b = _ed.get("line") or 1
                        _search_end = parse_line_starts[
                            min(_err_line_1b - 1, len(parse_line_starts) - 1)
                        ]
                        _bt_re = re.search(
                            r"\b" + re.escape(_bad_tok) + r"\b",
                            parse_sql[:_search_end],
                            re.IGNORECASE,
                        )
                        if _bt_re:
                            _ts = _bt_re.start()
                            _tl = parse_offset_to_line(_ts)
                            _tc = _ts - parse_line_starts[_tl]
                            _warn["line"] = to_raw_line(_tl)
                            _warn["col"] = _tc
                            _warn["endCol"] = _tc + len(_bad_tok)
                        break
                # Pass 2: add unmatched parse errors as standalone syntax errors.
                for _i, _ed in enumerate(_rerr.errors):  # type: ignore[union-attr]
                    if _i in _matched_idxs:
                        continue
                    _highlight = _ed.get("highlight") or ""
                    _start_ctx = _ed.get("start_context") or ""
                    # Skip errors caused by Jinja stubs — a macro like
                    # {{generic_is_deleted(...)}} is rendered to "__jinja__" which
                    # is a bare identifier in statement-level positions.  The error
                    # is a false positive; the real dbt-rendered SQL would be valid.
                    if _SQL_STUB in _highlight or _SQL_STUB in _start_ctx:
                        continue
                    _err_line_1b = _ed.get("line") or 1
                    _err_col_1b = _ed.get("col") or 1
                    _line_0 = to_raw_line(_err_line_1b - 1)
                    # token.col is 1-based inclusive end, which equals 0-based
                    # exclusive end.  Backtrack by len(highlight) to get the
                    # 0-based start column.
                    _col_end_0 = _err_col_1b  # 0-based exclusive end
                    _col_0 = max(0, _col_end_0 - len(_highlight))
                    sqlglot_warnings.append(
                        {
                            "type": "syntax_error",
                            "message": _ed.get("description") or str(_rerr),
                            "line": _line_0,
                            "col": _col_0,
                            "endCol": _col_end_0,
                        }
                    )

        if root_scope:
            sel = (
                root_scope.expression
                if isinstance(root_scope.expression, exp.Select)
                else root_scope.expression.find(exp.Select)
            )
            if sel:
                for proj in sel.expressions:
                    col = getattr(proj, "alias_or_name", None)
                    if col:
                        final_columns.append(
                            {"name": col, "line": to_raw_line(_projection_line(proj))}
                        )
        # Alias resolution — replaces the separate get_scope_columns round-trip.
        scope_aliases = (
            _aliases_from_scope(root_scope, request.get("schema_mapping", {}))
            if root_scope
            else {}
        )
    except Exception:
        pass

    # ------------------------------------------------------------------
    # Token extraction — emit every Column and Table reference with
    # precise line/col positions so the extension can resolve cursor
    # positions directly from the AST without text pattern matching.
    # ------------------------------------------------------------------
    tokens: list[dict[str, Any]] = []
    for col_node in ast.find_all(exp.Column):
        col_id = col_node.this
        if not isinstance(col_id, exp.Identifier):
            continue
        raw_line_1 = col_id.meta.get("line")
        raw_col_1 = col_id.meta.get("col")
        if not raw_line_1 or not raw_col_1:
            continue
        col_name = col_id.this
        end_col_0 = (
            raw_col_1  # 0-based exclusive end (sqlglot col is 1-based inclusive end)
        )
        start_col_0 = end_col_0 - len(col_name)
        token_entry: dict[str, Any] = {
            "type": "column_ref",
            "name": col_name,
            "line": to_raw_line(raw_line_1 - 1),
            "col": start_col_0,
            "endCol": end_col_0,
        }
        # Add table/alias qualifier if present (e.g. the `o` in `o.order_id`)
        tbl_id = col_node.args.get("table")
        if isinstance(tbl_id, exp.Identifier):
            token_entry["table"] = tbl_id.this
            tbl_line_1 = tbl_id.meta.get("line")
            tbl_col_1 = tbl_id.meta.get("col")
            if tbl_line_1 and tbl_col_1:
                tbl_end_0 = tbl_col_1
                tbl_start_0 = tbl_end_0 - len(tbl_id.this)
                token_entry["tableLine"] = to_raw_line(tbl_line_1 - 1)
                token_entry["tableCol"] = tbl_start_0
                token_entry["tableEndCol"] = tbl_end_0
        tokens.append(token_entry)

    for alias_node in ast.find_all(exp.Alias):
        alias_id = alias_node.args.get("alias")
        if not isinstance(alias_id, exp.Identifier):
            continue
        raw_line_1 = alias_id.meta.get("line")
        raw_col_1 = alias_id.meta.get("col")
        if not raw_line_1 or not raw_col_1:
            continue
        alias_name = alias_id.this
        end_col_0 = raw_col_1
        start_col_0 = end_col_0 - len(alias_name)
        tokens.append(
            {
                "type": "column_def",
                "name": alias_name,
                "line": to_raw_line(raw_line_1 - 1),
                "col": start_col_0,
                "endCol": end_col_0,
            }
        )

    table_alias_map: dict[str, str] = {}
    for tbl_node in ast.find_all(exp.Table):
        tbl_id = tbl_node.this
        if not isinstance(tbl_id, exp.Identifier):
            continue
        tbl_name = tbl_id.this
        raw_line_1 = tbl_id.meta.get("line")
        raw_col_1 = tbl_id.meta.get("col")
        if not raw_line_1 or not raw_col_1:
            continue
        end_col_0 = raw_col_1  # 0-based exclusive end
        start_col_0 = end_col_0 - len(tbl_name)
        line_0 = to_raw_line(raw_line_1 - 1)
        # If this table came from a jinja ref(), extend endCol to cover the }} tag.
        jinja_end = _jinja_ref_end.get((line_0, start_col_0))
        token_entry = {
            "type": "table_ref",
            "name": tbl_name,
            "line": line_0,
            "col": start_col_0,
            "endCol": jinja_end if jinja_end is not None else end_col_0,
        }
        alias_node = tbl_node.args.get("alias")
        if isinstance(alias_node, exp.TableAlias):
            alias_id = alias_node.this
            if isinstance(alias_id, exp.Identifier):
                a_line_1 = alias_id.meta.get("line")
                a_col_1 = alias_id.meta.get("col")
                # Only real (user-written) aliases have source position metadata.
                # qualify() injects synthetic self-aliases with no position — skip.
                if a_line_1 and a_col_1:
                    a_name = alias_id.this
                    a_end_0 = a_col_1
                    a_start_0 = a_end_0 - len(a_name)
                    token_entry["alias"] = a_name
                    token_entry["aliasLine"] = to_raw_line(a_line_1 - 1)
                    token_entry["aliasCol"] = a_start_0
                    token_entry["aliasEndCol"] = a_end_0
                    table_alias_map[tbl_name.lower()] = a_name
        tokens.append(token_entry)

    # Annotate refs/sources/ctes with table aliases from the map built above.
    for cte in ctes:
        ast_alias = table_alias_map.get(cte["name"].lower())
        if ast_alias:
            cte["alias"] = ast_alias
    for ref in refs:
        ast_alias = table_alias_map.get(ref["model"].lower())
        if ast_alias:
            ref["alias"] = ast_alias
    for src in sources:
        ast_alias = table_alias_map.get(src["tableName"].lower())
        if ast_alias:
            src["alias"] = ast_alias

    # Post-processing: for each column_ref with a table qualifier, embed the
    # resolved table_ref object directly so providers never need to search.
    # Strategy: constrain candidates to the same CTE scope as the column_ref,
    # then pick the closest-preceding table_ref with a matching alias.
    # This prevents a same-named alias in an outer/earlier CTE from being
    # mistakenly chosen when the alias is re-used inside a different CTE.
    _table_refs = [t for t in tokens if t["type"] == "table_ref" and "alias" in t]
    for tok in tokens:
        if tok["type"] != "column_ref" or "table" not in tok:
            continue
        qualifier_lc = tok["table"].lower()
        col_line = tok["line"]

        # Find the CTE body that contains this column_ref (if any).
        containing_cte = next(
            (c for c in ctes if c["line"] <= col_line <= c["endLine"]),
            None,
        )

        # Filter candidates to the same CTE scope, then fall back to global.
        if containing_cte is not None:
            scope_refs = [
                tr
                for tr in _table_refs
                if containing_cte["line"] <= tr["line"] <= containing_cte["endLine"]
            ]
        else:
            # column_ref is in the final SELECT (outside all CTEs)
            scope_refs = [
                tr
                for tr in _table_refs
                if all(
                    tr["line"] < c["line"] or tr["line"] > c["endLine"] for c in ctes
                )
            ]

        best: dict[str, Any] | None = None
        for tr in scope_refs:
            if tr.get("alias", "").lower() != qualifier_lc:
                continue
            if tr["line"] > col_line:
                continue
            if best is None or tr["line"] > best["line"]:
                best = tr
        if best is None:
            # fallback: any alias match in scope (e.g. alias defined after column)
            for tr in scope_refs:
                if tr.get("alias", "").lower() == qualifier_lc:
                    best = tr
                    break
        if best is not None:
            tok["resolvedTableRef"] = best

    total_ms = (time.perf_counter() - t0) * 1000

    print(
        json.dumps(
            {
                "success": True,
                "ctes": ctes,
                "refs": refs,
                "sources": sources,
                "finalColumns": final_columns,
                "tokens": tokens,
                "aliases": scope_aliases,
                "sqlglotWarnings": sqlglot_warnings,
                "timing": {
                    "parseMs": round(parse_ms, 2),
                    "totalMs": round(total_ms, 2),
                },
            }
        ),
        flush=True,
    )


def handle_get_column_lineage(request: dict[str, Any]) -> None:
    """Handle a get_column_lineage request and print the JSON response."""
    compiled_sql: str = request.get("compiled_sql", "")
    column_name: str = request.get("column_name", "")
    schema_mapping: dict[str, Any] = request.get("schema_mapping", {})
    dialect: str = request.get("dialect", "ansi")

    if not compiled_sql or not column_name:
        print(
            json.dumps(
                {
                    "success": False,
                    "error": "compiled_sql and column_name are required",
                }
            ),
            flush=True,
        )
        return

    try:
        result = _trace_column_lineage(
            compiled_sql, column_name, schema_mapping, dialect
        )
        print(
            json.dumps({"success": True, **result}),
            flush=True,
        )
    except Exception as exc:
        print(
            json.dumps(
                {
                    "success": False,
                    "error": str(exc),
                    "dependencies": [],
                    "via_ctes": [],
                    "transformations": [],
                }
            ),
            flush=True,
        )


def handle_get_columns(request: dict[str, Any]) -> None:
    """Handle a get_columns request and print the JSON response."""
    compiled_sql: str = request.get("compiled_sql", "")
    schema_mapping: dict[str, Any] = request.get("schema_mapping", {})
    dialect: str = request.get("dialect", "ansi")

    if not compiled_sql:
        print(json.dumps({"success": True, "columns": []}), flush=True)
        return

    try:
        columns = _get_output_columns(compiled_sql, dialect, schema_mapping)
        print(json.dumps({"success": True, "columns": columns}), flush=True)
    except Exception as exc:
        print(
            json.dumps({"success": True, "columns": [], "warning": str(exc)}),
            flush=True,
        )


def main() -> None:
    configure_stdio()
    configure_dbt_env()

    # Determine project directory (passed via env var set by the extension)
    project_dir = os.environ.get("DBT_PROJECT_DIR", os.getcwd())
    profiles_dir = resolve_profiles_dir(project_dir)

    # dbt is lazy-loaded — only imported/instantiated when a request that
    # actually needs it arrives (command, describe_table).
    # This lets the bridge start and serve parse_document / get_column_lineage
    # requests even in Python environments without dbt installed.
    dbt: Any = None

    _dbt_unavailable = False

    def get_dbt() -> Any:
        nonlocal dbt, _dbt_unavailable
        if _dbt_unavailable:
            return None
        if dbt is None:
            runner_class = import_dbt_runner()
            if runner_class is None:
                _dbt_unavailable = True
                return None
            dbt = runner_class()
        return dbt

    # Signal ready
    print(json.dumps({"type": "ready"}), flush=True)

    # Event loop: read commands from stdin, execute, send completion marker
    while True:
        try:
            line = sys.stdin.readline()
        except (EOFError, KeyboardInterrupt):
            break

        if not line:
            # EOF — parent process closed stdin
            break

        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            error = {"type": "error", "error": f"Invalid JSON: {exc}"}
            print(json.dumps(error), flush=True)
            continue

        # Shutdown signal
        if request.get("shutdown"):
            break

        # Dispatch by request type
        if "parse_document" in request:
            handle_parse_document(request)
        elif "get_column_lineage" in request:
            handle_get_column_lineage(request)
        elif "describe_table" in request:
            d = get_dbt()
            if d is None:
                print(
                    json.dumps({"success": False, "error": "dbt not available"}),
                    flush=True,
                )
                continue
            handle_describe_table(request, d, project_dir, profiles_dir)
        elif "compile_inline" in request:
            d = get_dbt()
            if d is None:
                print(
                    json.dumps({"success": False, "error": "dbt not available"}),
                    flush=True,
                )
                continue
            handle_compile_inline(request, d, project_dir, profiles_dir)
        elif "get_columns" in request:
            handle_get_columns(request)
        elif "command" in request:
            command_args: list = request["command"]
            if not command_args:
                print(
                    json.dumps({"success": False, "error": "Empty command"}), flush=True
                )
                continue
            d = get_dbt()
            if d is None:
                print(
                    json.dumps({"success": False, "error": "dbt not available"}),
                    flush=True,
                )
                continue
            success = run_command(d, list(command_args), project_dir, profiles_dir)
            print(json.dumps({"success": success}), flush=True)
        else:
            print(
                json.dumps({"success": False, "error": "Unknown request type"}),
                flush=True,
            )


if __name__ == "__main__":
    main()
