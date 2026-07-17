import * as vscode from 'vscode';
import type { ILogger } from '../../types/logger';
import type { ParseService } from '../../services/parse-service';
import type { Completion } from '../../ftl/sqllens/api';
import { isLinePositionInComment } from '../common/comment-utils';
import { DbtCompletionKind } from '../common/icons';

/** sqllens completion kind -> the editor's CompletionItemKind. Functions and keywords are handled
 *  separately (they carry a snippet / a late sort), so this covers the "content" kinds only. */
const COMPLETION_KIND: Record<Exclude<Completion['kind'], 'function' | 'keyword'>, vscode.CompletionItemKind> = {
	template: DbtCompletionKind.modelRef, // a dbt name for a jinja call slot (ref model, source, macro)
	cte: DbtCompletionKind.cte,
	table: DbtCompletionKind.modelRef,
	namespace: DbtCompletionKind.namespace,
	column: DbtCompletionKind.column,
};

/**
 * Editor completions for Jinja SQL. ONE sqllens `completeAt` call at the caret produces every
 * candidate for whatever slot the parse says we are in: a jinja call slot (kind "template",
 * named by our manifest-backed template provider), SQL functions/keywords, in-scope CTE names,
 * catalog tables (our `tables()`), qualified-path segments (our `childrenOf()`), and
 * qualifier-filtered columns. This provider only maps those candidates to `CompletionItem`s.
 *
 * The former line-prefix dispatch is gone: no FROM/JOIN regexes, no `alias.` back-scan, no FQN
 * parsing, no jinja-tag guard. sqllens decides the slot (a caret inside a tag never leaks SQL
 * completion), the manifest-backed provider fills the dbt catalog, and the parse — not a
 * backwards scan of the line — is the single source of truth.
 */
export class DbtCompletionProvider implements vscode.CompletionItemProvider {
	constructor(
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) { }

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		_context: vscode.CompletionContext,
	): vscode.CompletionItem[] | undefined {
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.completion', true)) return undefined;
		// Never complete inside a SQL line comment.
		if (isLinePositionInComment(document.lineAt(position.line).text, position.character)) return undefined;

		// ONE call at the caret. Since sqllens 1.4.0 the caret token is the token being typed, so a
		// single offset serves both jinja slots and the SQL walk — no context pre-detection, no
		// word-start anchoring.
		const candidates = this.parseService.completeAt(document.getText(), document.offsetAt(position));
		if (candidates.length === 0) return undefined;

		let rank = 0;
		const items = candidates.map(c => this._toItem(c, () => String(rank++).padStart(4, '0')));
		this.logger.debug(`Completion: ${items.length} candidates from sqllens`);
		return items;
	}

	/** Map one sqllens candidate to an editor item. Functions and keywords sort AFTER everything
	 *  else (`8_`/`9_` prefixes) so columns, CTEs, tables, namespaces and template names surface
	 *  first — in sqllens's own order, which shadow-ranks in-scope CTEs ahead of same-named tables. */
	private _toItem(c: Completion, nextRank: () => string): vscode.CompletionItem {
		if (c.kind === 'function') {
			const item = new vscode.CompletionItem(c.label, DbtCompletionKind.sqlFunction);
			item.detail = c.detail ?? 'SQL function';
			item.insertText = new vscode.SnippetString(`${c.label}($0)`);
			item.sortText = `8_${c.label}`;
			return item;
		}
		if (c.kind === 'keyword') {
			const item = new vscode.CompletionItem(c.label, DbtCompletionKind.keyword);
			if (c.detail) item.detail = c.detail;
			item.sortText = `9_${c.label}`;
			return item;
		}
		const item = new vscode.CompletionItem(c.label, COMPLETION_KIND[c.kind]);
		if (c.detail) item.detail = c.detail;
		item.sortText = nextRank();
		return item;
	}
}
