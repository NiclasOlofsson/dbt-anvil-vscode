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
import sys

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
    """Trace column lineage using sqlglot.lineage().

    Returns upstream dependencies with CTE paths and transformations.

    Ported from dbt-core-mcp get_column_lineage._analyze_column_lineage
    and _extract_dependencies_from_lineage.
    """
    from sqlglot.lineage import lineage  # type: ignore[import-not-found]

    wrapped_ast = _wrap_final_select(compiled_sql, column_name, dialect)

    result = lineage(
        column=column_name,
        sql=wrapped_ast,
        schema=schema_mapping,
        dialect=dialect,
    )

    dependencies: list[dict[str, Any]] = []
    via_ctes: list[str] = []
    transformations: list[dict[str, str]] = []

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

        # Check if this is a source table (has database/schema/catalog on source)
        is_table = False
        if hasattr(node, "source"):
            source = node.source
            is_table = (
                hasattr(source, "catalog") or getattr(source, "db", None) is not None
            )

        if is_table and table_or_cte:
            # Extract database/schema from the source expression
            dep: dict[str, Any] = {"column": col, "table": table_or_cte}
            if hasattr(node.source, "db") and node.source.db:
                dep["schema"] = str(node.source.db).strip('"')
            if hasattr(node.source, "catalog") and node.source.catalog:
                dep["database"] = str(node.source.catalog).strip('"')
            dependencies.append(dep)
        elif table_or_cte and table_or_cte != "__lineage_final__":
            # CTE step
            if table_or_cte not in via_ctes:
                via_ctes.append(table_or_cte)
            transform: dict[str, str] = {"cte": table_or_cte, "column": col}
            if hasattr(node, "expression") and node.expression is not None:
                expr_sql = str(node.expression)
                if expr_sql and expr_sql.strip() != col:
                    if len(expr_sql) > 200:
                        expr_sql = expr_sql[:197] + "..."
                    transform["expression"] = expr_sql
            transformations.append(transform)

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
