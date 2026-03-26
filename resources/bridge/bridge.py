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
        "ctes": [{"name": str, "line": int, "endLine": int, "columns": [{"name": str, "line": int}]}],
        "refs": [{"model": str, "line": int}],
        "sources": [{"sourceName": str, "tableName": str, "line": int}],
        "finalColumns": [{"name": str, "line": int}],
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

    # Extract refs/sources from raw Jinja SQL (they live inside Jinja tags and
    # would disappear from any preprocessed version).
    ref_re = re.compile(r"ref\(\s*['\"]([^'\"]+)['\"]\s*\)")
    source_re = re.compile(
        r"source\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)"
    )
    refs: list[dict[str, Any]] = [
        {"model": m.group(1), "line": offset_to_line(m.start())}
        for m in ref_re.finditer(raw_sql)
    ]
    sources: list[dict[str, Any]] = [
        {
            "sourceName": m.group(1),
            "tableName": m.group(2),
            "line": offset_to_line(m.start()),
        }
        for m in source_re.finditer(raw_sql)
    ]

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
        # sqlglot line numbers are 1-based; convert to 0-based, then map to raw.
        start_line = to_raw_line(max(0, (_raw_line or 1) - 1))

        # Walk parse_sql from start of the CTE's line to find the opening '('
        # then scan for its matching ')' to determine end_line.
        end_line = start_line
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
                        end_line = to_raw_line(parse_offset_to_line(idx))
                        break

        columns: list[dict[str, Any]] = []
        select_node = cte_node.find(exp.Select)
        if select_node:
            for proj in select_node.expressions:
                col = getattr(proj, "alias_or_name", None)
                if col:
                    col_line = to_raw_line(_projection_line(proj))
                    columns.append({"name": col, "line": col_line})

        ctes.append(
            {
                "name": cte_name,
                "line": start_line,
                "endLine": end_line,
                "columns": columns,
            }
        )

    # Final output columns from the root SELECT (outside any CTE).
    final_columns: list[dict[str, Any]] = []
    try:
        root_scope = build_scope(ast)
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
    except Exception:
        pass

    # Annotate refs/sources with table aliases from the sqlglot AST.
    # _blank_jinja maps {{ ref('model') }} → the model name as an identifier,
    # so sqlglot sees a real Table node with an optional alias (e.g. `orders o`).
    # Build a table-name → alias map from every Table node in the AST and use
    # it to populate the alias field on refs and sources.
    table_alias_map: dict[str, str] = {}
    for tbl in ast.find_all(exp.Table):
        if tbl.alias:
            table_alias_map[tbl.name.lower()] = tbl.alias
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

    # ------------------------------------------------------------------
    # Token extraction — emit every Column and Table reference with
    # precise line/col positions so the extension can resolve cursor
    # positions directly from the AST without text pattern matching.
    #
    # sqlglot meta["line"] is 1-based; meta["col"] is the 1-based
    # exclusive-end character offset.  We convert both to 0-based
    # for the extension (line is start, col/endCol are char offsets).
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
        end_col_0 = raw_col_1 - 1  # 0-based exclusive end
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
                tbl_name = tbl_id.this
                tbl_end_0 = tbl_col_1 - 1
                tbl_start_0 = tbl_end_0 - len(tbl_name)
                token_entry["tableLine"] = to_raw_line(tbl_line_1 - 1)
                token_entry["tableCol"] = tbl_start_0
                token_entry["tableEndCol"] = tbl_end_0
        tokens.append(token_entry)

    for tbl_node in ast.find_all(exp.Table):
        tbl_id = tbl_node.this
        if not isinstance(tbl_id, exp.Identifier):
            continue
        raw_line_1 = tbl_id.meta.get("line")
        raw_col_1 = tbl_id.meta.get("col")
        if not raw_line_1 or not raw_col_1:
            continue
        tbl_name = tbl_id.this
        end_col_0 = raw_col_1 - 1
        start_col_0 = end_col_0 - len(tbl_name)
        token_entry = {
            "type": "table_ref",
            "name": tbl_name,
            "line": to_raw_line(raw_line_1 - 1),
            "col": start_col_0,
            "endCol": end_col_0,
        }
        alias_node = tbl_node.args.get("alias")
        if isinstance(alias_node, exp.TableAlias):
            alias_id = alias_node.this
            if isinstance(alias_id, exp.Identifier):
                token_entry["alias"] = alias_id.this
                a_line_1 = alias_id.meta.get("line")
                a_col_1 = alias_id.meta.get("col")
                if a_line_1 and a_col_1:
                    a_name = alias_id.this
                    a_end_0 = a_col_1 - 1
                    a_start_0 = a_end_0 - len(a_name)
                    token_entry["aliasLine"] = to_raw_line(a_line_1 - 1)
                    token_entry["aliasCol"] = a_start_0
                    token_entry["aliasEndCol"] = a_end_0
        tokens.append(token_entry)

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

    # Determine project directory (passed via env var set by the extension)
    project_dir = os.environ.get("DBT_PROJECT_DIR", os.getcwd())
    profiles_dir = resolve_profiles_dir(project_dir)

    # dbt is lazy-loaded — only imported/instantiated when a request that
    # actually needs it arrives (command, describe_table, run_cte_test).
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
        elif "get_scope_columns" in request:
            handle_get_scope_columns(request)
        elif "describe_table" in request:
            d = get_dbt()
            if d is None:
                print(
                    json.dumps({"success": False, "error": "dbt not available"}),
                    flush=True,
                )
                continue
            handle_describe_table(request, d, project_dir, profiles_dir)
        elif "get_columns" in request:
            handle_get_columns(request)
        elif "run_cte_test" in request:
            d = get_dbt()
            if d is None:
                print(
                    json.dumps({"success": False, "error": "dbt not available"}),
                    flush=True,
                )
                continue
            handle_run_cte_test(request, project_dir, profiles_dir, d)
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
