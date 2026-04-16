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
	tokenizeMs?: number;
	totalMs: number;
}

export interface SqlToken {
	/** sqlglot TokenType enum name, e.g. 'SELECT', 'FROM', 'VAR', 'NUMBER' */
	type: string;
	/** 0-based char offset of first character */
	start: number;
	/** 0-based char offset of last character (inclusive) */
	end: number;
	/** 0-based line number */
	line: number;
	/** 1-based end column (= 0-based exclusive end col), matching sqlglot's token convention */
	col: number;
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
	sqlTokens?: SqlToken[];
	/** Jinja ref/source spans extracted from the raw SQL, always in raw-source space. */
	jinjaTags?: JinjaTagSpan[];
	/** CTEs whose body was `SELECT *` before qualify() expanded them. Line is 0-based. */
	wildcardCtes?: Array<{ name: string; line: number; col?: number }>;
	/**
	 * True when this result was produced by the nunjucks-render pass (pass 2).
	 * Line numbers are remapped to raw-source space but column numbers are not —
	 * rules that build vscode.Range from AST column positions must skip this result.
	 */
	isPass2?: boolean;
}
