import * as vscode from 'vscode';
import type { ModelProfiler } from '../dbt/model-profiler';
import type { ProfileResult, CteProfile } from '../dbt/profiler-types';

/**
 * Renders inline timing annotations on CTE definition lines in the active SQL editor.
 *
 * Shows `⏱ 1.2s · 4.3k rows` right-aligned after each CTE's definition line.
 * The slowest CTE gets a hot-path background highlight.
 */
export class ProfilerDecorationProvider implements vscode.Disposable {
	// Three tiers: normal (cool), warm, hot
	private readonly _coolType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		isWholeLine: false,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	private readonly _warmType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		isWholeLine: false,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	private readonly _hotType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
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

		// Find the hottest CTE (largest marginal fraction)
		const hottestFraction = Math.max(...result.cteProfiles.map(p => p.fractionOfTotal));

		const cool: vscode.DecorationOptions[] = [];
		const warm: vscode.DecorationOptions[] = [];
		const hot: vscode.DecorationOptions[] = [];

		for (const cte of result.cteProfiles) {
			const line = cte.definitionLine;
			if (line < 0 || line >= editor.document.lineCount) continue;

			const lineLen = editor.document.lineAt(line).text.length;
			const range = new vscode.Range(line, lineLen, line, lineLen);

			const label = _formatLabel(cte, result.totalTimeMs);
			const opts: vscode.DecorationOptions = {
				range,
				renderOptions: {
					after: {
						contentText: label,
						color: _tierColor(cte.fractionOfTotal),
						textDecoration: 'none; font-size: 0.85em',
					},
				},
			};

			if (cte.fractionOfTotal === hottestFraction && cte.fractionOfTotal > 0.2) {
				hot.push(opts);
			} else if (cte.fractionOfTotal >= 0.2) {
				warm.push(opts);
			} else {
				cool.push(opts);
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

function _formatLabel(cte: CteProfile, totalTimeMs: number): string {
	const ms = cte.queryTimeMs;
	const timeStr = ms >= 1000
		? `${(ms / 1000).toFixed(1)}s`
		: `${ms.toFixed(0)}ms`;

	const pct = totalTimeMs > 0
		? `${Math.round(cte.fractionOfTotal * 100)}%`
		: '';

	const rowStr = _formatRows(cte.rowCount);

	return `  ⏱ ${timeStr} · ${rowStr}${pct ? ` (${pct})` : ''}`;
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
