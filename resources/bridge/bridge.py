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

import csv
import hashlib
import json
import os
import re
import shutil
import sys
from io import StringIO
from pathlib import Path

# Prepend vendored dependencies (sqlglot) bundled with the extension.
# This ensures bridge.py works regardless of what the user's project has installed.
_VENDOR_DIR = os.path.join(os.path.dirname(__file__), "vendor")
if os.path.isdir(_VENDOR_DIR) and _VENDOR_DIR not in sys.path:
    sys.path.insert(0, _VENDOR_DIR)
from typing import Any


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
    """Import dbtRunner, or exit with a structured error if dbt is not installed."""
    try:
        from dbt.cli.main import dbtRunner  # type: ignore[import-not-found]

        return dbtRunner
    except ImportError as exc:
        error = {
            "type": "error",
            "error": f"dbt is not installed in this Python environment: {exc}",
        }
        print(json.dumps(error), flush=True)
        sys.exit(1)


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


def _get_scope_columns(
    sql: str,
    dialect: str,
    schema_mapping: dict[str, Any],
) -> dict[str, list[str]]:
    """Return {alias: [col, ...]} for every alias/CTE reachable in the SQL.

    Walks all scopes (root + CTEs) built by sqlglot and resolves each alias to
    its column list — either from the CTE's own projections, or from the
    schema_mapping for external table references.
    """
    try:
        from sqlglot import exp, parse_one  # type: ignore[import-not-found]
        from sqlglot.optimizer.scope import (
            build_scope,  # type: ignore[import-not-found]
        )
    except ImportError:
        return {}

    try:
        ast = parse_one(sql, dialect=dialect)
    except Exception:
        return {}

    root_scope = build_scope(ast)
    if not root_scope:
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

    # Walk all scopes (root + nested CTEs / subqueries)
    for scope in root_scope.traverse():
        # Register CTE definitions — CTE name → its output columns
        if hasattr(scope, "cte_scopes"):
            for cte_scope in scope.cte_scopes:
                cte_name = cte_scope.expression.parent.alias
                if cte_name:
                    cols = _cols_from_scope_select(cte_scope)
                    if cols:
                        aliases[cte_name] = cols

        # Register selected sources — alias → columns
        for alias, (_, source) in scope.selected_sources.items():
            if alias in aliases:
                # Already resolved (e.g. CTE name), skip re-resolving
                continue
            if isinstance(source, exp.Table):
                # External table: first try schema_mapping, then check if alias
                # matches a CTE we already resolved
                table_name = source.name
                cols = _find_table_columns(schema_mapping, table_name)
                if cols:
                    aliases[alias] = cols
                    # Also register the unaliased table name
                    if alias != table_name.lower():
                        aliases[table_name.lower()] = cols
                elif table_name in aliases:
                    # Table name matches a CTE — propagate for the alias
                    aliases[alias] = aliases[table_name]
            else:
                # CTE/subquery reference — read its projection
                cols = (
                    _cols_from_scope_select(source)
                    if hasattr(source, "expression")
                    else []
                )
                if not cols and hasattr(source, "expression"):
                    # Try via parent alias (CTE name)
                    parent = getattr(source.expression, "parent", None)
                    parent_alias = getattr(parent, "alias", None) if parent else None
                    if parent_alias and parent_alias in aliases:
                        cols = aliases[parent_alias]
                if cols:
                    aliases[alias] = cols

    return aliases


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
                for potential_ref in expr_str.split():
                    if "." in potential_ref:
                        ref_name = potential_ref.split(".")[0].strip("(),")
                        if ref_name and not ref_name.isdigit():
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
    last_error: BaseException | None = None
    for attempt in range(3):
        try:
            result = lineage(
                column=column_name,
                sql=wrapped_ast,
                schema=schema_mapping,
                dialect=dialect,
            )
            break
        except (IndexError, SqlglotError) as exc:
            last_error = exc
            if attempt < 2:
                wrapped_ast = _clean_static_union_branches(
                    wrapped_ast, column_name, dialect
                )

    if result is None:
        raise last_error or RuntimeError(
            f"Could not trace lineage for column '{column_name}'"
        )

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
            if hasattr(node.source, "db") and node.source.db:
                dep["schema"] = str(node.source.db).strip('"')
            if hasattr(node.source, "catalog") and node.source.catalog:
                dep["database"] = str(node.source.catalog).strip('"')
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


def handle_get_scope_columns(request: dict[str, Any]) -> None:
    """Handle a get_scope_columns request and print the JSON response."""
    sql: str = request.get("sql", "")
    schema_mapping: dict[str, Any] = request.get("schema_mapping", {})
    dialect: str = request.get("dialect", "ansi")

    if not sql:
        print(json.dumps({"success": True, "aliases": {}}), flush=True)
        return

    try:
        aliases = _get_scope_columns(sql, dialect, schema_mapping)
        print(json.dumps({"success": True, "aliases": aliases}), flush=True)
    except Exception as exc:
        print(
            json.dumps({"success": True, "aliases": {}, "warning": str(exc)}),
            flush=True,
        )


# ---------------------------------------------------------------------------
# CTE test support — ported from dbt-core-mcp cte_generator.py
# ---------------------------------------------------------------------------


def _cte_rows_to_sql(
    rows: list[dict[str, Any]], columns: list[str] | None = None
) -> str:
    """Convert list of row dicts to SQL SELECT statements joined by UNION ALL."""
    if columns is None:
        cols_union: set[str] = set()
        for row in rows:
            cols_union.update(row.keys())
        columns = sorted(cols_union)

    if not columns:
        return "SELECT NULL WHERE FALSE"

    if not rows:
        col_exprs = [f"NULL as {c}" for c in columns]
        return f"SELECT {', '.join(col_exprs)} WHERE 1=0"

    selects = []
    for row in rows:
        exprs = []
        for col in columns:
            v = row.get(col)
            if v is None:
                exprs.append(f"NULL as {col}")
            elif isinstance(v, str):
                if v.isdigit() or (v.replace(".", "", 1).replace("-", "", 1).isdigit()):
                    exprs.append(f"{v} as {col}")
                else:
                    escaped = v.replace("'", "''")
                    exprs.append(f"'{escaped}' as {col}")
            else:
                exprs.append(f"{v} as {col}")
        selects.append(f"SELECT {', '.join(exprs)}")

    return "\nUNION ALL\n".join(selects)


def _cte_parse_csv_fixture(csv_text: str) -> tuple[list[str], list[dict[str, Any]]]:
    """Parse a csv fixture string into (columns, rows_as_dicts)."""
    sio = StringIO(csv_text.strip("\n"))
    reader = csv.DictReader(line for line in sio if line.strip() != "")
    columns = list(reader.fieldnames) if reader.fieldnames else []
    rows = [dict(row) for row in reader]
    return columns, rows


def _cte_is_position_in_comment(sql: str, pos: int) -> bool:
    """Check if a position in SQL is inside a comment (SQL or Jinja)."""
    line_start = sql.rfind("\n", 0, pos) + 1
    line_content = sql[line_start:pos]
    if "--" in line_content:
        return True

    block_comment_depth = 0
    jinja_comment_depth = 0
    i = 0
    while i < pos:
        if i + 1 < len(sql):
            two_char = sql[i : i + 2]
            if two_char == "/*":
                block_comment_depth += 1
                i += 2
                continue
            elif two_char == "*/":
                block_comment_depth -= 1
                i += 2
                continue
            elif two_char == "{#":
                jinja_comment_depth += 1
                i += 2
                continue
            elif two_char == "#}":
                jinja_comment_depth -= 1
                i += 2
                continue
        i += 1

    return block_comment_depth > 0 or jinja_comment_depth > 0


def _cte_replace_cte_with_mock(
    sql: str,
    cte_name: str,
    rows: list[dict[str, Any]],
    columns: list[str] | None = None,
) -> str:
    """Replace a CTE definition with a mocked version from fixture rows."""
    pattern = rf"\b{cte_name}\s+as\s*\("
    matches = list(re.finditer(pattern, sql, re.IGNORECASE))

    if not matches:
        return sql

    match = None
    for m in matches:
        if not _cte_is_position_in_comment(sql, m.start()):
            match = m
            break

    if not match:
        return sql

    paren_pos = sql.index("(", match.start())
    paren_count = 1
    end_pos = paren_pos + 1
    in_string = False
    string_char = None
    in_line_comment = False
    in_block_comment = False

    while end_pos < len(sql) and paren_count > 0:
        char = sql[end_pos]
        next_char = sql[end_pos + 1] if end_pos + 1 < len(sql) else ""

        if not in_string and not in_block_comment and char == "-" and next_char == "-":
            in_line_comment = True
            end_pos += 2
            continue

        if in_line_comment:
            if char == "\n":
                in_line_comment = False
            end_pos += 1
            continue

        if not in_string and not in_line_comment and char == "/" and next_char == "*":
            in_block_comment = True
            end_pos += 2
            continue

        if in_block_comment:
            if char == "*" and next_char == "/":
                in_block_comment = False
                end_pos += 2
            else:
                end_pos += 1
            continue

        if char in ('"', "'"):
            if not in_string:
                in_string = True
                string_char = char
            elif char == string_char:
                in_string = False
                string_char = None

        if not in_string and not in_line_comment and not in_block_comment:
            if char == "(":
                paren_count += 1
            elif char == ")":
                paren_count -= 1

        end_pos += 1

    mock_sql = _cte_rows_to_sql(rows, columns=columns)
    mocked_cte = f"{cte_name} AS (\n    {mock_sql}\n)"
    original_cte = sql[match.start() : end_pos]
    return sql.replace(original_cte, mocked_cte)


def _cte_generate_model(
    base_model_path: Path,
    cte_name: str,
    test_given: list[dict[str, Any]],
    output_path: Path,
) -> bool:
    """Generate a truncated model that selects from the target CTE."""
    sql = base_model_path.read_text()

    pattern = rf"\b{re.escape(cte_name)}(?:\s+AS)?\s+\("
    matches = list(re.finditer(pattern, sql, re.IGNORECASE))

    if not matches:
        print(
            f"[bridge] CTE '{cte_name}' not found in {base_model_path}",
            file=sys.stderr,
            flush=True,
        )
        return False

    match = None
    for m in matches:
        if not _cte_is_position_in_comment(sql, m.start()):
            match = m
            break

    if not match:
        print(
            f"[bridge] CTE '{cte_name}' only in comments", file=sys.stderr, flush=True
        )
        return False

    paren_pos = sql.index("(", match.start())
    paren_count = 1
    i = paren_pos + 1
    in_string = False
    string_char = None
    in_line_comment = False
    in_block_comment = False

    while i < len(sql) and paren_count > 0:
        char = sql[i]
        next_char = sql[i + 1] if i + 1 < len(sql) else ""

        if not in_string and not in_block_comment and char == "-" and next_char == "-":
            in_line_comment = True
            i += 2
            continue

        if in_line_comment:
            if char == "\n":
                in_line_comment = False
            i += 1
            continue

        if not in_string and not in_line_comment and char == "/" and next_char == "*":
            in_block_comment = True
            i += 2
            continue

        if in_block_comment:
            if char == "*" and next_char == "/":
                in_block_comment = False
                i += 2
            else:
                i += 1
            continue

        if char in ('"', "'") and (i == 0 or sql[i - 1] != "\\"):
            if not in_string:
                in_string = True
                string_char = char
            elif char == string_char:
                in_string = False
                string_char = None

        if not in_string and not in_line_comment and not in_block_comment:
            if char == "(":
                paren_count += 1
            elif char == ")":
                paren_count -= 1

        i += 1

    if paren_count != 0:
        print(
            f"[bridge] Unmatched paren for CTE '{cte_name}'",
            file=sys.stderr,
            flush=True,
        )
        return False

    upstream_sql = sql[:i].rstrip()

    for given in test_given:
        inp = given.get("input")
        if isinstance(inp, str) and inp.startswith("::"):
            mock_cte_name = inp.lstrip(":")
            fmt = given.get("format", "dict")
            if fmt == "csv":
                columns, mock_rows = _cte_parse_csv_fixture(given.get("rows", ""))
            else:
                columns, mock_rows = None, given.get("rows", [])
            upstream_sql = _cte_replace_cte_with_mock(
                upstream_sql, mock_cte_name, mock_rows, columns
            )

    generated_sql = f"{upstream_sql}\n\nselect * from {cte_name}"
    final_sql = f"-- sqlfluff:disable\n{generated_sql}"

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(final_sql)
    return True


def _cte_generate_test(
    test_yaml_path: Path,
    test_name: str,
    generated_model: str,
    gen_model_path: Path,
    output_path: Path,
) -> bool:
    """Generate an enabled test YAML targeting the generated model."""
    try:
        import yaml as _yaml  # noqa: PLC0415
    except ImportError:
        print(
            "[bridge] PyYAML not available — cannot generate CTE test YAML",
            file=sys.stderr,
            flush=True,
        )
        return False

    with open(test_yaml_path) as f:
        test_data = _yaml.safe_load(f)

    target_test = None
    for test in test_data.get("unit_tests", []):
        if test["name"] == test_name:
            target_test = test.copy()
            break

    if not target_test:
        print(
            f"[bridge] Test '{test_name}' not found in {test_yaml_path}",
            file=sys.stderr,
            flush=True,
        )
        return False

    generated_sql = gen_model_path.read_text()
    ref_pattern = r"ref\(['\"](\w+)['\"]\)"
    refs = re.findall(ref_pattern, generated_sql)
    source_pattern = r"source\(['\"](\w+)['\"],\s*['\"](\w+)['\"]\)"
    sources = re.findall(source_pattern, generated_sql)

    actually_used: set[str] = set()
    for ref_name in refs:
        actually_used.add(f"ref('{ref_name}')")
    for source_name, table_name in sources:
        actually_used.add(f"source('{source_name}', '{table_name}')")

    clean_given = [
        g for g in target_test.get("given", []) if g.get("input") in actually_used
    ]
    target_test["given"] = clean_given

    existing_inputs = {g.get("input", "") for g in target_test.get("given", [])}
    for ref_name in refs:
        ref_input = f"ref('{ref_name}')"
        if ref_input not in existing_inputs:
            target_test["given"].append({"input": ref_input, "rows": []})
            existing_inputs.add(ref_input)
    for source_name, table_name in sources:
        source_input = f"source('{source_name}', '{table_name}')"
        if source_input not in existing_inputs:
            target_test["given"].append({"input": source_input, "rows": []})
            existing_inputs.add(source_input)

    target_test["model"] = generated_model
    target_test.pop("config", None)

    output_data = {"version": 2, "unit_tests": [target_test]}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        _yaml.safe_dump(
            output_data, f, default_flow_style=False, sort_keys=False, width=120
        )

    return True


def _cte_load_project_config(project_dir: Path) -> dict[str, Any]:
    """Load dbt_project.yml and return its configuration dict."""
    try:
        import yaml as _yaml  # noqa: PLC0415
    except ImportError:
        return {}
    project_file = project_dir / "dbt_project.yml"
    if not project_file.exists():
        return {}
    with open(project_file) as f:
        config = _yaml.safe_load(f)
    return config or {}


def _cte_find_model_file(
    base_model: str,
    yaml_path: Path,
    project_dir: Path,
    config: dict[str, Any],
) -> Path | None:
    """Locate the SQL model file for base_model by mirroring test-path structure onto model-paths."""
    model_paths = config.get("model-paths", ["models"])
    test_paths = config.get("test-paths", ["tests"])

    # Build list of candidate test root dirs (same logic as generate_cte_tests)
    test_roots: list[Path] = [project_dir / tp for tp in test_paths]
    unit_tests_dir = project_dir / "unit_tests"
    if unit_tests_dir.exists() and unit_tests_dir not in test_roots:
        test_roots.append(unit_tests_dir)

    # Determine relative path of yaml_path from whichever test root it belongs to
    rel_parent: Path | None = None
    for test_root in test_roots:
        try:
            rel = yaml_path.relative_to(test_root)
            rel_parent = rel.parent
            break
        except ValueError:
            continue

    models_base = project_dir / model_paths[0]

    if rel_parent is not None:
        candidate = models_base / rel_parent / f"{base_model}.sql"
        if candidate.exists():
            return candidate

    # Fallback: search recursively
    for found in models_base.rglob(f"{base_model}.sql"):
        return found

    return None


def handle_run_cte_test(
    request: dict[str, Any],
    project_dir: str,
    profiles_dir: str,
    dbt: Any,
) -> None:
    """Generate, run, and clean up a single CTE test.

    Request: { "run_cte_test": true, "yaml_file": "/abs/path.yml", "test_name": "name" }
    """
    try:
        import yaml as _yaml  # noqa: PLC0415
    except ImportError:
        print(
            json.dumps({"success": False, "error": "PyYAML not available"}), flush=True
        )
        return

    yaml_file = request.get("yaml_file", "")
    test_name = request.get("test_name", "")
    if not yaml_file or not test_name:
        print(
            json.dumps(
                {"success": False, "error": "yaml_file and test_name are required"}
            ),
            flush=True,
        )
        return

    yaml_path = Path(yaml_file)
    proj_dir = Path(project_dir)
    config = _cte_load_project_config(proj_dir)

    # Load YAML and find the test
    with open(yaml_path) as f:
        test_data = _yaml.safe_load(f)

    target_test = None
    for test in test_data.get("unit_tests", []):
        if test["name"] == test_name:
            target_test = test
            break

    if not target_test:
        print(
            json.dumps(
                {
                    "success": False,
                    "error": f"Test '{test_name}' not found in {yaml_file}",
                }
            ),
            flush=True,
        )
        return

    model_spec: str = target_test.get("model", "")
    if "::" not in model_spec:
        print(
            json.dumps(
                {
                    "success": False,
                    "error": f"model field '{model_spec}' missing '::' separator",
                }
            ),
            flush=True,
        )
        return

    base_model, cte_name = model_spec.split("::", 1)
    test_hash = hashlib.md5(test_name.encode()).hexdigest()[:6]
    gen_model_name = f"{base_model}__{cte_name}__{test_hash}"

    # Determine output dirs
    model_paths = config.get("model-paths", ["models"])
    gen_models_dir = proj_dir / model_paths[0] / "__cte_tests"

    if (proj_dir / "unit_tests").exists():
        gen_tests_dir = proj_dir / "unit_tests" / "__cte_tests"
    else:
        test_paths = config.get("test-paths", ["tests"])
        gen_tests_dir = proj_dir / test_paths[0] / "__cte_tests"

    gen_model_path = gen_models_dir / f"{gen_model_name}.sql"
    gen_test_path = gen_tests_dir / f"{gen_model_name}_unit_tests.yml"

    # Clean any leftovers first
    if gen_models_dir.exists():
        shutil.rmtree(gen_models_dir)
    if gen_tests_dir.exists():
        shutil.rmtree(gen_tests_dir)

    success = False
    try:
        # Find the model SQL file
        model_file = _cte_find_model_file(base_model, yaml_path, proj_dir, config)
        if not model_file:
            print(
                json.dumps(
                    {
                        "success": False,
                        "error": f"Model file for '{base_model}' not found",
                    }
                ),
                flush=True,
            )
            return

        # Generate model + test files
        if not _cte_generate_model(
            model_file, cte_name, target_test.get("given", []), gen_model_path
        ):
            print(
                json.dumps({"success": False, "error": "Failed to generate CTE model"}),
                flush=True,
            )
            return

        if not _cte_generate_test(
            yaml_path, test_name, gen_model_name, gen_model_path, gen_test_path
        ):
            print(
                json.dumps(
                    {"success": False, "error": "Failed to generate CTE test YAML"}
                ),
                flush=True,
            )
            return

        # Run the generated unit test
        success = run_command(
            dbt, ["test", "-s", gen_model_name], project_dir, profiles_dir
        )

    finally:
        # Always clean up generated files
        if gen_models_dir.exists():
            shutil.rmtree(gen_models_dir, ignore_errors=True)
        if gen_tests_dir.exists():
            shutil.rmtree(gen_tests_dir, ignore_errors=True)

    print(json.dumps({"success": success}), flush=True)


# ---------------------------------------------------------------------------
# End CTE test support
# ---------------------------------------------------------------------------


def main() -> None:
    configure_stdio()
    configure_dbt_env()

    dbtRunner = import_dbt_runner()

    # Determine project directory (passed via env var set by the extension)
    project_dir = os.environ.get("DBT_PROJECT_DIR", os.getcwd())
    profiles_dir = resolve_profiles_dir(project_dir)

    # Initialize dbtRunner once — expensive, so we keep it alive
    dbt = dbtRunner()

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
        if "get_column_lineage" in request:
            handle_get_column_lineage(request)
        elif "get_scope_columns" in request:
            handle_get_scope_columns(request)
        elif "describe_table" in request:
            handle_describe_table(request, dbt, project_dir, profiles_dir)
        elif "get_columns" in request:
            handle_get_columns(request)
        elif "run_cte_test" in request:
            handle_run_cte_test(request, project_dir, profiles_dir, dbt)
        elif "command" in request:
            command_args: list = request["command"]
            if not command_args:
                print(
                    json.dumps({"success": False, "error": "Empty command"}), flush=True
                )
                continue
            success = run_command(dbt, list(command_args), project_dir, profiles_dir)
            print(json.dumps({"success": success}), flush=True)
        else:
            print(
                json.dumps({"success": False, "error": "Unknown request type"}),
                flush=True,
            )


if __name__ == "__main__":
    main()
