import * as nunjucks from 'nunjucks';
import { iterJinjaTags } from '../dbt/jinja-blanker';

const STUB = '__jinja__';

/**
 * A callable that returns STUB and is itself coercible to the STUB string.
 * Used as the stand-in for any unknown dbt macro or variable.
 */
function makeStub(): unknown {
    const fn = (..._args: unknown[]): unknown => STUB;
    Object.defineProperty(fn, 'valueOf', { value: () => STUB });
    Object.defineProperty(fn, Symbol.toPrimitive, { value: () => STUB });
    Object.defineProperty(fn, 'toString', { value: () => STUB });
    return fn;
}

const _stub = makeStub();

// nunjucks globals Proxy: known dbt builtins return SQL-safe values; every
// other string key returns _stub so {{ unknown_macro() }} renders to STUB.
// nunjucks's Context.lookup checks `name in env.globals` during variable
// resolution — the has/get traps here make all unknown names resolve to _stub
// without needing a callsite-specific context object.
const _dbtGlobals = new Proxy(
    {
        ref: (...args: string[]) => args[args.length - 1] ?? STUB,
        source: (...args: string[]) => args[args.length - 1] ?? STUB,
        config: (..._args: unknown[]) => '',
        var: (_name: string, d: unknown = STUB) => d,
        env_var: (_name: string, d: unknown = STUB) => d,
        is_incremental: () => false,
        execute: false,
        run_started_at: '',
        invocation_id: '',
        modules: _stub,
        flags: _stub,
    } as Record<string | symbol, unknown>,
    {
        get(target: Record<string | symbol, unknown>, prop: string | symbol) {
            if (prop in target) return target[prop];
            if (typeof prop === 'symbol') return undefined;
            return _stub;
        },
        has(_target: Record<string | symbol, unknown>, prop: string | symbol) {
            if (typeof prop === 'symbol') return false;
            return true;
        },
    },
);

const ENV = new nunjucks.Environment(null as unknown as nunjucks.ILoader, {
    autoescape: false,
    throwOnUndefined: false,
});
// Replace the default empty globals object so Context.lookup resolves unknown
// variable/macro names to _stub via the Proxy traps above.
(ENV as unknown as { globals: unknown }).globals = _dbtGlobals;

/** Breakpoints mapping rendered 0-based line numbers to raw 0-based line numbers. */
export type LineMap = Array<[number, number]>;

/**
 * Convert a rendered (0-based) line number to the corresponding raw-source
 * (0-based) line number using the breakpoint table built by renderForParse.
 *
 * Uses the same bisect-right algorithm as bridge.py `_ren_to_raw_line`.
 */
export function renToRawLine(renLine: number, lineMap: LineMap): number {
    if (lineMap.length === 0) return renLine;
    // Find largest breakpoint index where ren_bp <= renLine.
    let lo = 0;
    let hi = lineMap.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineMap[mid][0] <= renLine) lo = mid;
        else hi = mid - 1;
    }
    const [renBp, rawBp] = lineMap[lo];
    return rawBp + (renLine - renBp);
}

/**
 * Build the (ren_line, raw_line) breakpoint table for a raw SQL string.
 *
 * Mirrors bridge.py `_render_jinja_for_parse` line-map construction:
 * - Literal sections between tags: both raw and rendered line counters advance
 *   by the same newline count (literals appear unchanged in output).
 * - Each Jinja tag: raw_line advances by the tag's newline count; ren_line does
 *   NOT advance (the stub replacement is always a single-line value).
 *   A new breakpoint is emitted whenever the two counts diverge.
 */
export function buildLineMap(rawSql: string): LineMap {
    let rawLine = 0;
    let renLine = 0;
    let rawPos = 0;
    const breakpoints: LineMap = [[0, 0]];

    for (const match of iterJinjaTags(rawSql)) {
        const tagStart = match.index;
        const tag = match[0];

        // Literal section before this tag — both counters advance equally.
        for (let i = rawPos; i < tagStart; i++) {
            if (rawSql[i] === '\n') { rawLine++; renLine++; }
        }

        // The tag itself: raw advances by its newlines; ren stays.
        let tagNewlines = 0;
        for (let i = 0; i < tag.length; i++) {
            if (tag[i] === '\n') tagNewlines++;
        }
        rawLine += tagNewlines;
        // renLine does NOT advance.
        if (tagNewlines > 0) {
            breakpoints.push([renLine, rawLine]);
        }

        rawPos = tagStart + tag.length;
    }

    return breakpoints;
}

export interface RenderResult {
    rendered: string;
    /** 0-based (ren_line, raw_line) breakpoints for remapping AST positions. */
    lineMap: LineMap;
}

/**
 * Render a dbt Jinja-SQL template to plain SQL using stub values for all
 * unknown macros and variables.
 *
 * Known dbt globals are mapped to SQL-safe values:
 *   ref('model')        → 'model'
 *   source('ns','tbl')  → 'tbl'
 *   config(...)         → ''
 *   var(name, default)  → default ?? STUB
 *   env_var(...)        → STUB
 *   is_incremental()    → false
 *
 * Every other unknown variable or macro call returns STUB ('__jinja__').
 *
 * Returns the rendered SQL and a line map for converting rendered line numbers
 * back to raw-source line numbers (see renToRawLine).
 *
 * The rendered SQL is not length-preserving — use positions only after
 * remapping through renToRawLine.
 */
export function renderForParse(sql: string): RenderResult {
    // Build the line map from raw SQL before rendering (matches bridge.py order).
    const lineMap = buildLineMap(sql);

    let rendered: string;
    try {
        // No per-call context needed: all dbt builtins and unknown macros are
        // handled by the module-level _dbtGlobals Proxy on ENV.globals.
        rendered = ENV.renderString(sql, {});
    } catch {
        // If nunjucks itself fails (e.g. malformed template syntax), return
        // the raw SQL — line map is identity in this case.
        rendered = sql;
    }

    return { rendered, lineMap };
}
