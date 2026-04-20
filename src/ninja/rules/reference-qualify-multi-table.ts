import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange, tokenText } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * RF02 — In queries with multiple tables (FROM + at least one JOIN), column
 * references should be qualified with a table name or alias. Unqualified column
 * references are ambiguous when more than one source is present.
 *
 * Detection strategy:
 * 1. Count JOIN keywords at depth 0. If none, skip.
 * 2. Walk only the SELECT-list body (tokens between SELECT and the first
 *    depth-0 FROM). Flag VAR tokens that are:
 *    - Not preceded by DOT (not the column in table.column)
 *    - Not followed by L_PAREN (not a function name)
 *    - Not preceded by AS (not an alias definition)
 *    - Not followed by DOT (not a table qualifier)
 */
export const qualifyMultiTableRule: TokenRule = {
	id: 'ninja.reference.qualify-multi-table',
	type: 'token',
	category: NinjaCategory.Reference,
	defaultSeverity: 'warning',
	description: 'Column references should be qualified with a table name or alias when multiple tables are present.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		// Count JOIN keywords at depth 0 to determine if this is a multi-table query.
		let depth = 0;
		let joinCount = 0;
		for (const tok of tokens) {
			if (tok.type === 'L_PAREN') { depth++; continue; }
			if (tok.type === 'R_PAREN') { depth = Math.max(0, depth - 1); continue; }
			if (depth === 0 && tok.type === 'JOIN') joinCount++;
		}

		if (joinCount === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		// Walk the token stream. We only want to flag column-like VARs that appear
		// in the SELECT list — i.e. between the outermost SELECT and its FROM clause.
		// Strategy: track whether we are "inside the select list" at depth 0.
		// Enter select-list mode on SELECT at depth 0, exit on FROM/WHERE/GROUP/HAVING/ORDER/LIMIT at depth 0.
		const SELECT_CLAUSES = new Set(['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT']);

		depth = 0;
		let inSelectList = false;

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];

			if (tok.type === 'L_PAREN') { depth++; continue; }
			if (tok.type === 'R_PAREN') { depth = Math.max(0, depth - 1); continue; }

			if (depth === 0) {
				if (tok.type === 'SELECT') { inSelectList = true; continue; }
				if (SELECT_CLAUSES.has(tok.type)) { inSelectList = false; continue; }
			}

			if (!inSelectList || depth !== 0) continue;
			if (tok.type !== 'VAR') continue;

			const prev = tokens[i - 1];
			const next = tokens[i + 1];

			// Skip if preceded by DOT — this is the column part of table.column
			if (prev && prev.type === 'DOT') continue;

			// Skip if followed by DOT — this is the table qualifier in table.column
			if (next && next.type === 'DOT') continue;

			// Skip if followed by L_PAREN — this is a function call
			if (next && next.type === 'L_PAREN') continue;

			// Skip if preceded by AS — this is an alias definition
			if (prev && (prev.type === 'AS' || tokenText(text, prev).toUpperCase() === 'AS')) continue;

			const raw = text.slice(tok.start, tok.end + 1);
			const range = tokenRange(text, tok);
			violations.push({
				rule: 'ninja.reference.qualify-multi-table',
				message: `Column '${raw}' is unqualified — qualify it with a table name or alias when multiple tables are present.`,
				range,
			});
		}

		return violations;
	},
};
