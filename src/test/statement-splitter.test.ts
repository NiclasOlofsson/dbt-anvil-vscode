import { describe, expect, it } from 'vitest';
import { findStatementAtOffset, splitStatements } from '../dbt/statement-splitter';

describe('splitStatements', () => {
	// ── Single statement ──────────────────────────────────────────────────

	it('returns a single statement when no semicolon', () => {
		const sql = 'SELECT 1';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(1);
		expect(stmts[0].sql).toBe('SELECT 1');
	});

	it('returns a single statement with trailing semicolon', () => {
		const sql = 'SELECT 1;';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(1);
		expect(stmts[0].sql).toBe('SELECT 1');
	});

	// ── Multiple statements ───────────────────────────────────────────────

	it('splits two statements', () => {
		const sql = 'SELECT 1;\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
		expect(stmts[0].sql).toBe('SELECT 1');
		expect(stmts[1].sql).toBe('SELECT 2');
	});

	it('splits three statements with trailing semicolon', () => {
		const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(3);
	});

	it('discards empty statements from consecutive semicolons', () => {
		const sql = 'SELECT 1;;\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
		expect(stmts[0].sql).toBe('SELECT 1');
		expect(stmts[1].sql).toBe('SELECT 2');
	});

	it('discards whitespace-only segments', () => {
		const sql = 'SELECT 1;\n  \n;\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
	});

	// ── Semicolons inside strings ─────────────────────────────────────────

	it('ignores semicolons inside single-quoted strings', () => {
		const sql = 'SELECT \'a;b\';\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
		expect(stmts[0].sql).toBe('SELECT \'a;b\'');
	});

	it('handles escaped single quotes in strings', () => {
		const sql = 'SELECT \'it\'\'s;here\';\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
		expect(stmts[0].sql).toBe('SELECT \'it\'\'s;here\'');
	});

	// ── Semicolons inside comments ────────────────────────────────────────

	it('ignores semicolons inside line comments', () => {
		const sql = 'SELECT 1 -- a;b\n;\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
		expect(stmts[0].sql).toBe('SELECT 1 -- a;b');
	});

	it('ignores semicolons inside block comments', () => {
		const sql = 'SELECT 1 /* a;b */;\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
		expect(stmts[0].sql).toBe('SELECT 1 /* a;b */');
	});

	// ── Jinja ─────────────────────────────────────────────────────────────

	it('ignores semicolons inside Jinja expression tags', () => {
		const sql = 'SELECT {{ ref(\'model;name\') }};\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
		// The original SQL is preserved (not blanked)
		expect(stmts[0].sql).toBe('SELECT {{ ref(\'model;name\') }}');
	});

	it('ignores semicolons inside Jinja block tags', () => {
		const sql = '{% set x = \'a;b\' %}\nSELECT 1;\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
	});

	it('handles Jinja blocks spanning statement boundaries', () => {
		const sql = '{% if true %}\nSELECT 1;\n{% endif %}\nSELECT 2';
		const stmts = splitStatements(sql);
		// The {% if %}/{% endif %} are blanked to spaces, so the actual
		// split happens at the semicolons as expected
		expect(stmts).toHaveLength(2);
	});

	it('preserves Jinja in the returned SQL text', () => {
		const sql = 'SELECT {{ ref(\'orders\') }}';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(1);
		expect(stmts[0].sql).toBe('SELECT {{ ref(\'orders\') }}');
	});

	// ── Offset tracking ──────────────────────────────────────────────────

	it('tracks correct line numbers', () => {
		const sql = 'SELECT 1;\n\nSELECT 2;\n\nSELECT 3';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(3);
		expect(stmts[0].startLine).toBe(0);
		expect(stmts[0].endLine).toBe(0);
		expect(stmts[1].startLine).toBe(2);
		expect(stmts[1].endLine).toBe(2);
		expect(stmts[2].startLine).toBe(4);
		expect(stmts[2].endLine).toBe(4);
	});

	it('tracks correct offsets', () => {
		const sql = 'SELECT 1;\nSELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts[0].startOffset).toBe(0);
		expect(stmts[0].endOffset).toBe(8); // 'SELECT 1' length
		expect(stmts[1].startOffset).toBe(10); // after ';\n'
		expect(stmts[1].endOffset).toBe(18);
	});

	it('handles leading whitespace correctly', () => {
		const sql = '  SELECT 1;\n  SELECT 2';
		const stmts = splitStatements(sql);
		expect(stmts[0].sql).toBe('SELECT 1');
		expect(stmts[0].startOffset).toBe(2); // skip leading spaces
		expect(stmts[1].sql).toBe('SELECT 2');
	});

	// ── Multi-line statements ────────────────────────────────────────────

	it('handles multi-line statements', () => {
		const sql = 'SELECT\n  a,\n  b\nFROM t;\nSELECT 1';
		const stmts = splitStatements(sql);
		expect(stmts).toHaveLength(2);
		expect(stmts[0].sql).toBe('SELECT\n  a,\n  b\nFROM t');
		expect(stmts[0].startLine).toBe(0);
		expect(stmts[0].endLine).toBe(3);
	});

	// ── Edge cases ────────────────────────────────────────────────────────

	it('returns empty array for empty input', () => {
		expect(splitStatements('')).toHaveLength(0);
	});

	it('returns empty array for whitespace-only input', () => {
		expect(splitStatements('  \n  \n  ')).toHaveLength(0);
	});

	it('returns empty array for semicolons only', () => {
		expect(splitStatements(';;;')).toHaveLength(0);
	});
});

describe('splitStatements — compound blocks (sqllens 1.10 cells)', () => {
	// A block's inner semicolons must not cut it: parsing `end try begin catch ...`
	// as its own statement is what produced "expecting CONVERSATION" on T-SQL.
	it('keeps a BEGIN TRY ... END CATCH batch as one statement', () => {
		const sql = [
			'begin try',
			'  begin transaction;',
			'  insert into t (a) select a from s;',
			'  commit transaction;',
			'end try',
			'begin catch',
			'  if @@trancount > 0 rollback transaction;',
			'  throw;',
			'end catch;',
			'select 1 as x;',
		].join('\n');
		const stmts = splitStatements(sql, 'fabric');
		expect(stmts).toHaveLength(2);
		expect(stmts[0].sql.startsWith('begin try')).toBe(true);
		expect(stmts[0].sql.endsWith('end catch')).toBe(true);
		expect(stmts[1].sql).toBe('select 1 as x');
	});

	it('keeps the block whole inside a jinja call/if wrapper (the materialization shape)', () => {
		const sql = [
			'{% if true %}',
			'{% call statement(\'swap\') -%}',
			'begin try',
			'  begin transaction;',
			'  exec sp_rename \'a\', \'b\';',
			'  commit transaction;',
			'end try',
			'begin catch',
			'  throw;',
			'end catch',
			'{%- endcall %}',
			'{% endif %}',
		].join('\n');
		const stmts = splitStatements(sql, 'fabric');
		expect(stmts).toHaveLength(1);
	});

	it('still splits after a bare BEGIN TRANSACTION, which opens no block', () => {
		const sql = 'begin transaction;\nselect 1;\ncommit;';
		const stmts = splitStatements(sql, 'fabric');
		expect(stmts.map(s => s.sql)).toEqual(['begin transaction', 'select 1', 'commit']);
	});

	it('cuts on a T-SQL GO alone on its line and drops the separator from the text', () => {
		const sql = 'select 1 as a\nGO\nselect 2 as b\nGO';
		const stmts = splitStatements(sql, 'fabric');
		expect(stmts.map(s => s.sql)).toEqual(['select 1 as a', 'select 2 as b']);
		expect(stmts[1].startLine).toBe(2);
	});

	it('cuts a GO line that carries a trailing comment', () => {
		const sql = 'select 1 as a\nGO -- run it\nselect 2 as b';
		const stmts = splitStatements(sql, 'fabric');
		expect(stmts.map(s => s.sql)).toEqual(['select 1 as a', 'select 2 as b']);
	});

	it('cuts a GO line followed only by a trailing comment, with nothing after it', () => {
		const sql = 'select 1 as a\nGO\n-- end of file';
		const stmts = splitStatements(sql, 'fabric');
		expect(stmts.map(s => s.sql)).toEqual(['select 1 as a']);
	});

	it('does not strip a trailing "go" outside T-SQL dialects', () => {
		const sql = 'select *\nfrom orders\ngo';
		const stmts = splitStatements(sql, 'duckdb');
		expect(stmts).toHaveLength(1);
		expect(stmts[0].sql.endsWith('go')).toBe(true);
	});

	it('does not mistake an identifier containing "go" for the GO separator', () => {
		const sql = 'select 1 as go_flag\nGO\nselect 2';
		const stmts = splitStatements(sql, 'fabric');
		expect(stmts.map(s => s.sql)).toEqual(['select 1 as go_flag', 'select 2']);
	});

	// An unclosed opener must not swallow the rest of the file into one cell:
	// the statements below a half-typed CASE would otherwise run as its tail.
	it('still cuts at separators after an unclosed CASE', () => {
		const sql = 'select case when a = 1 then 2 from t;\ndelete from staging.orders;';
		const stmts = splitStatements(sql, 'fabric');
		expect(stmts.map(s => s.sql)).toEqual(['select case when a = 1 then 2 from t', 'delete from staging.orders']);
	});
});

describe('findStatementAtOffset', () => {
	const sql = 'SELECT 1;\n\nSELECT 2;\n\nSELECT 3';
	const stmts = splitStatements(sql);

	it('finds statement when cursor is inside it', () => {
		// Cursor at 'S' of 'SELECT 1'
		const result = findStatementAtOffset(stmts, 0);
		expect(result?.sql).toBe('SELECT 1');
	});

	it('finds second statement', () => {
		// Cursor at 'S' of 'SELECT 2' (offset 11)
		const result = findStatementAtOffset(stmts, 11);
		expect(result?.sql).toBe('SELECT 2');
	});

	it('finds nearest statement when cursor is in whitespace between statements', () => {
		// Cursor at the blank line between stmt 1 and stmt 2 (offset 10 = '\n')
		const result = findStatementAtOffset(stmts, 10);
		expect(result).toBeDefined();
		// Should find nearest — either stmt 1 or stmt 2
		expect(['SELECT 1', 'SELECT 2']).toContain(result!.sql);
	});

	it('finds last statement when cursor is at end', () => {
		const result = findStatementAtOffset(stmts, sql.length - 1);
		expect(result?.sql).toBe('SELECT 3');
	});

	it('finds nearest statement for offset beyond end', () => {
		const result = findStatementAtOffset(stmts, sql.length + 10);
		expect(result?.sql).toBe('SELECT 3');
	});

	it('returns undefined for empty statement list', () => {
		expect(findStatementAtOffset([], 5)).toBeUndefined();
	});
});
