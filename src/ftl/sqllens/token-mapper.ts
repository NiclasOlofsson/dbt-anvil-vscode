/**
 * Convert a sqllens (ANTLR) token stream into the extension's `SqlToken` shape
 * with TokenType names, so the reflow printer, ninja rules, and debug-symbols
 * keep working unchanged.
 *
 * Token classification is the PARSE's, not a table's (sqllens `consumedAs`
 * per-occurrence verdicts; #22 transition):
 *   - symbols/operators map by exact text (`-`→DASH, `%`→MOD, `::`→DCOLON);
 *   - a word the parse consumed as a keyword/type keeps its uppercased text as
 *     its type, run through the small RENAME maps below (`AS`→ALIAS,
 *     `STRING`→TEXT); a word consumed as an identifier is VAR regardless of
 *     any table; unverdicted words (recovery regions, bare tokenize()) fall
 *     back to the renames plus the fixed STRUCTURAL_CORE, else VAR;
 *   - adjacent keyword pairs like `GROUP BY` are folded into a single SqlToken
 *     (GROUP_BY, ORDER_BY, …) spanning both — ANTLR emits them separately.
 *
 * Position conventions: `start`/`end` are 0-based char offsets with `end`
 * INCLUSIVE; `line` is the 0-based line of the token's LAST char;
 * `col` is the 1-based inclusive end column (= 0-based exclusive end column)
 * on that line. Comments never surface as tokens — each SqlToken carries the
 * comments in the gap BEFORE it in `comments[]` (trailing end-of-file comments
 * attach to the last token); their `end` is exclusive.
 */
import type { SqlToken } from '../sql-tokens';
import type { Dialect, Token } from './api';

type CommentSpan = { start: number; end: number; text: string };

/** Exact-text → TokenType name for symbols/operators. Spelling-keyed and
 *  dialect-independent — the printer's operator vocabulary, not membership
 *  (the dialect's lexer decides what exists in the stream). */
const OPERATOR_TOKENS: Record<string, string> = {
	'(': 'L_PAREN',
	')': 'R_PAREN',
	'[': 'L_BRACKET',
	']': 'R_BRACKET',
	'{': 'L_BRACE',
	'}': 'R_BRACE',
	'&': 'AMP',
	'^': 'CARET',
	':': 'COLON',
	',': 'COMMA',
	'.': 'DOT',
	'-': 'DASH',
	'=': 'EQ',
	'>': 'GT',
	'<': 'LT',
	'%': 'MOD',
	'!': 'NOT',
	'|': 'PIPE',
	'+': 'PLUS',
	';': 'SEMICOLON',
	'/': 'SLASH',
	'\\': 'BACKSLASH',
	'*': 'STAR',
	'~': 'TILDA',
	'?': 'PLACEHOLDER',
	'@': 'PARAMETER',
	'#': 'HASH',
	'==': 'EQ',
	'::': 'DCOLON',
	'?::': 'QDCOLON',
	'||': 'DPIPE',
	'|>': 'PIPE_GT',
	'>=': 'GTE',
	'<=': 'LTE',
	'<>': 'NEQ',
	'!=': 'NEQ',
	':=': 'COLON_EQ',
	'<=>': 'NULLSAFE_EQ',
	'->': 'ARROW',
	'->>': 'DARROW',
	'=>': 'FARROW',
	'#>': 'HASH_ARROW',
	'#>>': 'DHASH_ARROW',
	'<->': 'LR_ARROW',
	'&&': 'DAMP',
	'&<': 'AMP_LT',
	'&>': 'AMP_GT',
	'??': 'DQMARK',
};

/** Uppercased word → canonical TokenType name, for the words whose type is NOT
 *  their own spelling: genuine renames (AS→ALIAS) and type-synonym
 *  canonicalization (STRING→TEXT, INT4→INT). PURE NAMING — membership is the
 *  parse's `consumedAs` verdict, so this never grows with dialects and a word
 *  absent here simply keeps its uppercased text as its type. */
const KEYWORD_RENAMES: Record<string, string> = {
	AS: 'ALIAS',
	AUTOINCREMENT: 'AUTO_INCREMENT',
	REGEXP: 'RLIKE',
	TABLESAMPLE: 'TABLE_SAMPLE',
	TEMP: 'TEMPORARY',
	BOOL: 'BOOLEAN',
	BYTE: 'TINYINT',
	INT1: 'TINYINT',
	INT16: 'SMALLINT',
	SHORT: 'SMALLINT',
	HUGEINT: 'INT128',
	UHUGEINT: 'UINT128',
	INT2: 'SMALLINT',
	INTEGER: 'INT',
	INT4: 'INT',
	INT32: 'INT',
	INT64: 'BIGINT',
	LONG: 'BIGINT',
	INT8: 'TINYINT',
	DEC: 'DECIMAL',
	BIGNUMERIC: 'BIGDECIMAL',
	NUMBER: 'DECIMAL',
	NUMERIC: 'DECIMAL',
	FIXED: 'DECIMAL',
	REAL: 'FLOAT',
	FLOAT4: 'FLOAT',
	FLOAT8: 'DOUBLE',
	CHARACTER: 'CHAR',
	VARCHAR2: 'VARCHAR',
	NVARCHAR2: 'NVARCHAR',
	STR: 'TEXT',
	STRING: 'TEXT',
	CLOB: 'TEXT',
	LONGVARCHAR: 'TEXT',
	BLOB: 'VARBINARY',
	BYTEA: 'VARBINARY',
	TIMESTAMP_LTZ: 'TIMESTAMPLTZ',
	TIMESTAMP_NTZ: 'TIMESTAMPNTZ',
	CALL: 'COMMAND',
	EXPLAIN: 'COMMAND',
	OPTIMIZE: 'COMMAND',
	PREPARE: 'COMMAND',
	VACUUM: 'COMMAND',
};

/** Two-word keyword phrases that are lexed as ONE token — the space-bearing
 *  entries of the KEYWORDS dict. ANTLR emits the two words separately,
 *  so the mapper folds an adjacent (whitespace-only) pair. Key is
 *  `WORD1 WORD2` uppercased with a single space. */
const COMPOUNDS: Record<string, string> = {
	'CHARACTER SET': 'CHARACTER_SET',
	'CLUSTER BY': 'CLUSTER_BY',
	'CONNECT BY': 'CONNECT_BY',
	'DISTRIBUTE BY': 'DISTRIBUTE_BY',
	'FOREIGN KEY': 'FOREIGN_KEY',
	'GROUP BY': 'GROUP_BY',
	'GROUPING SETS': 'GROUPING_SETS',
	'ORDER BY': 'ORDER_BY',
	'PARTITION BY': 'PARTITION_BY',
	'PARTITIONED BY': 'PARTITION_BY',
	'PRIMARY KEY': 'PRIMARY_KEY',
	'SIMILAR TO': 'SIMILAR_TO',
	'SORT BY': 'SORT_BY',
	'START WITH': 'START_WITH',
};

/** The fixed structural vocabulary of SQL — clause heads, connectives, and the
 *  frame words the printer lays out by. RECOVERY-REGION FALLBACK ONLY: where
 *  the parse produced no `consumedAs` verdict, these words still map to their
 *  own type so a mid-edit document keeps its shape. Grammar-stable: this set
 *  never grows when sqllens adds a dialect. */
const STRUCTURAL_CORE = new Set([
	'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'QUALIFY',
	'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'NATURAL',
	'ON', 'USING', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
	'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'RECURSIVE',
	'UNION', 'ALL', 'DISTINCT', 'EXCEPT', 'INTERSECT',
	'LIMIT', 'OFFSET', 'FETCH', 'TOP',
	'BETWEEN', 'LIKE', 'ILIKE', 'EXISTS', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
	'OVER', 'PARTITION', 'WINDOW', 'ROWS', 'RANGE', 'CURRENT', 'ROW', 'LATERAL',
	'TRUE', 'FALSE', 'CAST', 'INTERVAL', 'VALUES',
	'INSERT', 'INTO', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'VIEW', 'DROP', 'ALTER',
]);

/** Per-dialect renames layered over KEYWORD_RENAMES (consulted first): the
 *  entries where a word's canonical meaning genuinely differs by dialect
 *  (MINUS→EXCEPT, tsql TIMESTAMP→ROWVERSION). PURE NAMING, same as the base
 *  map — membership is the parse's verdict, so these never grow with new
 *  dialects, only with genuinely dialect-divergent semantics. */
const DIALECT_KEYWORD_RENAMES: Partial<Record<Dialect, Record<string, string>>> = {
	tsql: {
		DATETIMEOFFSET: 'TIMESTAMPTZ',
		EXEC: 'COMMAND',
		GO: 'COMMAND',
		NTEXT: 'TEXT',
		OUTPUT: 'RETURNING',
		PRINT: 'COMMAND',
		PROC: 'PROCEDURE',
		SQL_VARIANT: 'VARIANT',
		SYSTEM_USER: 'CURRENT_USER',
		TIMESTAMP: 'ROWVERSION',
		TINYINT: 'UTINYINT',
		UNIQUEIDENTIFIER: 'UUID',
	},
	snowflake: {
		BYTEINT: 'INT',
		MINUS: 'EXCEPT',
		REMOVE: 'COMMAND',
		RM: 'COMMAND',
		SAMPLE: 'TABLE_SAMPLE',
		SQL_DOUBLE: 'DOUBLE',
		SQL_VARCHAR: 'VARCHAR',
		TIMESTAMP_TZ: 'TIMESTAMPTZ',
		// Snowflake treats FLOAT as a synonym for DOUBLE.
		FLOAT: 'DOUBLE',
	},
	bigquery: {
		BYTEINT: 'INT',
		BYTES: 'BINARY',
		// The bare word starts a BEGIN…EXCEPTION…END block (command); the
		// two-word phrase below is the actual transaction-start keyword.
		BEGIN: 'COMMAND',
		DATETIME: 'TIMESTAMP',
		ELSEIF: 'COMMAND',
		EXCEPTION: 'COMMAND',
		FLOAT64: 'DOUBLE',
		LOOP: 'COMMAND',
		RECORD: 'STRUCT',
		REPEAT: 'COMMAND',
		TIMESTAMP: 'TIMESTAMPTZ',
		WHILE: 'COMMAND',
	},
	databricks: {
		// Hive (base of the databricks -> spark -> spark2 -> hive chain).
		MINUS: 'EXCEPT',
		SERDEPROPERTIES: 'SERDE_PROPERTIES',
		// Spark2 override.
		TIMESTAMP: 'TIMESTAMPTZ',
	},
	redshift: {
		// Postgres (Redshift's base).
		CSTRING: 'PSEUDO_TYPE',
		DECLARE: 'COMMAND',
		DO: 'COMMAND',
		EXEC: 'COMMAND',
		INT8: 'BIGINT',
		OID: 'OBJECT_IDENTIFIER',
		REFRESH: 'COMMAND',
		REINDEX: 'COMMAND',
		RESET: 'COMMAND',
		REGCLASS: 'OBJECT_IDENTIFIER',
		REGCOLLATION: 'OBJECT_IDENTIFIER',
		REGCONFIG: 'OBJECT_IDENTIFIER',
		REGDICTIONARY: 'OBJECT_IDENTIFIER',
		REGNAMESPACE: 'OBJECT_IDENTIFIER',
		REGOPER: 'OBJECT_IDENTIFIER',
		REGOPERATOR: 'OBJECT_IDENTIFIER',
		REGPROC: 'OBJECT_IDENTIFIER',
		REGPROCEDURE: 'OBJECT_IDENTIFIER',
		REGROLE: 'OBJECT_IDENTIFIER',
		REGTYPE: 'OBJECT_IDENTIFIER',
		FLOAT: 'DOUBLE',
		// Redshift's own additions.
		MINUS: 'EXCEPT',
		UNLOAD: 'COMMAND',
		VARBYTE: 'VARBINARY',
		// KEYWORDS.pop(...): identifiers in Postgres/Redshift, not keywords.
	},
};

/** Per-dialect additions to COMPOUNDS above (two-word phrases lexed as one token),
 *  transcribed the same way and checked before COMPOUNDS.
 *  Three-word phrases (Hive/Databricks `TIMESTAMP AS OF`, `VERSION AS OF`)
 *  are not transcribed — the fold below only joins adjacent *pairs*. */
const DIALECT_COMPOUNDS: Partial<Record<Dialect, Record<string, string>>> = {
	tsql: {
		'CLUSTERED INDEX': 'INDEX',
		'NONCLUSTERED INDEX': 'INDEX',
		'FOR SYSTEM_TIME': 'TIMESTAMP_SNAPSHOT',
		'UPDATE STATISTICS': 'COMMAND',
	},
	snowflake: {
		'FILE FORMAT': 'FILE_FORMAT',
		'NCHAR VARYING': 'VARCHAR',
		'SEMANTIC VIEW': 'SEMANTIC_VIEW',
		'STORAGE INTEGRATION': 'STORAGE_INTEGRATION',
	},
	bigquery: {
		'ANY TYPE': 'VARIANT',
		'BEGIN TRANSACTION': 'BEGIN',
		'FOR SYSTEM_TIME': 'TIMESTAMP_SNAPSHOT',
		'NOT DETERMINISTIC': 'VOLATILE',
	},
	databricks: {
		'ADD ARCHIVE': 'COMMAND',
		'ADD ARCHIVES': 'COMMAND',
		'ADD FILE': 'COMMAND',
		'ADD FILES': 'COMMAND',
		'ADD JAR': 'COMMAND',
		'ADD JARS': 'COMMAND',
		'MSCK REPAIR': 'COMMAND',
	},
	redshift: {
		'BINARY VARYING': 'VARBINARY',
		'CONSTRAINT TRIGGER': 'COMMAND',
	},
};

function buildLineStarts(sql: string): number[] {
	const starts = [0];
	for (let i = 0; i < sql.length; i++) {
		if (sql[i] === '\n') starts.push(i + 1);
	}
	return starts;
}

function lineAtOffset(offset: number, lineStarts: number[]): number {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStarts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

function isQuotedIdentifier(text: string): boolean {
	const c = text[0];
	return c === '"' || c === '`' || c === '[';
}

/**
 * A token that carries no SQL meaning — a whitespace/newline run. The token
 * stream emits NO whitespace tokens, so the mapper drops these. We test BOTH the role and the
 * text: some sqllens builds tag a bare `\r\n` / `\n` with a non-`whitespace` role,
 * and a whitespace-TEXT token must be dropped whatever its role (else it leaks
 * through as a bogus `\r\n`-typed SqlToken, historically the most frequent mismatch).
 * Dropped tokens still separate a pending comment from the token it attaches to — the
 * comment-gap fold `continue`s past them without resetting `pending`.
 */
function isWhitespaceToken(tok: Token): boolean {
	return tok.role === 'whitespace' || /^\s+$/.test(tok.text ?? '');
}

/** Map one already-de-compounded sqllens token to a TokenType name plus its
 *  recasing kind (what cap-keywords and the printer key on per occurrence). */
function singleType(tok: Token, dialect: Dialect): { type: string; kind?: 'keyword' | 'type' } {
	switch (tok.role) {
		case 'string':
			return { type: 'STRING' };
		case 'number':
			return { type: 'NUMBER' };
		case 'identifier':
			return { type: isQuotedIdentifier(tok.text) ? 'IDENTIFIER' : 'VAR' };
	}
	const bySymbol = OPERATOR_TOKENS[tok.text];
	if (bySymbol) return { type: bySymbol };
	const upper = tok.text.toUpperCase();
	// The parse's own per-occurrence verdict (sqllens 1.8.0 `consumedAs`)
	// outranks the tables in both directions: a keyword-vocabulary word the
	// parse absorbed through an identifier rule IS an identifier here (duckdb
	// lexes the column in `a.name` as a NAME keyword token; redshift even
	// tables it), and a keyword/type the tables don't know keeps its uppercased
	// text instead of demoting to VAR. The tables are thereby NAMING (renames +
	// type canonicalization), no longer membership, wherever a verdict exists.
	if (tok.consumedAs === 'identifier') return { type: 'VAR' };
	if (tok.consumedAs === 'keyword' || tok.consumedAs === 'type') {
		const named = DIALECT_KEYWORD_RENAMES[dialect]?.[upper] ?? KEYWORD_RENAMES[upper] ?? upper;
		return { type: named, kind: tok.consumedAs };
	}
	// No verdict (bare tokenize(), recovery regions): the renames plus the
	// fixed structural core keep classic keywords typed so a mid-edit document
	// holds its shape; every other word is an identifier — the conservative
	// default the soft-keyword pin in token-mapper.test.ts documents.
	const mapped = DIALECT_KEYWORD_RENAMES[dialect]?.[upper] ?? KEYWORD_RENAMES[upper];
	if (mapped) return { type: mapped, kind: 'keyword' };
	if (STRUCTURAL_CORE.has(upper)) return { type: upper, kind: 'keyword' };
	// An unmapped symbol keeps its uppercased text as a last resort.
	return { type: /^[A-Z_][A-Z0-9_$]*$/.test(upper) ? 'VAR' : upper };
}

/** Next non-whitespace token after index `i`, or null if a comment intervenes
 *  (keyword folding only happens across whitespace) or the stream ends. */
function nextKeywordCandidate(tokens: Token[], i: number): { tok: Token; index: number } | null {
	for (let j = i + 1; j < tokens.length; j++) {
		const t = tokens[j];
		if (isWhitespaceToken(t)) continue;
		if (t.role === 'comment') return null;
		return { tok: t, index: j };
	}
	return null;
}

export function mapTokens(tokens: Token[], sql: string, dialect: Dialect): SqlToken[] {
	const lineStarts = buildLineStarts(sql);
	const out: SqlToken[] = [];
	let pending: CommentSpan[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (isWhitespaceToken(tok)) continue;
		if (tok.role === 'comment') {
			// ANTLR's line-comment token swallows the trailing newline, but we need
			// spans that exclude the newline (the printer re-slices source by [start,end)).
			// `end` is exclusive.
			let end = tok.stop + 1;
			while (end > tok.start && (sql[end - 1] === '\n' || sql[end - 1] === '\r')) end--;
			pending.push({ start: tok.start, end, text: sql.slice(tok.start, end) });
			continue;
		}

		let type: string | undefined;
		let kind: SqlToken['kind'];
		let endTok = tok;
		if (tok.role === 'keyword') {
			const nx = nextKeywordCandidate(tokens, i);
			if (nx && nx.tok.role === 'keyword') {
				const pairKey = `${tok.text.toUpperCase()} ${nx.tok.text.toUpperCase()}`;
				const compound = DIALECT_COMPOUNDS[dialect]?.[pairKey] ?? COMPOUNDS[pairKey];
				if (compound) {
					type = compound;
					kind = 'keyword';
					endTok = nx.tok;
					i = nx.index;
				}
			}
		}
		if (type === undefined) {
			const single = singleType(tok, dialect);
			type = single.type;
			kind = single.kind;
		}

		const line = lineAtOffset(endTok.stop, lineStarts);
		const st: SqlToken = {
			type,
			start: tok.start,
			end: endTok.stop,
			line,
			col: endTok.stop - lineStarts[line] + 1,
		};
		if (kind !== undefined) st.kind = kind;
		if (pending.length) {
			st.comments = pending;
			pending = [];
		}
		out.push(st);
	}

	if (pending.length && out.length) {
		const last = out[out.length - 1];
		last.comments = last.comments ? [...last.comments, ...pending] : pending;
	}
	return out;
}
