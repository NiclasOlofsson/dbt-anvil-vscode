/**
 * Convert a sqllens (ANTLR) token stream into the extension's existing
 * `SqlToken` shape carrying sqlglot `TokenType` names, so the reflow printer,
 * ninja rules, and debug-symbols keep working unchanged after the migration
 * off sqlglot/Pyodide.
 *
 * The mapping replicates sqlglot's own tokenizer decisions (resources/ftl/
 * vendor/sqlglot/tokens.py) rather than trusting sqllens's coarse role:
 *   - symbols/operators map by exact text (SINGLE_TOKENS + the multi-char
 *     entries in KEYWORDS), so `-`→DASH, `%`→MOD, `::`→DCOLON, `*`→STAR;
 *   - words map by uppercased text through the vendored KEYWORDS dict
 *     (`AS`→ALIAS, `SELECT`→SELECT, …); a word absent from KEYWORDS is an
 *     identifier → VAR (or IDENTIFIER when quoted), matching sqlglot;
 *   - adjacent keyword pairs that sqlglot lexes as one token (`GROUP BY`→
 *     GROUP_BY, `ORDER BY`→ORDER_BY, …) are folded into a single SqlToken
 *     spanning both — ANTLR emits them separately.
 *
 * Position conventions reproduced from resources/ftl/sql_parser.py `_tokenize`
 * and sqlglot's Token (_add): `start`/`end` are 0-based char offsets with `end`
 * INCLUSIVE; `line` is the 0-based line of the token's LAST char (sqlglot stamps
 * a token's line/col after consuming it); `col` is the 1-based inclusive end
 * column (= 0-based exclusive end column) on that line. Comments never surface
 * as tokens — each SqlToken carries the comments in the gap BEFORE it in
 * `comments[]` (trailing end-of-file comments attach to the last token); their
 * `end` is exclusive.
 */
import type { SqlToken } from '../parse-result';
import type { Dialect, Token } from './api';

type CommentSpan = { start: number; end: number; text: string };

/** Exact-text → sqlglot TokenType name for symbols/operators (SINGLE_TOKENS +
 *  the multi-char operator entries of the vendored KEYWORDS dict). */
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

/** Uppercased word → sqlglot TokenType name — the single-word entries of the
 *  vendored base tokenizer KEYWORDS. A word not present is an identifier (VAR).
 *  Space-compounds are handled by `COMPOUNDS` below, not here. */
const KEYWORDS: Record<string, string> = {
	ALL: 'ALL',
	AND: 'AND',
	ANTI: 'ANTI',
	ANY: 'ANY',
	ASC: 'ASC',
	AS: 'ALIAS',
	ASOF: 'ASOF',
	AUTOINCREMENT: 'AUTO_INCREMENT',
	AUTO_INCREMENT: 'AUTO_INCREMENT',
	BEGIN: 'BEGIN',
	BETWEEN: 'BETWEEN',
	CACHE: 'CACHE',
	UNCACHE: 'UNCACHE',
	CASE: 'CASE',
	COLLATE: 'COLLATE',
	COLUMN: 'COLUMN',
	COMMIT: 'COMMIT',
	CONSTRAINT: 'CONSTRAINT',
	COPY: 'COPY',
	CREATE: 'CREATE',
	CROSS: 'CROSS',
	CUBE: 'CUBE',
	CURRENT_DATE: 'CURRENT_DATE',
	CURRENT_SCHEMA: 'CURRENT_SCHEMA',
	CURRENT_TIME: 'CURRENT_TIME',
	CURRENT_TIMESTAMP: 'CURRENT_TIMESTAMP',
	CURRENT_USER: 'CURRENT_USER',
	CURRENT_CATALOG: 'CURRENT_CATALOG',
	DATABASE: 'DATABASE',
	DEFAULT: 'DEFAULT',
	DELETE: 'DELETE',
	DESC: 'DESC',
	DESCRIBE: 'DESCRIBE',
	DISTINCT: 'DISTINCT',
	DIV: 'DIV',
	DROP: 'DROP',
	ELSE: 'ELSE',
	END: 'END',
	ENUM: 'ENUM',
	ESCAPE: 'ESCAPE',
	EXCEPT: 'EXCEPT',
	EXECUTE: 'EXECUTE',
	EXISTS: 'EXISTS',
	FALSE: 'FALSE',
	FETCH: 'FETCH',
	FILTER: 'FILTER',
	FILE: 'FILE',
	FIRST: 'FIRST',
	FULL: 'FULL',
	FUNCTION: 'FUNCTION',
	FOR: 'FOR',
	FORMAT: 'FORMAT',
	FROM: 'FROM',
	GEOGRAPHY: 'GEOGRAPHY',
	GEOMETRY: 'GEOMETRY',
	GLOB: 'GLOB',
	HAVING: 'HAVING',
	ILIKE: 'ILIKE',
	IN: 'IN',
	INDEX: 'INDEX',
	INET: 'INET',
	INNER: 'INNER',
	INSERT: 'INSERT',
	INTERVAL: 'INTERVAL',
	INTERSECT: 'INTERSECT',
	INTO: 'INTO',
	IS: 'IS',
	ISNULL: 'ISNULL',
	JOIN: 'JOIN',
	KEEP: 'KEEP',
	KILL: 'KILL',
	LATERAL: 'LATERAL',
	LEFT: 'LEFT',
	LIKE: 'LIKE',
	LIMIT: 'LIMIT',
	LOAD: 'LOAD',
	LOCALTIME: 'LOCALTIME',
	LOCALTIMESTAMP: 'LOCALTIMESTAMP',
	LOCK: 'LOCK',
	MERGE: 'MERGE',
	NAMESPACE: 'NAMESPACE',
	NATURAL: 'NATURAL',
	NEXT: 'NEXT',
	NOT: 'NOT',
	NOTNULL: 'NOTNULL',
	NULL: 'NULL',
	OBJECT: 'OBJECT',
	OFFSET: 'OFFSET',
	ON: 'ON',
	OR: 'OR',
	XOR: 'XOR',
	ORDINALITY: 'ORDINALITY',
	OUT: 'OUT',
	OUTER: 'OUTER',
	OVER: 'OVER',
	OVERLAPS: 'OVERLAPS',
	OVERWRITE: 'OVERWRITE',
	PARTITION: 'PARTITION',
	PERCENT: 'PERCENT',
	PIVOT: 'PIVOT',
	PRAGMA: 'PRAGMA',
	PROCEDURE: 'PROCEDURE',
	OPERATOR: 'OPERATOR',
	QUALIFY: 'QUALIFY',
	RANGE: 'RANGE',
	RECURSIVE: 'RECURSIVE',
	REGEXP: 'RLIKE',
	RENAME: 'RENAME',
	REPLACE: 'REPLACE',
	RETURNING: 'RETURNING',
	REFERENCES: 'REFERENCES',
	RIGHT: 'RIGHT',
	RLIKE: 'RLIKE',
	ROLLBACK: 'ROLLBACK',
	ROLLUP: 'ROLLUP',
	ROW: 'ROW',
	ROWS: 'ROWS',
	SCHEMA: 'SCHEMA',
	SELECT: 'SELECT',
	SEMI: 'SEMI',
	SESSION: 'SESSION',
	SESSION_USER: 'SESSION_USER',
	SET: 'SET',
	SETTINGS: 'SETTINGS',
	SHOW: 'SHOW',
	SOME: 'SOME',
	STRAIGHT_JOIN: 'STRAIGHT_JOIN',
	TABLE: 'TABLE',
	TABLESAMPLE: 'TABLE_SAMPLE',
	TEMP: 'TEMPORARY',
	TEMPORARY: 'TEMPORARY',
	THEN: 'THEN',
	TRUE: 'TRUE',
	TRUNCATE: 'TRUNCATE',
	UNION: 'UNION',
	UNKNOWN: 'UNKNOWN',
	UNNEST: 'UNNEST',
	UNPIVOT: 'UNPIVOT',
	UPDATE: 'UPDATE',
	USE: 'USE',
	USING: 'USING',
	UUID: 'UUID',
	VALUES: 'VALUES',
	VIEW: 'VIEW',
	VOLATILE: 'VOLATILE',
	WHEN: 'WHEN',
	WHERE: 'WHERE',
	WINDOW: 'WINDOW',
	WITH: 'WITH',
	APPLY: 'APPLY',
	ARRAY: 'ARRAY',
	BIT: 'BIT',
	BOOL: 'BOOLEAN',
	BOOLEAN: 'BOOLEAN',
	BYTE: 'TINYINT',
	MEDIUMINT: 'MEDIUMINT',
	INT1: 'TINYINT',
	TINYINT: 'TINYINT',
	INT16: 'SMALLINT',
	SHORT: 'SMALLINT',
	SMALLINT: 'SMALLINT',
	HUGEINT: 'INT128',
	UHUGEINT: 'UINT128',
	INT2: 'SMALLINT',
	INTEGER: 'INT',
	INT: 'INT',
	INT4: 'INT',
	INT32: 'INT',
	INT64: 'BIGINT',
	INT128: 'INT128',
	INT256: 'INT256',
	LONG: 'BIGINT',
	BIGINT: 'BIGINT',
	INT8: 'TINYINT',
	UINT: 'UINT',
	UINT128: 'UINT128',
	UINT256: 'UINT256',
	DEC: 'DECIMAL',
	DECIMAL: 'DECIMAL',
	DECIMAL32: 'DECIMAL32',
	DECIMAL64: 'DECIMAL64',
	DECIMAL128: 'DECIMAL128',
	DECIMAL256: 'DECIMAL256',
	DECFLOAT: 'DECFLOAT',
	BIGDECIMAL: 'BIGDECIMAL',
	BIGNUMERIC: 'BIGDECIMAL',
	BIGNUM: 'BIGNUM',
	LIST: 'LIST',
	MAP: 'MAP',
	NULLABLE: 'NULLABLE',
	NUMBER: 'DECIMAL',
	NUMERIC: 'DECIMAL',
	FIXED: 'DECIMAL',
	REAL: 'FLOAT',
	FLOAT: 'FLOAT',
	FLOAT4: 'FLOAT',
	FLOAT8: 'DOUBLE',
	DOUBLE: 'DOUBLE',
	JSON: 'JSON',
	JSONB: 'JSONB',
	CHAR: 'CHAR',
	CHARACTER: 'CHAR',
	NCHAR: 'NCHAR',
	VARCHAR: 'VARCHAR',
	VARCHAR2: 'VARCHAR',
	NVARCHAR: 'NVARCHAR',
	NVARCHAR2: 'NVARCHAR',
	BPCHAR: 'BPCHAR',
	STR: 'TEXT',
	STRING: 'TEXT',
	TEXT: 'TEXT',
	LONGTEXT: 'LONGTEXT',
	MEDIUMTEXT: 'MEDIUMTEXT',
	TINYTEXT: 'TINYTEXT',
	CLOB: 'TEXT',
	LONGVARCHAR: 'TEXT',
	BINARY: 'BINARY',
	BLOB: 'VARBINARY',
	LONGBLOB: 'LONGBLOB',
	MEDIUMBLOB: 'MEDIUMBLOB',
	TINYBLOB: 'TINYBLOB',
	BYTEA: 'VARBINARY',
	VARBINARY: 'VARBINARY',
	TIME: 'TIME',
	TIMETZ: 'TIMETZ',
	TIME_NS: 'TIME_NS',
	TIMESTAMP: 'TIMESTAMP',
	TIMESTAMPTZ: 'TIMESTAMPTZ',
	TIMESTAMPLTZ: 'TIMESTAMPLTZ',
	TIMESTAMP_LTZ: 'TIMESTAMPLTZ',
	TIMESTAMPNTZ: 'TIMESTAMPNTZ',
	TIMESTAMP_NTZ: 'TIMESTAMPNTZ',
	DATE: 'DATE',
	DATETIME: 'DATETIME',
	UNIQUE: 'UNIQUE',
	VECTOR: 'VECTOR',
	STRUCT: 'STRUCT',
	SEQUENCE: 'SEQUENCE',
	VARIANT: 'VARIANT',
	ALTER: 'ALTER',
	ANALYZE: 'ANALYZE',
	CALL: 'COMMAND',
	COMMENT: 'COMMENT',
	EXPLAIN: 'COMMAND',
	GRANT: 'GRANT',
	REVOKE: 'REVOKE',
	OPTIMIZE: 'COMMAND',
	PREPARE: 'COMMAND',
	VACUUM: 'COMMAND',
};

/** Two-word keyword phrases sqlglot lexes as ONE token — the space-bearing
 *  entries of the vendored KEYWORDS dict. ANTLR emits the two words
 *  separately, so the mapper folds an adjacent (whitespace-only) pair. Key is
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

/** Per-dialect additions/overrides on top of the base KEYWORDS map above,
 *  transcribed from each vendored dialect's `Tokenizer.KEYWORDS` in
 *  resources/ftl/vendor/sqlglot/dialects/{tsql,snowflake,bigquery,databricks,
 *  spark,spark2,hive,redshift,postgres}.py, following each class's
 *  inheritance chain (databricks -> spark -> spark2 -> hive; redshift ->
 *  postgres). Consulted BEFORE the base KEYWORDS map in `singleType`. Entries
 *  identical to the base value (e.g. tsql's `REAL` -> FLOAT, postgres's
 *  `TEMP` -> TEMPORARY) are omitted as redundant. A dialect that *removes* a
 *  base keyword (`KEYWORDS.pop(...)`) is modeled here by mapping it to
 *  'VAR', matching sqlglot's fallback-to-identifier.
 *
 *  Not transcribed (out of scope for a *word*-keyed KEYWORDS layer):
 *   - symbol/operator overrides living in the same Python KEYWORDS dict but
 *     keyed on punctuation, not words (Postgres/Redshift `~`, `@>`, `?&`, …
 *     and the `/*+` hint marker every dialect here pops) — these belong with
 *     OPERATOR_TOKENS, which has no per-dialect variant yet;
 *   - Snowflake's `"FILE://": URI_START`, keyed on a URI scheme marker, not a
 *     plain word. */
const DIALECT_KEYWORDS: Partial<Record<Dialect, Record<string, string>>> = {
	tsql: {
		DATETIME2: 'DATETIME2',
		DATETIMEOFFSET: 'TIMESTAMPTZ',
		DECLARE: 'DECLARE',
		EXEC: 'COMMAND',
		GO: 'COMMAND',
		IMAGE: 'IMAGE',
		MONEY: 'MONEY',
		NTEXT: 'TEXT',
		OPTION: 'OPTION',
		OUTPUT: 'RETURNING',
		PRINT: 'COMMAND',
		PROC: 'PROCEDURE',
		ROWVERSION: 'ROWVERSION',
		SMALLDATETIME: 'SMALLDATETIME',
		SMALLMONEY: 'SMALLMONEY',
		SQL_VARIANT: 'VARIANT',
		SYSTEM_USER: 'CURRENT_USER',
		TOP: 'TOP',
		TIMESTAMP: 'ROWVERSION',
		TINYINT: 'UTINYINT',
		UNIQUEIDENTIFIER: 'UUID',
		XML: 'XML',
	},
	snowflake: {
		BYTEINT: 'INT',
		GET: 'GET',
		MATCH_CONDITION: 'MATCH_CONDITION',
		MATCH_RECOGNIZE: 'MATCH_RECOGNIZE',
		MINUS: 'EXCEPT',
		PUT: 'PUT',
		REMOVE: 'COMMAND',
		RM: 'COMMAND',
		SAMPLE: 'TABLE_SAMPLE',
		SQL_DOUBLE: 'DOUBLE',
		SQL_VARCHAR: 'VARCHAR',
		STAGE: 'STAGE',
		STREAMLIT: 'STREAMLIT',
		TAG: 'TAG',
		TIMESTAMP_TZ: 'TIMESTAMPTZ',
		TOP: 'TOP',
		WAREHOUSE: 'WAREHOUSE',
		// Snowflake treats FLOAT as a synonym for DOUBLE.
		FLOAT: 'DOUBLE',
	},
	bigquery: {
		BYTEINT: 'INT',
		BYTES: 'BINARY',
		// The bare word starts a BEGIN…EXCEPTION…END block (command); the
		// two-word phrase below is the actual transaction-start keyword.
		BEGIN: 'COMMAND',
		CURRENT_DATETIME: 'CURRENT_DATETIME',
		DATETIME: 'TIMESTAMP',
		DECLARE: 'DECLARE',
		ELSEIF: 'COMMAND',
		EXCEPTION: 'COMMAND',
		EXPORT: 'EXPORT',
		FLOAT64: 'DOUBLE',
		LOOP: 'COMMAND',
		MODEL: 'MODEL',
		RECORD: 'STRUCT',
		REPEAT: 'COMMAND',
		TIMESTAMP: 'TIMESTAMPTZ',
		WHILE: 'COMMAND',
		// KEYWORDS.pop(...): identifiers in BigQuery, not keywords.
		DIV: 'VAR',
		VALUES: 'VAR',
	},
	databricks: {
		// Hive (base of the databricks -> spark -> spark2 -> hive chain).
		MINUS: 'EXCEPT',
		REFRESH: 'REFRESH',
		SERDEPROPERTIES: 'SERDE_PROPERTIES',
		// Spark2 override.
		TIMESTAMP: 'TIMESTAMPTZ',
		// Databricks's own addition.
		VOID: 'VOID',
	},
	redshift: {
		// Postgres (Redshift's base).
		BIGSERIAL: 'BIGSERIAL',
		CSTRING: 'PSEUDO_TYPE',
		DECLARE: 'COMMAND',
		DO: 'COMMAND',
		EXEC: 'COMMAND',
		HSTORE: 'HSTORE',
		INT8: 'BIGINT',
		MONEY: 'MONEY',
		NAME: 'NAME',
		OID: 'OBJECT_IDENTIFIER',
		ONLY: 'ONLY',
		POINT: 'POINT',
		REFRESH: 'COMMAND',
		REINDEX: 'COMMAND',
		RESET: 'COMMAND',
		SERIAL: 'SERIAL',
		SMALLSERIAL: 'SMALLSERIAL',
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
		XML: 'XML',
		// Redshift's own additions.
		HLLSKETCH: 'HLLSKETCH',
		MINUS: 'EXCEPT',
		SUPER: 'SUPER',
		TOP: 'TOP',
		UNLOAD: 'COMMAND',
		VARBYTE: 'VARBINARY',
		// KEYWORDS.pop(...): identifiers in Postgres/Redshift, not keywords.
		DIV: 'VAR',
		VALUES: 'VAR',
	},
};

/** Per-dialect additions to COMPOUNDS above (two-word phrases sqlglot lexes
 *  as one token), transcribed the same way and checked before COMPOUNDS.
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

/** Map one already-de-compounded sqllens token to a sqlglot TokenType name. */
function singleType(tok: Token, dialect: Dialect): string {
	switch (tok.role) {
		case 'string':
			return 'STRING';
		case 'number':
			return 'NUMBER';
		case 'identifier':
			return isQuotedIdentifier(tok.text) ? 'IDENTIFIER' : 'VAR';
	}
	const bySymbol = OPERATOR_TOKENS[tok.text];
	if (bySymbol) return bySymbol;
	const upper = tok.text.toUpperCase();
	const dialectKw = DIALECT_KEYWORDS[dialect]?.[upper];
	if (dialectKw) return dialectKw;
	const kw = KEYWORDS[upper];
	if (kw) return kw;
	// A word ANTLR reserved that sqlglot does not know is an identifier (VAR);
	// an unmapped symbol keeps its uppercased text as a last resort.
	return /^[A-Z_][A-Z0-9_$]*$/.test(upper) ? 'VAR' : upper;
}

/** Next non-whitespace token after index `i`, or null if a comment intervenes
 *  (sqlglot's keyword trie folds across whitespace only) or the stream ends. */
function nextKeywordCandidate(tokens: Token[], i: number): { tok: Token; index: number } | null {
	for (let j = i + 1; j < tokens.length; j++) {
		const t = tokens[j];
		if (t.role === 'whitespace') continue;
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
		if (tok.role === 'whitespace') continue;
		if (tok.role === 'comment') {
			// ANTLR's line-comment token swallows the trailing newline; sqlglot's
			// span ends AT the newline. The printer re-slices source by [start,end),
			// so a span must never include the newline. `end` is exclusive.
			let end = tok.stop + 1;
			while (end > tok.start && (sql[end - 1] === '\n' || sql[end - 1] === '\r')) end--;
			pending.push({ start: tok.start, end, text: sql.slice(tok.start, end) });
			continue;
		}

		let type: string | undefined;
		let endTok = tok;
		if (tok.role === 'keyword') {
			const nx = nextKeywordCandidate(tokens, i);
			if (nx && nx.tok.role === 'keyword') {
				const pairKey = `${tok.text.toUpperCase()} ${nx.tok.text.toUpperCase()}`;
				const compound = DIALECT_COMPOUNDS[dialect]?.[pairKey] ?? COMPOUNDS[pairKey];
				if (compound) {
					type = compound;
					endTok = nx.tok;
					i = nx.index;
				}
			}
		}
		if (type === undefined) type = singleType(tok, dialect);

		const line = lineAtOffset(endTok.stop, lineStarts);
		const st: SqlToken = {
			type,
			start: tok.start,
			end: endTok.stop,
			line,
			col: endTok.stop - lineStarts[line] + 1,
		};
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
