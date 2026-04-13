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


def run_command(
    dbt, args: list, project_dir: str, profiles_dir: str, extension_target_path: str
) -> bool:
    """
    Invoke a dbt command. dbt output goes directly to stdout (print statements).
    Returns True if successful, False otherwise.
    """
    # Always inject --profiles-dir and --log-format unless caller provided them
    if "--profiles-dir" not in args:
        args = [*args, "--profiles-dir", profiles_dir]
    if "--target-path" not in args:
        args = [*args, "--target-path", extension_target_path]
    if "--log-format" not in args and len(args) > 0 and args[0] not in ("deps",):
        args = [*args, "--log-format", "text"]
    # compile never needs warehouse introspection — skip the metastore scan.
    # --no-populate-cache is a global flag (before subcommand).
    # --no-introspect is a compile-specific flag (after subcommand).
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


def _iter_jinja_tags(sql: str):
    """Yield (start, end, tag_text) for every Jinja tag in *sql*.

    Uses brace-counting for {{ }} tags so that nested {{ }} inside string
    arguments (e.g. ``post_hook="COPY {{ this }} TO '...'"``) is consumed as
    part of the outer enclosing tag rather than stopping at the first }}.
    """
    i = 0
    n = len(sql)
    while i < n:
        if sql[i] != "{" or i + 1 >= n:
            i += 1
            continue
        nxt = sql[i + 1]

        if nxt == "{":
            # Depth-count {{ / }} pairs to find the matching close.
            start = i
            depth = 0
            j = i
            while j < n:
                if sql[j] == "{" and j + 1 < n and sql[j + 1] == "{":
                    depth += 1
                    j += 2
                elif sql[j] == "}" and j + 1 < n and sql[j + 1] == "}":
                    depth -= 1
                    j += 2
                    if depth == 0:
                        break
                else:
                    j += 1
            if depth == 0:
                yield start, j, sql[start:j]
            i = j

        elif nxt == "%":
            start = i
            end = sql.find("%}", i + 2)
            if end == -1:
                break
            j = end + 2
            yield start, j, sql[start:j]
            i = j

        elif nxt == "#":
            start = i
            end = sql.find("#}", i + 2)
            if end == -1:
                break
            j = end + 2
            yield start, j, sql[start:j]
            i = j

        else:
            i += 1


# Keep for callers that use it directly (e.g. ref/source extraction).
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
# dbt built-in value functions whose names clash with SQL reserved words/aggregates.
# VAR(x) is a statistical aggregate in DuckDB — using the macro name as the
# replacement identifier causes sqlglot parse errors in SELECT position.
# Blank these to ``_`` (the safe fallback) instead of their name.
_VALUE_MACROS = frozenset({"var", "env_var"})


def _blank_jinja(sql: str, macro_mode: str = "identifier") -> str:
    """Replace Jinja tags with space-padded SQL-safe placeholders.

    Preserves ``len(result) == len(sql)`` so every character offset and line
    number from the sqlglot AST maps directly back to the original source.

    Strategy (in priority order for ``{{ }}`` expression tags):
    - ``{{ ref('model') }}``               → ``model              `` (real model name)
    - ``{{ source('ns','tbl') }}``         → ``tbl                `` (real table name)
    - ``{{ config(...) }}`` / known no-SQL → all spaces (produces no SQL output)
    - ``{{ my_macro('arg') }}``            → depends on *macro_mode* (see below)
    - ``{{ ns.macro('arg') }}``            → last name component (identifier mode)
    - ``{{ arbitrary_expr }}``             → ``_                   `` (safe fallback identifier)
    - ``{% ... %}`` block/statement tags   → all spaces (never expression values)
    - ``{# ... #}`` comment tags           → all spaces

    *macro_mode* controls how unknown callable ``{{ }}`` tags are replaced:

    - ``'identifier'`` (default): replace with the macro name as an identifier
      padded with spaces (e.g. ``generic_is_deleted             ``).  Works
      when the macro appears in an *expression* position; fails when it appears
      at *statement level* (bare identifier after a complete SELECT…JOIN is not
      valid SQL and sqlglot rejects the file).
    - ``'comment'``: replace with a ``/* … */`` block comment of the same byte
      length (e.g. ``/* generic_is_deleted       */``).  SQL block comments are
      syntactically valid in *every* position — expression or statement level —
      so sqlglot can always parse the blanked SQL.  Use this as a retry when
      ``'identifier'`` mode produces an un-parseable file.

    Newlines inside tags are always preserved so line numbers stay correct.
    """
    buf = list(sql)

    for m in _iter_jinja_tags(sql):
        start, end, tag = m

        # Determine replacement: an identifier string, or blank_to_spaces=True,
        # or use_comment=True (comment mode for statement-level macros).
        identifier: str | None = None
        identifier_nl_offset = 0  # non-NL chars to skip before writing identifier
        blank_to_spaces = not tag.startswith("{{")  # {# #} and {% %} always spaces
        use_comment = False

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
                        elif name in _VALUE_MACROS:
                            # Known value-returning macros whose names clash with
                            # SQL reserved words (e.g. VAR is a DuckDB aggregate).
                            # Leave identifier=None so the ``_`` fallback fires.
                            pass
                        elif macro_mode == "comment":
                            use_comment = True
                        else:
                            identifier = name
                            # Only offset the identifier when there are newlines
                            # before the name in the tag.  Single-line tags keep
                            # the old left-aligned behaviour (offset = 0).
                            name_slice = tag[: macro_m.start(1)]
                            if "\n" in name_slice:
                                identifier_nl_offset = sum(
                                    1 for ch in name_slice if ch != "\n"
                                )

        # Blank the tag character-by-character, skipping newlines.
        non_nl_positions = [i for i in range(start, end) if sql[i] != "\n"]

        if use_comment:
            # SQL block comment of the same length — valid in any syntactic position.
            n = len(non_nl_positions)
            if n >= 4:
                buf[non_nl_positions[0]] = "/"
                buf[non_nl_positions[1]] = "*"
                for pos in non_nl_positions[2:-2]:
                    buf[pos] = " "
                buf[non_nl_positions[-2]] = "*"
                buf[non_nl_positions[-1]] = "/"
            else:
                for pos in non_nl_positions:
                    buf[pos] = " "
        elif identifier and non_nl_positions:
            # Write identifier chars starting at identifier_nl_offset so that
            # multi-line tags (e.g. `{{\n    elo_calc(...)}}`) place the name on
            # the line where the name actually appears, not on the `{{` line.
            for j, pos in enumerate(non_nl_positions):
                idx = j - identifier_nl_offset
                buf[pos] = identifier[idx] if 0 <= idx < len(identifier) else " "
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


_SQL_STUB = "__jinja__"  # valid SQL identifier returned for unknown macro calls
_JINJA_STUB_ENV: Any = None  # lazily initialised, module-level cache


def handle_emit_debug_symbols(request: dict[str, Any]) -> None:
    """Generate a symbol table for debug symbol emission.

    Input:  {"emit_debug_symbols": true, "sql": "...", "dialect": "duckdb"}
    Output: {"success": true, "symbols": [{"line": 0, "col": 0, "endCol": 6, "role": "select"}, ...]}

    Internally blanks Jinja tags via _blank_jinja (length-preserving) so
    positions map directly back to the original source.  Returns 0-based
    line/col values.
    """
    import bisect

    from sqlglot import Dialect as _Dialect  # type: ignore[import-not-found]
    from sqlglot.tokens import Tokenizer as _Tokenizer  # type: ignore[import-not-found]
    from sqlglot.tokens import TokenType as _TT  # type: ignore[import-not-found]

    raw_sql: str = request.get("sql", "")
    dialect: str = request.get("dialect", "ansi")
    sqlglot_dialect: str | None = dialect if dialect not in ("ansi", "", None) else None

    if not raw_sql:
        print(json.dumps({"success": True, "symbols": []}), flush=True)
        return

    # Blank Jinja so sqlglot sees pure SQL.  Length-preserving so all
    # char offsets map 1:1 back to the original source.
    blanked = _blank_jinja(raw_sql)

    # Collect the char-offset ranges that were Jinja tags so we can
    # filter out the placeholder tokens that _blank_jinja inserted.
    jinja_ranges: list[tuple[int, int]] = [
        (start, end) for start, end, _ in _iter_jinja_tags(raw_sql)
    ]

    def _in_jinja(offset: int) -> bool:
        for js, je in jinja_ranges:
            if js <= offset < je:
                return True
        return False

    # Tokenize
    try:
        tokenizer = (
            _Dialect.get_or_raise(sqlglot_dialect).tokenizer_class()
            if sqlglot_dialect
            else _Tokenizer()
        )
        token_list = tokenizer.tokenize(blanked)
    except Exception:
        print(json.dumps({"success": True, "symbols": []}), flush=True)
        return

    # line_starts for offset → (line, col) conversion
    line_starts: list[int] = [0]
    for i, ch in enumerate(raw_sql):
        if ch == "\n":
            line_starts.append(i + 1)

    def offset_to_line(offset: int) -> int:
        return max(0, bisect.bisect_right(line_starts, offset) - 1)

    def offset_to_col(offset: int) -> int:
        line = offset_to_line(offset)
        return offset - line_starts[line]

    # Token-type → role mapping  (only emit tokens we care about)
    _ROLE_MAP: dict[_TT, str] = {
        _TT.SELECT: "select",
        _TT.FROM: "from",
        _TT.JOIN: "join",
        _TT.INNER: "join",
        _TT.LEFT: "join",
        _TT.RIGHT: "join",
        _TT.CROSS: "join",
        _TT.FULL: "join",
        _TT.WHERE: "where",
        _TT.GROUP_BY: "group",
        _TT.HAVING: "having",
        _TT.ORDER_BY: "order",
        _TT.LIMIT: "limit",
        _TT.WITH: "cte",
        _TT.STAR: "star",
    }

    # ── CTE range detection for frameName assignment ──
    # Use parse_one() to get AST nodes with meta positions, mirroring the same
    # node_line / paren-scan pattern used in handle_decompose_query.
    # Blanking preserves character offsets, so meta positions are valid against
    # raw_sql and offset_to_line() can be used directly.
    cte_ranges: list[tuple[str, int, int]] = []  # (name, startLine_0, endLine_0)
    try:
        import sqlglot as _sg  # type: ignore[import-not-found]
        from sqlglot import exp as _exp  # type: ignore[import-not-found]

        _blanked_ast = _sg.parse_one(blanked, dialect=sqlglot_dialect, error_level=None)
        _with = _blanked_ast.args.get("with_") if _blanked_ast else None
        if _with:
            for cte_node in _with.expressions:
                cte_name = cte_node.alias or ""
                if not cte_name:
                    continue
                # Start line: leftmost Identifier's meta line (1-based → 0-based)
                start_line = 0
                for ident in cte_node.find_all(_exp.Identifier):
                    raw = ident.meta.get("line")
                    if raw is not None:
                        start_line = max(0, raw - 1)
                        break
                # End line: find node's first child offset, then paren-scan
                first_start: int | None = None
                for child in cte_node.walk():
                    s = child.meta.get("start")
                    if s is not None and (first_start is None or s < first_start):
                        first_start = s
                end_line = start_line
                if first_start is not None:
                    open_idx = blanked.find("(", first_start)
                    if open_idx >= 0:
                        depth = 0
                        for idx in range(open_idx, len(blanked)):
                            if blanked[idx] == "(":
                                depth += 1
                            elif blanked[idx] == ")":
                                depth -= 1
                                if depth == 0:
                                    end_line = offset_to_line(idx)
                                    break
                cte_ranges.append((cte_name, start_line, end_line))
    except Exception:
        pass  # CTE detection is best-effort; symbols still work without frameName

    def _frame_name_for_line(line_0: int) -> str:
        """Return the CTE name for a given 0-based source line, or '_main_'."""
        for name, start, end in cte_ranges:
            if start <= line_0 <= end:
                return name
        return "_main_"

    # Also classify Jinja spans for the four-marker system.
    # Each Jinja tag is classified as ref/source/macro/other.
    jinja_classifications: list[dict[str, Any]] = []
    for start, end, tag in _iter_jinja_tags(raw_sql):
        tag_start_line = offset_to_line(start)
        ref_m = _REF_TAG_RE.fullmatch(tag)
        if ref_m:
            jinja_classifications.append(
                {
                    "type": "ref",
                    "name": ref_m.group(1),
                    "sourceLine": tag_start_line,
                    "startOffset": start,
                    "endOffset": end,
                }
            )
            continue
        src_m = _SOURCE_TAG_RE.fullmatch(tag)
        if src_m:
            jinja_classifications.append(
                {
                    "type": "source",
                    "schema": src_m.group(1),
                    "name": src_m.group(2),
                    "sourceLine": tag_start_line,
                    "startOffset": start,
                    "endOffset": end,
                }
            )
            continue
        if tag.startswith("{{"):
            macro_m = _MACRO_TAG_RE.match(tag)
            if macro_m:
                name = macro_m.group(1)
                if name not in _STATEMENT_MACROS and name not in _VALUE_MACROS:
                    jinja_classifications.append(
                        {
                            "type": "macro",
                            "name": name,
                            "sourceLine": tag_start_line,
                            "startOffset": start,
                            "endOffset": end,
                        }
                    )
                    continue
        # Other Jinja tags (block/comment/statement macros/value macros) — not classified

    # Build symbol table
    symbols: list[dict[str, Any]] = []

    for idx, t in enumerate(token_list):
        # Skip tokens inside blanked Jinja regions
        if _in_jinja(t.start):
            continue

        role = _ROLE_MAP.get(t.token_type)

        if role is None:
            # Identifiers / vars
            if t.token_type == _TT.VAR:
                # Peek ahead: ident followed by L_PAREN → function call
                next_tok = token_list[idx + 1] if idx + 1 < len(token_list) else None
                if next_tok and next_tok.token_type == _TT.L_PAREN:
                    role = "fn"
                else:
                    role = "ident"
            elif t.token_type == _TT.NUMBER:
                role = "lit"
            elif t.token_type == _TT.STRING:
                role = "lit"

        if role is None:
            continue

        line_0 = offset_to_line(t.start)
        col_0 = offset_to_col(t.start)
        # endCol: exclusive, relative to the line t.end sits on
        end_line_0 = offset_to_line(t.end)
        end_col_on_line = t.end - line_starts[end_line_0] + 1

        symbols.append(
            {
                "line": line_0,
                "col": col_0,
                "endCol": end_col_on_line,
                "role": role,
                "frameName": _frame_name_for_line(line_0),
            }
        )

    # Build macro/ref/source span data from Jinja classifications
    macro_spans = [c for c in jinja_classifications if c["type"] == "macro"]
    ref_markers = [c for c in jinja_classifications if c["type"] == "ref"]
    source_markers = [c for c in jinja_classifications if c["type"] == "source"]

    response: dict[str, Any] = {"success": True, "symbols": symbols}
    if macro_spans:
        response["macroSpans"] = [
            {
                "name": m["name"],
                "sourceLine": m["sourceLine"],
                "startOffset": m["startOffset"],
                "endOffset": m["endOffset"],
            }
            for m in macro_spans
        ]
    if ref_markers:
        response["refMarkers"] = [
            {
                "name": r["name"],
                "sourceLine": r["sourceLine"],
                "startOffset": r["startOffset"],
                "endOffset": r["endOffset"],
            }
            for r in ref_markers
        ]
    if source_markers:
        response["sourceMarkers"] = [
            {
                "schema": s["schema"],
                "name": s["name"],
                "sourceLine": s["sourceLine"],
                "startOffset": s["startOffset"],
                "endOffset": s["endOffset"],
            }
            for s in source_markers
        ]

    print(json.dumps(response), flush=True)


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
        elif request.get("invalidate_manifest"):
            invalidate_manifest_cache()
            print(json.dumps({"success": True}), flush=True)
        elif "emit_debug_symbols" in request:
            handle_emit_debug_symbols(request)
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
