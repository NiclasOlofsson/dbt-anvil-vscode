import * as vscode from 'vscode';
import type { ModelProfiler } from '../dbt/model-profiler';
import type { ProfileResult, CteProfile } from '../dbt/profiler-types';

/**
 * Renders inline timing annotations, gutter icons, and overview ruler colours
 * on CTE definition lines in the active SQL editor.
 *
 * Can be toggled on/off via the `dbt-studio.profiler.toggleDecorations` command.
 */
export class ProfilerDecorationProvider implements vscode.Disposable {
	static readonly contextKey = 'dbt-studio.profilerDecorationsVisible';

	private _visible = true;

	// Inline text + gutter icon + optional background + overview ruler — one type per tier
	private readonly _coolType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		gutterIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#73c991" stroke-width="1.5"/><path d="M5.5 8l2 2 3-3" stroke="#73c991" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>')),
		gutterIconSize: 'contain',
		overviewRulerColor: new vscode.ThemeColor('charts.green'),
		overviewRulerLane: vscode.OverviewRulerLane.Right,
		isWholeLine: false,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	private readonly _warmType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		gutterIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 2l1.8 3.6L14 6.6l-3 2.9.7 4.1L8 11.5l-3.7 2.1.7-4.1-3-2.9 4.2-.6z" fill="none" stroke="#cca700" stroke-width="1.2"/></svg>')),
		gutterIconSize: 'contain',
		overviewRulerColor: new vscode.ThemeColor('charts.yellow'),
		overviewRulerLane: vscode.OverviewRulerLane.Right,
		isWholeLine: false,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	private readonly _hotType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		gutterIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M9 1c0 3-2 4-2 6s1.5 3 3 3c-1 1-2.5 1.5-4 1-2-.7-3-2.5-3-4.5C3 4 6 2 9 1z" fill="#f14c4c"/><path d="M10 8c0 1.5-1 2.5-2 3 .5-1 .5-2-.5-3C8 9.5 7 10 6.5 11 6 9 7 7.5 8 6c0 1 .5 1.5 2 2z" fill="#e8a419"/></svg>')),
		gutterIconSize: 'contain',
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('charts.red'),
		overviewRulerLane: vscode.OverviewRulerLane.Right,
		isWholeLine: true,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	private readonly _totalType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		isWholeLine: false,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	private readonly _runningType = vscode.window.createTextEditorDecorationType({
		after: {
			contentText: '  ⏳ profiling…',
			color: new vscode.ThemeColor('editorCodeLens.foreground'),
			margin: '0 0 0 2em',
			textDecoration: 'none; font-size: 0.85em',
		},
		isWholeLine: false,
	});

	private readonly _disposables: vscode.Disposable[] = [];

	constructor(private readonly _profiler: ModelProfiler) {
		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(e => this._applyToEditor(e)),
			_profiler.onProfileComplete(result => this._handleResult(result)),
		);

		// Apply immediately for the active editor
		this._applyToEditor(vscode.window.activeTextEditor);
	}

	toggle(): void {
		this._visible = !this._visible;
		this._applyToEditor(vscode.window.activeTextEditor);
	}

	get visible(): boolean { return this._visible; }

	dispose(): void {
		this._coolType.dispose();
		this._warmType.dispose();
		this._hotType.dispose();
		this._totalType.dispose();
		this._runningType.dispose();
		for (const d of this._disposables) d.dispose();
	}

	private _handleResult(result: ProfileResult): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.fileName !== result.sourceFilePath) return;
		this._apply(editor, result);
	}

	private _applyToEditor(editor: vscode.TextEditor | undefined): void {
		if (!editor || editor.document.languageId !== 'jinja-sql') {
			this._clearAll(editor);
			return;
		}
		if (!this._visible) {
			this._clearAll(editor);
			return;
		}
		const result = this._profiler.getResultForFile(editor.document.fileName);
		if (!result) {
			this._clearAll(editor);
			return;
		}
		this._apply(editor, result);
	}

	private _clearAll(editor: vscode.TextEditor | undefined): void {
		if (!editor) return;
		editor.setDecorations(this._coolType, []);
		editor.setDecorations(this._warmType, []);
		editor.setDecorations(this._hotType, []);
		editor.setDecorations(this._totalType, []);
		editor.setDecorations(this._runningType, []);
	}

	private _apply(editor: vscode.TextEditor, result: ProfileResult): void {
		if (result.status === 'running' && result.cteProfiles.length === 0) {
			// Nothing profiled yet — no decoration needed
			this._clearAll(editor);
			return;
		}

		editor.setDecorations(this._runningType, []);

		if (result.status === 'error' || result.cteProfiles.length === 0) {
			editor.setDecorations(this._coolType, []);
			editor.setDecorations(this._warmType, []);
			editor.setDecorations(this._hotType, []);
			editor.setDecorations(this._totalType, []);
			return;
		}

		// Heat ranked vs the slowest step (same logic as tree view)
		const maxStepMs = Math.max(...result.cteProfiles.map(p => p.queryTimeMs), 1);

		const cool: vscode.DecorationOptions[] = [];
		const warm: vscode.DecorationOptions[] = [];
		const hot: vscode.DecorationOptions[] = [];

		for (const cte of result.cteProfiles) {
			const line = cte.definitionLine;
			if (line < 0 || line >= editor.document.lineCount) continue;

			const endLine = Math.min(cte.endLine, editor.document.lineCount - 1);
			const defLineLen = editor.document.lineAt(line).text.length;

			// Inline text anchored at definition line end; ruler spans full CTE body
			const inlineRange = new vscode.Range(line, defLineLen, line, defLineLen);
			const rulerRange = new vscode.Range(line, 0, endLine, 0);

			const fraction = cte.queryTimeMs / maxStepMs;
			const label = _formatLabel(cte);
			const hover = _hoverTooltip(cte);

			const inlineOpts: vscode.DecorationOptions = {
				range: inlineRange,
				hoverMessage: hover,
				renderOptions: {
					after: {
						contentText: label,
						color: _tierColor(fraction),
						textDecoration: 'none; font-size: 0.85em',
					},
				},
			};
			const rulerOpts: vscode.DecorationOptions = { range: rulerRange, hoverMessage: hover };

			if (fraction >= 0.5) {
				hot.push(inlineOpts, rulerOpts);
			} else if (fraction >= 0.2) {
				warm.push(inlineOpts, rulerOpts);
			} else {
				cool.push(inlineOpts, rulerOpts);
			}
		}

		editor.setDecorations(this._coolType, cool);
		editor.setDecorations(this._warmType, warm);
		editor.setDecorations(this._hotType, hot);

		// Decorate the final SELECT line (the statement after the closing WITH block)
		const totalLine = _findFinalSelectLine(editor.document);
		if (totalLine >= 0 && result.totalTimeMs > 0) {
			const lineLen = editor.document.lineAt(totalLine).text.length;
			const range = new vscode.Range(totalLine, lineLen, totalLine, lineLen);
			const ms = result.totalTimeMs;
			const timeStr = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
			const rowStr = _formatRows(result.totalRowCount);
			editor.setDecorations(this._totalType, [{
				range,
				renderOptions: {
					after: {
						contentText: `  ⏱ ${timeStr} · ${rowStr}`,
						color: new vscode.ThemeColor('editorCodeLens.foreground'),
						textDecoration: 'none; font-size: 0.85em',
					},
				},
			}]);
		} else {
			editor.setDecorations(this._totalType, []);
		}
	}
}

function _formatLabel(cte: CteProfile): string {
	const ms = cte.queryTimeMs;
	const timeStr = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
	return `  ⏱ ${timeStr} · ${_formatRows(cte.rowCount)}`;
}

function _hoverTooltip(cte: CteProfile): vscode.MarkdownString {
	const ms = cte.queryTimeMs;
	const timeStr = ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
	return new vscode.MarkdownString(
		[
			`**${cte.name}**`, '',
			'| | |', '|---|---|',
			`| Query time | \`${timeStr}\` |`,
			`| Row count | \`${cte.rowCount.toLocaleString()}\` |`,
		].join('\n'),
	);
}

function _formatRows(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M rows`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k rows`;
	return `${n} rows`;
}

function _tierColor(fraction: number): vscode.ThemeColor {
	if (fraction >= 0.5) return new vscode.ThemeColor('editorError.foreground');
	if (fraction >= 0.2) return new vscode.ThemeColor('editorWarning.foreground');
	return new vscode.ThemeColor('editorCodeLens.foreground');
}

/**
 * Find the 0-based line index of the final SELECT statement in a dbt model.
 * In a WITH ... AS (...) SELECT pattern, the final SELECT comes after the
 * closing paren of the last CTE. We scan backwards for the first non-blank,
 * non-comment line that starts the statement after the WITH block.
 */
function _findFinalSelectLine(doc: vscode.TextDocument): number {
	// Scan backwards from end of document for a line starting with 'select' (case-insensitive)
	// that sits outside the WITH block (i.e. after the closing paren of the last CTE).
	for (let i = doc.lineCount - 1; i >= 0; i--) {
		const trimmed = doc.lineAt(i).text.trim().toLowerCase();
		if (trimmed.startsWith('select') || trimmed.startsWith('from')) {
			return i;
		}
		// Stop at the closing paren of the WITH block — we don't want to go inside CTEs
		if (trimmed === ')') return i + 1 < doc.lineCount ? i + 1 : -1;
	}
	return -1;
}
