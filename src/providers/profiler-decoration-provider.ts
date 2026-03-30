import * as vscode from 'vscode';
import type { ModelProfiler } from '../dbt/model-profiler';
import type { ProfileResult, CteProfile } from '../dbt/profiler-types';
import type { ParseService } from '../services/parse-service';
import type { ManifestIndexer } from '../indexing/manifest-indexer';

/**
 * Renders inline timing annotations, gutter icons, and overview ruler colours
 * on CTE definition lines in the active SQL editor.
 *
 * Can be toggled on/off via the `dbt-studio.profiler.toggleDecorations` command.
 */
export class ProfilerDecorationProvider implements vscode.Disposable {
	static readonly contextKey = 'dbt-studio.profilerDecorationsVisible';

	private _visible = true;

	// Inline text (+ gutter icon for warm/hot) — range = definition line only
	private readonly _coolType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		isWholeLine: false,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	private readonly _warmType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		gutterIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M7.56 2L1.46 12.5h12.21L7.56 2zm0 3.5l.44 3.5H7.12l.44-3.5zm0 5.5a.67.67 0 110 1.34.67.67 0 010-1.34z" fill="#cca700"/></svg>')),
		gutterIconSize: 'contain',
		isWholeLine: false,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	private readonly _hotType = vscode.window.createTextEditorDecorationType({
		after: { margin: '0 0 0 2em' },
		gutterIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M9 1c0 3-2 4-2 6s1.5 3 3 3c-1 1-2.5 1.5-4 1-2-.7-3-2.5-3-4.5C3 4 6 2 9 1z" fill="#f14c4c"/><path d="M10 8c0 1.5-1 2.5-2 3 .5-1 .5-2-.5-3C8 9.5 7 10 6.5 11 6 9 7 7.5 8 6c0 1 .5 1.5 2 2z" fill="#e8a419"/></svg>')),
		gutterIconSize: 'contain',
		isWholeLine: false,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	// Overview ruler only — range = full CTE body (warm/hot only, cool has no ruler)
	private readonly _warmRulerType = vscode.window.createTextEditorDecorationType({
		overviewRulerColor: new vscode.ThemeColor('charts.yellow'),
		overviewRulerLane: vscode.OverviewRulerLane.Right,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});

	private readonly _hotRulerType = vscode.window.createTextEditorDecorationType({
		overviewRulerColor: new vscode.ThemeColor('charts.red'),
		overviewRulerLane: vscode.OverviewRulerLane.Right,
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

	constructor(
		private readonly _profiler: ModelProfiler,
		private readonly _parseService: ParseService,
		private readonly _indexer: ManifestIndexer,
	) {
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
		this._warmRulerType.dispose();
		this._hotRulerType.dispose();
		this._totalType.dispose();
		this._runningType.dispose();
		for (const d of this._disposables) d.dispose();
	}

	private _handleResult(result: ProfileResult): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.fileName !== result.sourceFilePath) return;
		void this._applyToEditor(editor);
	}

	private async _applyToEditor(editor: vscode.TextEditor | undefined): Promise<void> {
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
		const adapterType = this._indexer.index?.adapterType ?? 'ansi';
		const model = await this._parseService.getDocumentModel(editor.document, adapterType, { skipEnrichment: true });
		const cteByName = new Map((model?.ctes ?? []).map(c => [c.name, c]));
		this._apply(editor, result, cteByName);
	}

	private _clearAll(editor: vscode.TextEditor | undefined): void {
		if (!editor) return;
		editor.setDecorations(this._coolType, []);
		editor.setDecorations(this._warmType, []);
		editor.setDecorations(this._hotType, []);
		editor.setDecorations(this._warmRulerType, []);
		editor.setDecorations(this._hotRulerType, []);
		editor.setDecorations(this._totalType, []);
		editor.setDecorations(this._runningType, []);
	}

	private _apply(editor: vscode.TextEditor, result: ProfileResult, cteByName: Map<string, { line: number; endLine: number }>): void {
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
			editor.setDecorations(this._warmRulerType, []);
			editor.setDecorations(this._hotRulerType, []);
			editor.setDecorations(this._totalType, []);
			return;
		}

		// Heat ranked vs the slowest step (same logic as tree view)
		const maxStepMs = Math.max(...result.cteProfiles.map(p => p.queryTimeMs), 1);

		const cool: vscode.DecorationOptions[] = [];
		const warm: vscode.DecorationOptions[] = [];
		const warmRuler: vscode.DecorationOptions[] = [];
		const hot: vscode.DecorationOptions[] = [];
		const hotRuler: vscode.DecorationOptions[] = [];

		for (const cte of result.cteProfiles) {
			const pos = cteByName.get(cte.name);
			if (!pos) continue;
			const line = pos.line;
			if (line < 0 || line >= editor.document.lineCount) continue;

			const endLine = Math.min(pos.endLine, editor.document.lineCount - 1);
			const defLineLen = editor.document.lineAt(line).text.length;

			// Inline text + gutter icon: range anchored to definition line only
			// Overview ruler: separate range spanning full CTE body
			const inlineRange = new vscode.Range(line, defLineLen, line, defLineLen);
			const rulerRange = new vscode.Range(line, 0, endLine, 0);

			const fraction = cte.queryTimeMs / maxStepMs;
			const label = _formatLabel(cte);

			const inlineOpts: vscode.DecorationOptions = {
				range: inlineRange,
				renderOptions: {
					after: {
						contentText: label,
						color: _tierColor(fraction),
						textDecoration: 'none; font-size: 0.85em',
					},
				},
			};

			if (fraction >= 0.5) {
				hot.push(inlineOpts);
				hotRuler.push({ range: rulerRange });
			} else if (fraction >= 0.2) {
				warm.push(inlineOpts);
				warmRuler.push({ range: rulerRange });
			} else {
				cool.push(inlineOpts);
			}
		}

		editor.setDecorations(this._coolType, cool);
		editor.setDecorations(this._warmType, warm);
		editor.setDecorations(this._hotType, hot);
		editor.setDecorations(this._warmRulerType, warmRuler);
		editor.setDecorations(this._hotRulerType, hotRuler);

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
