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
                        or    {"describe_table": true, "name": "my_model"}
                        or    {"compile_inline": "SELECT * FROM {{ ref('my_model') }}"}
  Response: prints dbt output lines, then {"success": true/false, ...} on its own line
  Shutdown: reads {"shutdown": true} from stdin → exits cleanly
"""

import json
import os
import sys
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

    Returns None instead of exiting so the bridge can return a structured
    error response. Callers that need dbt must handle the None return.
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


def run_command(
    dbt, args: list, project_dir: str, profiles_dir: str, extension_target_path: str
) -> bool:
    """
    Invoke a dbt command. dbt output goes directly to stdout (print statements).
    Returns True if successful, False otherwise.
    """
    # Always inject --profiles-dir and --log-format unless caller provided them
    if "--target-path" not in args and (len(args) == 0 or args[0] not in ("deps",)):
        args = [*args, "--target-path", extension_target_path]
    if "--log-format" not in args and len(args) > 0 and args[0] not in ("deps",):
        args = [*args, "--log-format", "text"]
    # compile never needs warehouse introspection — skip the metastore scan.
    # --no-populate-cache is a global flag (before subcommand).
    # --no-introspect is a compile-specific flag (after subcommand).
    # --quiet suppresses the verbose progress/SQL dump output — the compiled result
    # is returned via the bridge JSON protocol, not from stdout log lines.
    if "compile" in args:
        compile_idx = args.index("compile")
        if "--no-populate-cache" not in args:
            args = ["--no-populate-cache", *args]
            compile_idx += 1  # offset by the prepended flag
        if "--no-introspect" not in args:
            args = [
                *args[: compile_idx + 1],
                "--no-introspect",
                *args[compile_idx + 1 :],
            ]
        if "--quiet" not in args and "-q" not in args:
            args = [*args, "--quiet"]

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


def handle_compile_inline(
    request: dict[str, Any],
    dbt: Any,
    project_dir: str,
    profiles_dir: str,
    extension_target_path: str,
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
        "--no-introspect",
        "--no-write-json",
        "--no-version-check",
        "--inline",
        sql,
        "--output",
        "json",
        "--project-dir",
        project_dir,
        "--profiles-dir",
        profiles_dir,
        "--target-path",
        extension_target_path,
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
    request: dict[str, Any],
    dbt: Any,
    project_dir: str,
    profiles_dir: str,
    extension_target_path: str,
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
        "--target-path",
        extension_target_path,
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


def main() -> None:
    configure_stdio()
    configure_dbt_env()

    # Determine project directory (passed via env var set by the extension)
    project_dir = os.environ.get("DBT_PROJECT_DIR", os.getcwd())
    profiles_dir = resolve_profiles_dir(project_dir)
    extension_target_path = os.environ.get(
        "DBT_EXTENSION_TARGET_PATH",
        os.environ.get("DBT_TARGET_PATH", os.path.join(project_dir, "target")),
    )

    # dbt is lazy-loaded — only imported/instantiated when a request that
    # actually needs it arrives (command, describe_table, compile_inline).
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

    # Manifest caching for compile_inline: avoids a full project re-parse on
    # every call.  On the first compile_inline request we run `dbt parse` once
    # to obtain the Manifest Python object, then inject it into a dedicated
    # dbtRunner instance via dbtRunner(manifest=...).  Subsequent calls skip
    # ManifestLoader entirely and run in ~100-300 ms instead of ~500ms-2s.
    _cached_manifest: Any = None
    _compile_runner: Any = None

    def get_compile_runner() -> Any:
        """Return a dbtRunner pre-loaded with the cached manifest.

        On the first call: runs `dbt parse` to populate the manifest cache and
        creates a dedicated runner with `dbtRunner(manifest=_cached_manifest)`.
        Falls back to the regular runner if parse fails.
        """
        nonlocal _cached_manifest, _compile_runner
        if _compile_runner is not None:
            return _compile_runner
        d = get_dbt()
        if d is None:
            return None
        if _cached_manifest is None:
            print(
                "[bridge] compile_inline: bootstrapping manifest cache via dbt parse",
                file=sys.stderr,
                flush=True,
            )
            parse_result = d.invoke(
                [
                    "--no-populate-cache",
                    "parse",
                    "--no-write-json",
                    "--no-version-check",
                    "--project-dir",
                    project_dir,
                    "--profiles-dir",
                    profiles_dir,
                    "--target-path",
                    extension_target_path,
                    "--log-format",
                    "json",
                ]
            )
            sys.stdout.flush()
            sys.stderr.flush()
            if parse_result.success and parse_result.result is not None:
                _cached_manifest = parse_result.result
                print(
                    "[bridge] manifest cache: bootstrapped successfully",
                    file=sys.stderr,
                    flush=True,
                )
            else:
                print(
                    "[bridge] manifest cache: parse failed, falling back to uncached runner",
                    file=sys.stderr,
                    flush=True,
                )
                return d
        runner_class = import_dbt_runner()
        if runner_class is None:
            return d
        _compile_runner = runner_class(manifest=_cached_manifest)
        return _compile_runner

    def invalidate_manifest_cache() -> None:
        """Reset the cached manifest and compile runner.

        Called when the TypeScript side detects that manifest.json has been
        rebuilt (e.g. after `dbt run` or `dbt compile` changes the project).
        """
        nonlocal _cached_manifest, _compile_runner
        _cached_manifest = None
        _compile_runner = None
        print("[bridge] manifest cache invalidated", file=sys.stderr, flush=True)

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
        if "describe_table" in request:
            d = get_dbt()
            if d is None:
                print(
                    json.dumps({"success": False, "error": "dbt not available"}),
                    flush=True,
                )
                continue
            handle_describe_table(
                request, d, project_dir, profiles_dir, extension_target_path
            )
        elif "compile_inline" in request:
            d = get_compile_runner()
            if d is None:
                print(
                    json.dumps({"success": False, "error": "dbt not available"}),
                    flush=True,
                )
                continue
            handle_compile_inline(
                request, d, project_dir, profiles_dir, extension_target_path
            )
        elif request.get('invalidate_manifest'):
            invalidate_manifest_cache()
            print(json.dumps({"success": True}), flush=True)
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
            success = run_command(
                d,
                list(command_args),
                project_dir,
                profiles_dir,
                extension_target_path,
            )
            print(json.dumps({"success": success}), flush=True)
        else:
            print(
                json.dumps({"success": False, "error": "Unknown request type"}),
                flush=True,
            )


if __name__ == "__main__":
    main()
