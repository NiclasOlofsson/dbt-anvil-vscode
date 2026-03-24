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
  Response: prints dbt output lines, then {"success": true/false} on its own line
  Shutdown: reads {"shutdown": true} from stdin → exits cleanly
"""

import json
import os
import sys


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

        # Execute command
        command_args: list = request.get("command", [])
        if not command_args:
            print(json.dumps({"success": False, "error": "Empty command"}), flush=True)
            continue

        success = run_command(dbt, list(command_args), project_dir, profiles_dir)
        print(json.dumps({"success": success}), flush=True)


if __name__ == "__main__":
    main()
