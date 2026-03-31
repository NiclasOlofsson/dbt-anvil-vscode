import * as vscode from 'vscode';
import type { QueryRunner } from '../dbt/query-runner';

const RUNNING_ICON = 'data:image/svg+xml,' + encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
	+ '<circle cx="11" cy="2.5" r="1.5" fill="#007acc"/>'
	+ '<line x1="10.5" y1="4" x2="8" y2="9" stroke="#007acc" stroke-width="1.5" stroke-linecap="round"/>'
	+ '<line x1="10" y1="6" x2="13.5" y2="4.5" stroke="#007acc" stroke-width="1.5" stroke-linecap="round"/>'
	+ '<line x1="9.5" y1="6" x2="6.5" y2="8" stroke="#007acc" stroke-width="1.5" stroke-linecap="round"/>'
	+ '<path d="M8 9 L11 12.5 L13 14" stroke="#007acc" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
	+ '<line x1="8" y1="9" x2="4.5" y2="13.5" stroke="#007acc" stroke-width="1.5" stroke-linecap="round"/>'
	+ '</svg>',
);

export class QueryDecorationProvider implements vscode.Disposable {
	private readonly _runningType = vscode.window.createTextEditorDecorationType({
		gutterIconPath: vscode.Uri.parse(RUNNING_ICON),
		gutterIconSize: 'contain',
	});

	private _running: { uri: string; line: number } | undefined;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(queryRunner: QueryRunner) {
		this._disposables.push(
			queryRunner.onRunningChange(state => {
				this._running = state;
				this._applyToActiveEditor();
			}),
			vscode.window.onDidChangeActiveTextEditor(() => this._applyToActiveEditor()),
		);
	}

	private _applyToActiveEditor(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		if (this._running && editor.document.uri.toString() === this._running.uri) {
			const lineIndex = Math.min(this._running.line, editor.document.lineCount - 1);
			const line = editor.document.lineAt(lineIndex);
			editor.setDecorations(this._runningType, [line.range]);
		} else {
			editor.setDecorations(this._runningType, []);
		}
	}

	dispose(): void {
		this._runningType.dispose();
		this._disposables.forEach(d => d.dispose());
	}
}
