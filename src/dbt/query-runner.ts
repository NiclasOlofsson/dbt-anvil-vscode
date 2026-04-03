import * as vscode from 'vscode';
import type { DatabaseProvider, QueryResult } from '../providers/database/database-provider';
import { Priority } from './execution-service';
import { splitStatements, findStatementAtOffset } from './statement-splitter';

/** Result for a single statement execution — either success or error. */
export interface StatementResult {
	sql: string;
	index: number;
	result?: QueryResult;
	error?: string;
}

/**
 * Orchestrates ad-hoc SQL execution against the configured database provider.
 *
 * Responsibilities:
 * - Determine what to execute (selection, cursor statement, or all)
 * - Split multi-statement SQL
 * - Execute each statement sequentially via DatabaseProvider.query()
 * - Collect results and forward to the result panel
 */
export class QueryRunner {
	private _abortController: AbortController | undefined;
	private _runningUri: string | undefined;
	private _runningLine: number | undefined;
	private readonly _onRunningChange = new vscode.EventEmitter<{ uri: string; line: number } | undefined>();
	readonly onRunningChange = this._onRunningChange.event;

	get runningUri(): string | undefined { return this._runningUri; }
	get runningLine(): number | undefined { return this._runningLine; }

	constructor(
		private readonly _databaseProvider: DatabaseProvider,
		private readonly _onResults: (results: StatementResult[], resultLocation?: string) => void,
	) {}

	/** Cancel any in-flight query execution. */
	cancel(): void {
		this._abortController?.abort();
		this._abortController = undefined;
	}

	/**
	 * Execute the appropriate SQL from the active editor.
	 *
	 * F5 behaviour:
	 * - Selection exists → execute selected text (split if multi-statement)
	 * - No selection → find statement under cursor → execute that one
	 */
	async executeFromEditor(editor: vscode.TextEditor): Promise<void> {
		const doc = editor.document;
		const selection = editor.selection;
		const limit = vscode.workspace.getConfiguration('dbt-studio').get<number>('queryEditor.defaultLimit', 500);

		let sqlToExecute: string;

		if (!selection.isEmpty) {
			sqlToExecute = doc.getText(selection);
		} else {
			const fullText = doc.getText();
			const offset = doc.offsetAt(selection.active);
			const statements = splitStatements(fullText);

			if (statements.length === 0) return;

			const stmt = findStatementAtOffset(statements, offset);
			if (!stmt) return;
			sqlToExecute = stmt.sql;
		}

		await this._executeStatements(sqlToExecute, limit);
	}

	/** Execute all statements in the active editor. */
	async executeAll(editor: vscode.TextEditor): Promise<void> {
		const limit = vscode.workspace.getConfiguration('dbt-studio').get<number>('queryEditor.defaultLimit', 500);
		await this._executeStatements(editor.document.getText(), limit, undefined, editor.document.uri.toString());
	}

	/** Execute a single SQL string (from CodeLens or debug adapter). */
	async executeSql(sql: string, limit?: number): Promise<void> {
		const effectiveLimit = limit ?? vscode.workspace.getConfiguration('dbt-studio').get<number>('queryEditor.defaultLimit', 500);
		await this._executeStatements(sql, effectiveLimit);
	}

	/** Execute with explicit config (from debug adapter launch configuration). */
	async executeWithConfig(editor: vscode.TextEditor, config: { limit: number; scope: 'cursor' | 'all'; resultLocation?: string }): Promise<void> {
		if (config.scope === 'all') {
			await this._executeStatements(editor.document.getText(), config.limit, config.resultLocation, editor.document.uri.toString());
			return;
		}

		const doc = editor.document;
		const selection = editor.selection;
		let sqlToExecute: string;

		let lineOffset = 0;
		if (!selection.isEmpty) {
			sqlToExecute = doc.getText(selection);
			lineOffset = selection.start.line;
		} else {
			const fullText = doc.getText();
			const offset = doc.offsetAt(selection.active);
			const statements = splitStatements(fullText);
			if (statements.length === 0) return;
			const stmt = findStatementAtOffset(statements, offset);
			if (!stmt) return;
			sqlToExecute = stmt.sql;
			lineOffset = stmt.startLine;
		}

		await this._executeStatements(sqlToExecute, config.limit, config.resultLocation, editor.document.uri.toString(), lineOffset);
	}

	private async _executeStatements(sql: string, limit: number, resultLocation?: string, runningUri?: string, lineOffset = 0): Promise<void> {
		const statements = splitStatements(sql);
		if (statements.length === 0) return;

		const stopOnError = vscode.workspace.getConfiguration('dbt-studio').get<boolean>('queryEditor.stopOnError', false);

		if (runningUri) {
			this._runningUri = runningUri;
		}

		this.cancel();
		this._abortController = new AbortController();
		const signal = this._abortController.signal;

		const results: StatementResult[] = [];

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Executing query…', cancellable: true },
			async (progress, token) => {
				token.onCancellationRequested(() => this.cancel());

				for (let i = 0; i < statements.length; i++) {
					if (signal.aborted) break;

					const stmt = statements[i];
					progress.report({ message: `Statement ${i + 1}/${statements.length}`, increment: (100 / statements.length) });

					if (runningUri) {
						this._runningLine = lineOffset + stmt.startLine;
						this._onRunningChange.fire({ uri: runningUri, line: lineOffset + stmt.startLine });
					}

					try {
						const result = await this._databaseProvider.query(stmt.sql, limit, signal, Priority.User);
						results.push({ sql: stmt.sql, index: i, result });
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						results.push({ sql: stmt.sql, index: i, error: message });
						if (stopOnError) break;
					}
				}
			},
		);

		this._abortController = undefined;
		this._runningUri = undefined;
		this._runningLine = undefined;
		this._onRunningChange.fire(undefined);
		this._onResults(results, resultLocation);
	}
}
