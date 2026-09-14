import { minijinja, statementSpans, toSqllensDialect, type StatementCellSpan } from '../ftl/sqllens/api';
import { DBT_PROVIDER } from '../ftl/sqllens/template-shape';

/**
 * A single SQL statement extracted from a multi-statement document.
 * Offsets refer to the original source text.
 */
export interface StatementRange {
	/** The original SQL text of this statement (trimmed, no trailing `;`). */
	sql: string;
	/** 0-based line number of the first non-whitespace character. */
	startLine: number;
	/** 0-based line number of the last non-whitespace character. */
	endLine: number;
	/** 0-based character offset into the full document where the statement starts. */
	startOffset: number;
	/** 0-based character offset into the full document where the statement ends (exclusive of `;`). */
	endOffset: number;
}

const MINIJINJA = minijinja();

/**
 * Split a jinja-SQL document into statements the way sqllens cuts its statement
 * cells: at `;` outside strings, comments and jinja tags, at compound depth zero
 * (a `BEGIN ... END`, `CASE ... END` or `BEGIN TRY ... END CATCH` block is one
 * statement), plus a T-SQL `GO` alone on its line. `adapterType` is the dbt
 * adapter (or dialect) name; absent, the default dialect applies.
 */
export function splitStatements(sql: string, adapterType?: string): StatementRange[] {
	const spans = statementSpans(sql, toSqllensDialect(adapterType), { templating: MINIJINJA, provider: DBT_PROVIDER });
	return rangesFromCells(sql, spans);
}

/**
 * Project sqllens statement cell spans onto `StatementRange`s over `sql`. A cell
 * span tiles the document (leading trivia and the trailing separator included);
 * the range is the trimmed statement text ending before the cell's separator.
 * Empty cells (`;;`, trailing whitespace) yield nothing.
 */
export function rangesFromCells(sql: string, cells: readonly StatementCellSpan[]): StatementRange[] {
	const results: StatementRange[] = [];
	for (const cell of cells) {
		let start = cell.start;
		let end = cell.separator?.start ?? cell.end;
		while (start < end && /\s/.test(sql[start])) start++;
		while (end > start && /\s/.test(sql[end - 1])) end--;
		if (end <= start) continue;
		results.push({
			sql: sql.slice(start, end),
			startLine: lineAt(sql, start),
			endLine: lineAt(sql, end - 1),
			startOffset: start,
			endOffset: end,
		});
	}
	return results;
}

/**
 * Given a list of statement ranges and a character offset (e.g. cursor position),
 * return the statement that contains that offset, or undefined if the offset
 * falls in whitespace/separator between statements.
 */
export function findStatementAtOffset(statements: StatementRange[], offset: number): StatementRange | undefined {
	for (const stmt of statements) {
		if (offset >= stmt.startOffset && offset < stmt.endOffset) {
			return stmt;
		}
	}
	// Offset is in whitespace — find the nearest statement.
	// Prefer the statement whose range is closest.
	let closest: StatementRange | undefined;
	let minDist = Infinity;
	for (const stmt of statements) {
		const dist = offset < stmt.startOffset
			? stmt.startOffset - offset
			: offset - stmt.endOffset;
		if (dist < minDist) {
			minDist = dist;
			closest = stmt;
		}
	}
	return closest;
}

/** Return the 0-based line number for a character offset in `text`. */
function lineAt(text: string, offset: number): number {
	let line = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === '\n') line++;
	}
	return line;
}
