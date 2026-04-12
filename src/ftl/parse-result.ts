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

export interface ParseResult {
    ast: AstPayload[];
    scopes: ScopeNode[];
    dialect: string;
    warnings: ParseWarning[];
    timing: ParseTiming;
}
