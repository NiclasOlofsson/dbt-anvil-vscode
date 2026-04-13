import * as vscode from 'vscode';

export class SymbolSqlProvider implements vscode.TextDocumentContentProvider {
	static readonly scheme = 'dbt-symbol-sql';
	static readonly uri = vscode.Uri.parse(`${SymbolSqlProvider.scheme}://session/current.symql`);

	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	private _content = '';
	private _opened = false;

	provideTextDocumentContent(): string {
		return this._content;
	}

	async update(sql: string): Promise<void> {
		this._content = sql;
		this._onDidChange.fire(SymbolSqlProvider.uri);
		if (!this._opened) {
			this._opened = true;
			const doc = await vscode.workspace.openTextDocument(SymbolSqlProvider.uri);
			await vscode.languages.setTextDocumentLanguage(doc, 'dbt-symbol-sql');
			await vscode.window.showTextDocument(doc, {
				viewColumn: vscode.ViewColumn.Beside,
				preview: true,
				preserveFocus: true,
			});
		}
	}

	clear(): void {
		this._content = '';
		this._opened = false;
		this._onDidChange.fire(SymbolSqlProvider.uri);
	}
}
