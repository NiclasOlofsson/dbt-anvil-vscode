/** Raw node from serde.dump() — flat list, one entry per AST node. */
export interface AstPayload {
    i?: number;                                            // parent index
    k?: string;                                            // arg key in parent
    a?: boolean;                                           // is array element
    c?: string;                                            // class name
    t?: AstPayload[];                                      // type annotation nodes
    o?: string[];                                          // attached comments
    m?: { line?: number; col?: number; start?: number; end?: number }; // position (1-based line/col, absent on synthesized nodes)
    v?: unknown;                                           // leaf value
}

export interface ScopeSource {
    type: 'table' | 'scope';
    name: string;
}

export interface ScopeNode {
    type: 'root' | 'cte' | 'subquery' | 'derived_table' | 'union';
    parentIndex?: number;
    cteScopes: number[];
    unionScopes: number[];
    subqueryScopes: number[];
    sources: Record<string, ScopeSource>;
    columns: string[];
}

export interface ParseWarning {
    type: 'scope_warning' | 'syntax_error';
    message: string;
    line?: number;
    col?: number;
    endCol?: number;
}

export interface ParseTiming {
    parseMs: number;
    qualifyMs: number;
    scopeMs: number;
    totalMs: number;
}

export interface JinjaRefSpan {
    type: 'ref';
    /** 0-based line of the `ref(` call */
    line: number;
    /** 0-based col of the `r` in `ref(` */
    col: number;
    model: string;
    /** 0-based col of the model name content (no quotes) */
    modelCol: number;
    /** 0-based exclusive end col of the model name content */
    modelEndCol: number;
    /** 0-based col of the opening `{{` */
    jinjaCol: number;
    /** 0-based exclusive end col after the closing `}}` */
    jinjaEndCol: number;
}

export interface JinjaSourceSpan {
    type: 'source';
    /** 0-based line of the `source(` call */
    line: number;
    /** 0-based col of the `s` in `source(` */
    col: number;
    sourceName: string;
    tableName: string;
    /** 0-based col of the sourceName content (no quotes) */
    sourceNameCol: number;
    /** 0-based exclusive end col of the sourceName content */
    sourceNameEndCol: number;
    /** 0-based col of the tableName content (no quotes) */
    tableNameCol: number;
    /** 0-based exclusive end col of the tableName content */
    tableNameEndCol: number;
    /** 0-based col of the opening `{{` */
    jinjaCol: number;
    /** 0-based exclusive end col after the closing `}}` */
    jinjaEndCol: number;
}

export type JinjaTagSpan = JinjaRefSpan | JinjaSourceSpan;

export interface ParseResult {
    ast: AstPayload[];
    scopes: ScopeNode[];
    dialect: string;
    warnings: ParseWarning[];
    timing: ParseTiming;
    /** Jinja ref/source spans extracted from the raw SQL, always in raw-source space. */
    jinjaTags?: JinjaTagSpan[];
}
