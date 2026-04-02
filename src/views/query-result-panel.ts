import * as vscode from 'vscode';
import type { StatementResult } from '../dbt/query-runner';

/**
 * Manages query results display in either an editor-area WebviewPanel or a
 * bottom-panel WebviewView. The user can toggle between the two locations.
 *
 * - Editor mode (default): opens as a tab, split below the active editor.
 * - Panel mode: lives in the dedicated "Query Results" panel tab alongside Terminal.
 */
export class QueryResultPanel implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
	private static _instance: QueryResultPanel | undefined;

	/** Editor-area tab (null when in panel mode or never shown). */
	private _editorPanel: vscode.WebviewPanel | undefined;
	/** Bottom-panel WebviewView (resolved lazily by VS Code). */
	private _view: vscode.WebviewView | undefined;

	private _results: StatementResult[] = [];
	private _inPanel = false;
	/** Prevents dispose side-effects when we programmatically dispose during a move. */
	private _moving = false;

	/** viewType for WebviewPanel persistence (must match package.json serializer). */
	static readonly viewType = 'dbtQueryResults';
	/** viewId registered in package.json contributes.views. */
	static readonly viewId = 'dbt-studio.queryResults';

	private static readonly _ctxVisible = 'dbt-studio.queryResultVisible';
	private static readonly _ctxInPanel = 'dbt-studio.queryResultInPanel';
	private static readonly _stateKey = 'dbt-studio.queryResultInPanel';

	private constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _state: vscode.Memento,
	) {
		this._inPanel = this._state.get<boolean>(QueryResultPanel._stateKey, false);
		if (this._inPanel) {
			void vscode.commands.executeCommand('setContext', QueryResultPanel._ctxInPanel, true);
		}
	}

	static getInstance(extensionUri: vscode.Uri, state: vscode.Memento): QueryResultPanel {
		if (!QueryResultPanel._instance) {
			QueryResultPanel._instance = new QueryResultPanel(extensionUri, state);
		}
		return QueryResultPanel._instance;
	}

	// ---- WebviewViewProvider ------------------------------------------------

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
		webviewView.onDidDispose(() => { this._view = undefined; });
		webviewView.webview.html = (this._inPanel && this._results.length > 0)
			? this._getHtml(this._results)
			: this._emptyHtml();
	}

	// ---- WebviewPanelSerializer ---------------------------------------------

	async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown): Promise<void> {
		this._adoptEditorPanel(panel);
		panel.webview.html = this._results.length > 0
			? this._getHtml(this._results)
			: this._emptyHtml();
	}

	// ---- Public API ---------------------------------------------------------

	showResults(results: StatementResult[], resultLocationOverride?: string): void {
		this._results = results;

		const loc = resultLocationOverride
			?? vscode.workspace.getConfiguration('dbt-studio').get<string>('queryEditor.resultLocation', 'preserve');
		if (loc === 'panel' && !this._inPanel) this.moveToPanel();
		else if (loc === 'editor' && this._inPanel) this.moveToEditor();

		void vscode.commands.executeCommand('setContext', QueryResultPanel._ctxVisible, true);

		if (this._inPanel) {
			if (this._view) {
				this._view.webview.html = this._getHtml(results);
				this._view.show(true);
			} else {
				void vscode.commands.executeCommand(`${QueryResultPanel.viewId}.focus`);
			}
		} else {
			if (!this._editorPanel) {
				const panel = vscode.window.createWebviewPanel(
					QueryResultPanel.viewType,
					'Query Results',
					vscode.ViewColumn.Active,
					{ enableScripts: true, retainContextWhenHidden: true },
				);
				this._adoptEditorPanel(panel);
				void vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
			}
			this._editorPanel!.webview.html = this._getHtml(results);
			this._editorPanel!.reveal(undefined, true);
		}
	}

	moveToPanel(): void {
		if (this._inPanel) return;
		this._inPanel = true;
		void this._state.update(QueryResultPanel._stateKey, true);
		this._moving = true;
		this._editorPanel?.dispose();
		this._moving = false;
		void vscode.commands.executeCommand('setContext', QueryResultPanel._ctxInPanel, true);
		void vscode.commands.executeCommand(`${QueryResultPanel.viewId}.focus`);
		if (this._view && this._results.length > 0) {
			this._view.webview.html = this._getHtml(this._results);
		}
	}

	toggleStats(): void {
		const webview = this._inPanel ? this._view?.webview : this._editorPanel?.webview;
		void webview?.postMessage({ type: 'toggleStats' });
	}

	requestExport(format: string, target: 'clipboard' | 'file' = 'clipboard'): void {
		const webview = this._inPanel ? this._view?.webview : this._editorPanel?.webview;
		void webview?.postMessage({ type: 'requestExport', format, target });
	}

	moveToEditor(): void {
		if (!this._inPanel) return;
		this._inPanel = false;
		void this._state.update(QueryResultPanel._stateKey, false);
		void vscode.commands.executeCommand('setContext', QueryResultPanel._ctxInPanel, false);
		if (this._view) {
			this._view.webview.html = this._emptyHtml();
		}
		const panel = vscode.window.createWebviewPanel(
			QueryResultPanel.viewType,
			'Query Results',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this._adoptEditorPanel(panel);
		panel.webview.html = this._results.length > 0
			? this._getHtml(this._results)
			: this._emptyHtml();
		void vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
	}

	// ---- Private helpers ----------------------------------------------------

	private _adoptEditorPanel(panel: vscode.WebviewPanel): void {
		if (this._editorPanel) {
			this._moving = true;
			this._editorPanel.dispose();
			this._moving = false;
		}
		this._editorPanel = panel;
		panel.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
		panel.onDidDispose(() => {
			this._editorPanel = undefined;
			if (!this._moving && !this._inPanel) {
				void vscode.commands.executeCommand('setContext', QueryResultPanel._ctxVisible, false);
			}
		});
	}

	private _handleMessage(msg: { type: string; value?: string; tabIndex?: number; format?: string; target?: string; selection?: { r1: number; r2: number; c1: number; c2: number } }): void {
		if (msg.type === 'copyValue' && msg.value !== undefined) {
			void vscode.env.clipboard.writeText(msg.value);
		}
		if (msg.type === 'exportCsv' && msg.tabIndex !== undefined) {
			const r = this._results[msg.tabIndex];
			if (r?.result) {
				const csv = this._toCsv(r.result.columns, r.result.rows);
				void vscode.env.clipboard.writeText(csv);
				void vscode.window.showInformationMessage('Copied CSV to clipboard.');
			}
		}
		if (msg.type === 'export' && msg.tabIndex !== undefined && msg.format) {
			const r = this._results[msg.tabIndex];
			if (r?.result) {
				let { columns, rows } = r.result;
				if (msg.selection) {
					const { r1, r2, c1, c2 } = msg.selection;
					columns = columns.slice(c1, c2 + 1);
					rows = rows.slice(r1, r2 + 1).map(row => {
						const sliced: Record<string, unknown> = {};
						for (const col of columns) sliced[col] = row[col];
						return sliced;
					});
				}
				const text = this._formatExport(columns, rows, msg.format);
				if (msg.target === 'file') {
					const extMap: Record<string, string> = { csv: 'csv', tsv: 'tsv', json: 'json', markdown: 'md' };
					const fileExt = extMap[msg.format] ?? 'txt';
					void vscode.window.showSaveDialog({
						defaultUri: vscode.Uri.file(`query-results.${fileExt}`),
						filters: { [msg.format.toUpperCase()]: [fileExt] },
					}).then(uri => {
						if (!uri) return;
						void vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
					});
				} else if (msg.format === 'editor') {
					void vscode.workspace.openTextDocument({ content: text, language: 'plaintext' })
						.then(doc => vscode.window.showTextDocument(doc));
				} else {
					void vscode.env.clipboard.writeText(text);
					void vscode.window.showInformationMessage(`Copied ${msg.format.toUpperCase()} to clipboard.`);
				}
			}
		}
	}

	private _toCsv(columns: string[], rows: Record<string, unknown>[]): string {
		const escape = (v: unknown): string => {
			if (v === null || v === undefined) return '';
			const s = String(v);
			return s.includes(',') || s.includes('"') || s.includes('\n')
				? `"${s.replace(/"/g, '""')}"`
				: s;
		};
		const header = columns.map(escape).join(',');
		const body = rows.map(row => columns.map(c => escape(row[c])).join(',')).join('\n');
		return `${header}\n${body}`;
	}

	private _formatExport(columns: string[], rows: Record<string, unknown>[], format: string): string {
		if (format === 'csv' || format === 'editor') return this._toCsv(columns, rows);
		if (format === 'tsv') {
			const escape = (v: unknown): string => (v === null || v === undefined) ? '' : String(v).replace(/\t/g, ' ');
			const header = columns.map(escape).join('\t');
			const body = rows.map(row => columns.map(c => escape(row[c])).join('\t')).join('\n');
			return `${header}\n${body}`;
		}
		if (format === 'json') {
			return JSON.stringify(rows, null, 2);
		}
		if (format === 'markdown') {
			const header = '| ' + columns.join(' | ') + ' |';
			const sep = '| ' + columns.map(() => '---').join(' | ') + ' |';
			const body = rows.map(row =>
				'| ' + columns.map(c => {
					const v = row[c];
					return (v === null || v === undefined) ? '' : String(v).replace(/\|/g, '\\|');
				}).join(' | ') + ' |',
			).join('\n');
			return `${header}\n${sep}\n${body}`;
		}
		return this._toCsv(columns, rows);
	}

	private _emptyHtml(): string {
		return '<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground)"><p>Run a query (F5) to see results.</p></body></html>';
	}

	private _getHtml(results: StatementResult[]): string {
		const nonce = getNonce();
		const tabsHtml = results.map((r, i) => {
			const label = r.error
				? `Statement ${i + 1} (error)`
				: `Statement ${i + 1} (${r.result?.rowCount ?? 0} rows)`;
			return `<button class="tab${i === 0 ? ' active' : ''}" data-index="${i}">${escapeHtml(label)}</button>`;
		}).join('');

		const panelsHtml = results.map((r, i) => {
			if (r.error) {
				return `<div class="panel${i === 0 ? ' active' : ''}" data-index="${i}">
					<div class="error-panel">
						<div class="error-title">Error</div>
						<pre class="error-message">${escapeHtml(r.error)}</pre>
						<div class="error-sql"><strong>SQL:</strong> <pre>${escapeHtml(r.sql)}</pre></div>
					</div>
				</div>`;
			}
			const res = r.result!;
			const timeStr = res.executionTimeMs >= 1000
				? `${(res.executionTimeMs / 1000).toFixed(1)}s`
				: `${res.executionTimeMs.toFixed(0)}ms`;

			const colTypes = res.columnTypes ?? {};

			let tableHtml = `<table><thead><tr class="stat-row" style="display:none"><td class="stat-td row-gutter-cell"></td>${res.columns.map(() => '<td class="stat-td"></td>').join('')}</tr><tr><th class="row-gutter"></th>`;
			for (const col of res.columns) {
				const dbType = colTypes[col];
				const typeAttr = dbType ? ` data-type="${escapeHtml(dbType)}"` : '';
				tableHtml += `<th data-col="${escapeHtml(col)}"${typeAttr}><div class="th-inner"><span class="th-label">${escapeHtml(col)}</span><span class="sort-btn" title="Sort">&#8597;</span></div><span class="resize-handle"></span></th>`;
			}
			tableHtml += '</tr></thead><tbody>';
			for (let ri = 0; ri < res.rows.length; ri++) {
				const row = res.rows[ri];
				tableHtml += `<tr data-row="${ri}"><td class="row-num" data-row="${ri}">${ri + 1}</td>`;
				for (let ci = 0; ci < res.columns.length; ci++) {
					const col = res.columns[ci];
					const val = row[col];
					if (val === null || val === undefined) {
						tableHtml += `<td class="null-val" data-row="${ri}" data-col="${ci}">NULL</td>`;
					} else {
						const s = String(val);
						const display = s.length > 200 ? s.substring(0, 200) + '\u2026' : s;
						tableHtml += `<td data-row="${ri}" data-col="${ci}">${escapeHtml(display)}</td>`;
					}
				}
				tableHtml += '</tr>';
			}
			tableHtml += '</tbody></table>';

			return `<div class="panel${i === 0 ? ' active' : ''}" data-index="${i}">
				<div class="filter-bar" style="display:none"><input class="filter-input" placeholder="Filter: column > 100, column = value, column contains text" spellcheck="false"><span class="filter-status"></span><button class="filter-clear">\u2715</button></div>
				<div class="table-wrap">${tableHtml}</div>
				<div class="footer">
					<span class="footer-info">${res.rowCount} rows \u00b7 ${timeStr}</span>
					<span class="footer-selection" style="display:none"></span>
				</div>
			</div>`;
		}).join('');

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>
:root {
	--sel-bg: var(--vscode-editor-selectionBackground, rgba(38, 79, 120, 0.7));
	--sel-border: var(--vscode-focusBorder, #007fd4);
	--cell-pad-x: 10px;
	--cell-pad-y: 3px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
body {
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
}

/* -- Tab bar -- */
.tab-bar {
	display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border);
	background: var(--vscode-sideBar-background); flex-shrink: 0; overflow-x: auto;
}
.tab {
	padding: 6px 14px; border: none; background: transparent;
	color: var(--vscode-foreground); cursor: pointer; font-size: inherit;
	border-bottom: 2px solid transparent; white-space: nowrap;
	opacity: 0.7; font-family: inherit;
}
.tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
.tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }

/* -- Panels -- */
.panel { display: none; flex: 1; flex-direction: column; overflow: hidden; }
.panel.active { display: flex; }

/* -- Filter bar -- */
.filter-bar {
	display: flex; align-items: center; gap: 6px; padding: 4px 10px;
	background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
}
.filter-input {
	flex: 1; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent);
	color: var(--vscode-input-foreground); padding: 3px 8px; font-family: inherit; font-size: inherit;
	border-radius: 3px; outline: none;
}
.filter-input:focus { border-color: var(--vscode-focusBorder); }
.filter-status { font-size: 0.85em; opacity: 0.7; white-space: nowrap; }
.filter-clear {
	background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
	font-size: 1.1em; opacity: 0.6; padding: 2px 4px;
}
.filter-clear:hover { opacity: 1; }

/* -- Stats row -- */
thead .stat-row td {
	position: sticky; top: 0; z-index: 1;
	background: var(--vscode-sideBar-background);
	border-bottom: 1px solid var(--vscode-panel-border);
	padding: 4px var(--cell-pad-x) 3px; font-size: 0.75em; vertical-align: top; white-space: nowrap;
}
.stat-dist {
	height: 20px; display: flex; align-items: flex-end; gap: 1px; margin-bottom: 2px; overflow: hidden;
}
.stat-dist-bar {
	flex: 1; min-width: 2px; border-radius: 1px 1px 0 0;
	background: var(--vscode-focusBorder); opacity: 0.5;
}
.stat-dist-bar.null-bar { background: var(--vscode-errorForeground); opacity: 0.4; }
.stat-false-bar { background: var(--vscode-charts-orange, #e07b39); opacity: 0.6; }
.stat-summary { overflow: hidden; text-overflow: ellipsis; opacity: 0.8; line-height: 1.2; }

/* -- Table -- */
.table-wrap { flex: 1; overflow: auto; position: relative; }
table { border-collapse: collapse; width: max-content; min-width: 100%; }
th {
	position: sticky; top: 0; z-index: 2;
	background: var(--vscode-editorGroupHeader-tabsBackground);
	padding: var(--cell-pad-y) var(--cell-pad-x); text-align: left; white-space: nowrap;
	border-bottom: 2px solid var(--vscode-panel-border);
	cursor: pointer; user-select: none; font-weight: 600;
	overflow: hidden;
}
.th-inner { display: flex; align-items: center; gap: 2px; }
th .th-label { pointer-events: none; flex: 1; overflow: hidden; text-overflow: ellipsis; }
th:hover { background: var(--vscode-list-hoverBackground); }
th.col-selected { background: var(--sel-bg); }
.sort-btn {
	margin-left: 4px; opacity: 0; font-size: 0.85em; cursor: pointer;
	flex-shrink: 0; line-height: 1;
}
th:hover .sort-btn { opacity: 0.7; }
th.sort-asc .sort-btn, th.sort-desc .sort-btn { opacity: 1; color: var(--vscode-focusBorder); }
th.sort-asc .sort-btn::after { content: ' \u25b2'; }
th.sort-desc .sort-btn::after { content: ' \u25bc'; }

/* -- Resize handle -- */
.resize-handle {
	position: absolute; right: 0; top: 0; bottom: 0; width: 5px;
	cursor: col-resize; z-index: 3;
}
.resize-handle:hover, .resize-handle.active { background: var(--vscode-focusBorder); }
th { position: sticky; top: 0; z-index: 2; overflow: visible; }

/* -- Type-aware alignment -- */
td.num-val { text-align: right; font-variant-numeric: tabular-nums; }
td.bool-val { text-align: center; }

/* -- Row gutter -- */
th.row-gutter {
	width: 1px; min-width: 1px; padding: var(--cell-pad-y) 6px; text-align: right;
	color: var(--vscode-descriptionForeground); font-weight: normal; cursor: default;
}
td.row-num {
	padding: var(--cell-pad-y) 6px; text-align: right; white-space: nowrap;
	color: var(--vscode-descriptionForeground); font-size: 0.85em; user-select: none;
	cursor: pointer; border-right: 1px solid var(--vscode-editorGroup-border);
}
td.row-num:hover { background: var(--vscode-list-hoverBackground) !important; }
td.row-num.row-selected { background: var(--sel-bg) !important; color: var(--vscode-foreground); }
.stat-td.row-gutter-cell { border-right: 1px solid var(--vscode-editorGroup-border); }

td {
	padding: var(--cell-pad-y) var(--cell-pad-x); white-space: nowrap;
	border-bottom: 1px solid var(--vscode-editorGroup-border);
	cursor: default; max-width: 400px; overflow: hidden; text-overflow: ellipsis;
	position: relative; user-select: none;
}
tr:nth-child(even) { background: var(--vscode-editor-background); }
tr:nth-child(odd) { background: var(--vscode-editorGroupHeader-tabsBackground); }
tr.filtered-out { display: none; }
.null-val { font-style: italic; opacity: 0.5; }

/* -- Selection -- */
td.selected { background: var(--sel-bg) !important; }
td.sel-focus { outline: 2px solid var(--sel-border); outline-offset: -2px; z-index: 1; }
tr.row-selected td { background: var(--sel-bg) !important; }

/* -- Cell copy flash -- */
@keyframes cell-flash {
	0% { background: var(--vscode-focusBorder); }
	100% { background: transparent; }
}
td.flash { animation: cell-flash 0.3s ease-out; }

/* -- Floating toolbar -- */
.float-toolbar {
	position: fixed; top: 8px; right: 16px; z-index: 100;
	display: flex; gap: 2px; padding: 3px 6px;
	background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
	border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
	opacity: 0; pointer-events: none; transition: opacity 0.15s;
}
.float-toolbar.visible { opacity: 1; pointer-events: auto; }
.float-toolbar button {
	background: transparent; border: none; color: var(--vscode-foreground);
	cursor: pointer; padding: 3px 8px; font-size: 0.85em; font-family: inherit;
	border-radius: 3px;
}
.float-toolbar button:hover { background: var(--vscode-list-hoverBackground); }

/* -- Context menu -- */
.ctx-menu {
	position: fixed; z-index: 300; min-width: 160px;
	background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
	border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
	border-radius: 4px; box-shadow: 0 2px 12px rgba(0,0,0,0.4);
	padding: 4px 0; display: none;
}
.ctx-menu.visible { display: block; }
.ctx-item {
	padding: 4px 14px; cursor: pointer; white-space: nowrap; font-size: inherit;
}
.ctx-item:hover { background: var(--vscode-list-hoverBackground); }
.ctx-sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }

/* -- Footer -- */
.footer {
	display: flex; justify-content: space-between; align-items: center;
	padding: 4px 10px; border-top: 1px solid var(--vscode-panel-border);
	background: var(--vscode-sideBar-background); flex-shrink: 0;
	font-size: 0.9em; opacity: 0.8; gap: 10px;
}
.footer-actions { display: flex; gap: 4px; align-items: center; }
.action-btn {
	background: transparent; border: 1px solid var(--vscode-button-border, var(--vscode-foreground));
	color: var(--vscode-foreground); padding: 2px 8px; cursor: pointer;
	border-radius: 3px; font-size: 0.85em; font-family: inherit;
}
.action-btn:hover { background: var(--vscode-button-hoverBackground); }

/* -- Error panel -- */
.error-panel { padding: 16px; }
.error-title { font-weight: 700; color: var(--vscode-errorForeground); margin-bottom: 8px; font-size: 1.1em; }
.error-message {
	background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
	border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
	padding: 10px; border-radius: 4px; white-space: pre-wrap; margin-bottom: 12px;
	font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
}
.error-sql { opacity: 0.7; }
.error-sql pre {
	margin-top: 4px; white-space: pre-wrap;
	font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
}
</style>
</head>
<body>
${results.length > 1 ? `<div class="tab-bar">${tabsHtml}</div>` : ''}
${panelsHtml}
<div class="float-toolbar" id="floatToolbar">
	<button data-action="copy" title="Copy (Ctrl+C)">Copy</button>
	<button data-action="csv" title="Copy as CSV">CSV</button>
	<button data-action="json" title="Copy as JSON">JSON</button>
	<button data-action="tsv" title="Copy as TSV">TSV</button>
	<button data-action="markdown" title="Copy as Markdown">MD</button>
	<button data-action="editor" title="Open in Editor">Editor</button>
</div>
<div class="ctx-menu" id="ctxMenu"></div>
<script nonce="${nonce}">
(function() {
	const vscode = acquireVsCodeApi();

	// ── Utility ─────────────────────────────────────────────
	const $ = (sel, root) => (root || document).querySelector(sel);
	const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

	// ── Data Structures ─────────────────────────────────────
	// Per-panel data passed from extension
	const panelDataMap = new Map();
	$$('.panel').forEach(p => {
		const idx = parseInt(p.getAttribute('data-index'));
		const table = $('table', p);
		if (!table) return;
		const columns = $$('th[data-col]', table).map(th => th.getAttribute('data-col'));
		const types = {};
		$$('th[data-col]', table).forEach(th => {
			const t = th.getAttribute('data-type');
			if (t) types[th.getAttribute('data-col')] = t;
		});
		const rows = $$('tbody tr', table).map(tr =>
			$$('td[data-col]', tr).map(td => td.classList.contains('null-val') ? null : td.textContent)
		);
		panelDataMap.set(idx, { columns, types, rows, table, panel: p });
	});

	// ── Type Inference ──────────────────────────────────────
	const NUM_RE = /^-?\\d[\\d,]*\\.?\\d*$/;
	const DATE_RE = /^\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2})?/;
	const BOOL_SET = new Set(['true','false','t','f','yes','no','1','0']);
	const NUMERIC_TYPES = new Set(['INT','INTEGER','BIGINT','SMALLINT','TINYINT','FLOAT','DOUBLE','DECIMAL','NUMBER','NUMERIC','REAL','LONG','SHORT','DEC']);

	function inferType(values) {
		let nums = 0, dates = 0, bools = 0, total = 0;
		const sample = values.slice(0, 50);
		for (const v of sample) {
			if (v === null || v === undefined || v === '') continue;
			total++;
			const s = String(v).trim();
			if (BOOL_SET.has(s.toLowerCase())) bools++;
			else if (NUM_RE.test(s.replace(/,/g, ''))) nums++;
			else if (DATE_RE.test(s)) dates++;
		}
		if (total === 0) return 'string';
		if (bools / total > 0.8) return 'boolean';
		if (nums / total > 0.8) return 'number';
		if (dates / total > 0.8) return 'date';
		return 'string';
	}

	function resolveColType(dbType, values) {
		if (dbType) {
			const upper = dbType.toUpperCase().replace(/\\(.*\\)/, '').trim();
			if (NUMERIC_TYPES.has(upper)) return 'number';
			if (upper === 'BOOLEAN' || upper === 'BOOL') return 'boolean';
			if (upper.includes('DATE') || upper.includes('TIME') || upper.includes('TIMESTAMP')) return 'date';
			if (upper.includes('CHAR') || upper.includes('TEXT') || upper.includes('STRING')) return 'string';
		}
		return inferType(values);
	}

	// Build resolved types per panel
	panelDataMap.forEach((d, idx) => {
		d.resolvedTypes = {};
		d.columns.forEach((col, ci) => {
			const values = d.rows.map(r => r[ci]);
			d.resolvedTypes[col] = resolveColType(d.types[col], values);
		});
		// Apply type-aware classes
		$$('tbody td', d.table).forEach(td => {
			const ci = parseInt(td.getAttribute('data-col'));
			const col = d.columns[ci];
			const rt = d.resolvedTypes[col];
			if (rt === 'number' && !td.classList.contains('null-val')) td.classList.add('num-val');
			if (rt === 'boolean' && !td.classList.contains('null-val')) td.classList.add('bool-val');
		});
	});
	panelDataMap.forEach(d => buildStatsFoot(d));

	// ── Tab Switching ───────────────────────────────────────
	$$('.tab').forEach(tab => {
		tab.addEventListener('click', () => {
			$$('.tab').forEach(t => t.classList.remove('active'));
			$$('.panel').forEach(p => p.classList.remove('active'));
			tab.classList.add('active');
			const idx = tab.getAttribute('data-index');
			$('.panel[data-index="' + idx + '"]')?.classList.add('active');
			clearSelection();
		});
	});

	// ── Column Resize ───────────────────────────────────────
	let resizeState = null;
	document.addEventListener('mousedown', e => {
		if (!e.target.classList.contains('resize-handle')) return;
		e.preventDefault();
		e.stopPropagation();
		const th = e.target.closest('th');
		const startX = e.clientX;
		const startW = th.offsetWidth;
		e.target.classList.add('active');
		resizeState = { th, startX, startW, handle: e.target };
	});
	document.addEventListener('mousemove', e => {
		if (!resizeState) return;
		const newW = Math.max(40, resizeState.startW + (e.clientX - resizeState.startX));
		resizeState.th.style.width = newW + 'px';
		resizeState.th.style.minWidth = newW + 'px';
		resizeState.th.style.maxWidth = newW + 'px';
		// Apply to corresponding column cells
		const table = resizeState.th.closest('table');
		const ci = Array.from(resizeState.th.parentElement.children).indexOf(resizeState.th);
		$$('tbody td:nth-child(' + (ci + 1) + ')', table).forEach(td => {
			td.style.width = newW + 'px';
			td.style.minWidth = newW + 'px';
			td.style.maxWidth = newW + 'px';
		});
	});
	document.addEventListener('mouseup', () => {
		if (resizeState) {
			resizeState.handle.classList.remove('active');
			resizeState = null;
		}
	});
	// Double-click resize handle → auto-fit
	document.addEventListener('dblclick', e => {
		if (!e.target.classList.contains('resize-handle')) return;
		e.preventDefault();
		e.stopPropagation();
		const th = e.target.closest('th');
		const table = th.closest('table');
		const ci = Array.from(th.parentElement.children).indexOf(th);
		const cells = $$('tbody td:nth-child(' + (ci + 1) + ')', table);
		// Measure natural width
		th.style.width = 'auto'; th.style.minWidth = ''; th.style.maxWidth = '';
		cells.forEach(td => { td.style.width = 'auto'; td.style.minWidth = ''; td.style.maxWidth = ''; });
		const maxW = Math.max(th.scrollWidth, ...cells.map(td => td.scrollWidth)) + 4;
		th.style.width = maxW + 'px'; th.style.minWidth = maxW + 'px'; th.style.maxWidth = maxW + 'px';
		cells.forEach(td => { td.style.width = maxW + 'px'; td.style.minWidth = maxW + 'px'; td.style.maxWidth = maxW + 'px'; });
	});

	// ── Selection Model ─────────────────────────────────────
	let sel = { anchor: null, focus: null, mode: 'cell' }; // mode: cell | row | col
	let focusCell = null; // { row, col } — always within selection

	function getActivePanel() {
		const p = $('.panel.active');
		if (!p) return null;
		return panelDataMap.get(parseInt(p.getAttribute('data-index')));
	}

	function cellAt(table, row, col) {
		const tr = $('tbody tr[data-row="' + row + '"]', table);
		return tr ? $('td[data-col="' + col + '"]', tr) : null;
	}

	function clearSelection() {
		$$('td.selected, td.sel-focus').forEach(td => { td.classList.remove('selected', 'sel-focus'); });
		$$('th.col-selected').forEach(th => th.classList.remove('col-selected'));
		$$('tr.row-selected').forEach(tr => tr.classList.remove('row-selected'));
		sel = { anchor: null, focus: null, mode: 'cell' };
		focusCell = null;
		updateToolbar();
		updateFooterSelection();
	}

	function selRect() {
		if (!sel.anchor || !sel.focus) return null;
		return {
			r1: Math.min(sel.anchor.row, sel.focus.row),
			r2: Math.max(sel.anchor.row, sel.focus.row),
			c1: Math.min(sel.anchor.col, sel.focus.col),
			c2: Math.max(sel.anchor.col, sel.focus.col),
		};
	}

	function applySelection() {
		$$('td.selected, td.sel-focus').forEach(td => { td.classList.remove('selected', 'sel-focus'); });
		$$('th.col-selected').forEach(th => th.classList.remove('col-selected'));
		$$('tr.row-selected').forEach(tr => tr.classList.remove('row-selected'));
		$$('td.row-num.row-selected').forEach(td => td.classList.remove('row-selected'));
		const d = getActivePanel();
		if (!d) return;
		const rect = selRect();
		if (!rect) { updateToolbar(); updateFooterSelection(); return; }

		for (let r = rect.r1; r <= rect.r2; r++) {
			for (let c = rect.c1; c <= rect.c2; c++) {
				const td = cellAt(d.table, r, c);
				if (td) td.classList.add('selected');
			}
		}
		if (focusCell) {
			const fc = cellAt(d.table, focusCell.row, focusCell.col);
			if (fc) fc.classList.add('sel-focus');
		}
		// Highlight selected column headers (ths[0] is the row-gutter, data cols start at ths[1])
		const ths = $$('th', d.table);
		for (let c = rect.c1; c <= rect.c2; c++) {
			if (ths[c + 1]) ths[c + 1].classList.add('col-selected');
		}
		// Highlight row-num gutter cells for selected rows
		for (let r = rect.r1; r <= rect.r2; r++) {
			const rn = d.table.querySelector('tbody tr[data-row="' + r + '"] td.row-num');
			if (rn) rn.classList.add('row-selected');
		}
		updateToolbar();
		updateFooterSelection();
	}

	function updateFooterSelection() {
		const d = getActivePanel();
		if (!d) return;
		const footerSel = $('.footer-selection', d.panel);
		if (!footerSel) return;
		const rect = selRect();
		if (!rect) { footerSel.style.display = 'none'; return; }
		const rows = rect.r2 - rect.r1 + 1;
		const cols = rect.c2 - rect.c1 + 1;
		const cells = rows * cols;
		// Compute sum/avg for numeric selections
		let sum = 0, count = 0;
		for (let r = rect.r1; r <= rect.r2; r++) {
			for (let c = rect.c1; c <= rect.c2; c++) {
				const v = d.rows[r]?.[c];
				if (v !== null && v !== undefined) {
					const n = parseFloat(String(v).replace(/,/g, ''));
					if (!isNaN(n)) { sum += n; count++; }
				}
			}
		}
		let text = cells + ' cells';
		if (rows > 1 || cols > 1) text = rows + '×' + cols + ' (' + cells + ' cells)';
		if (count > 0) text += ' · Sum: ' + formatNum(sum) + ' · Avg: ' + formatNum(sum / count);
		footerSel.textContent = text;
		footerSel.style.display = '';
	}

	function formatNum(n) {
		if (Number.isInteger(n)) return n.toLocaleString();
		return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
	}

	// ── Cell Click / Selection ──────────────────────────────
	document.addEventListener('mousedown', e => {
		if (resizeState) return;
		if (e.button !== 0) return; // right/middle click — preserve selection
		const rowNum = e.target.closest('td.row-num');
		const td = e.target.closest('td');
		const th = e.target.closest('th');

		// Row gutter click → select entire row
		if (rowNum) {
			const d = getActivePanel();
			if (!d) return;
			const row = parseInt(rowNum.getAttribute('data-row'));
			if (isNaN(row)) return;
			const maxCol = d.columns.length - 1;
			if (e.shiftKey && sel.anchor) {
				sel.focus = { row, col: maxCol };
				sel.anchor = { ...sel.anchor, col: 0 };
			} else {
				sel = { anchor: { row, col: 0 }, focus: { row, col: maxCol }, mode: 'row' };
			}
			focusCell = { row, col: 0 };
			applySelection();
			e.preventDefault();
			return;
		}

		if (td && !td.classList.contains('row-num') && !e.target.classList.contains('resize-handle')) {
			const row = parseInt(td.getAttribute('data-row'));
			const col = parseInt(td.getAttribute('data-col'));
			if (isNaN(row) || isNaN(col)) return;

			if (e.shiftKey && sel.anchor) {
				sel.focus = { row, col };
				focusCell = { row, col };
			} else {
				sel = { anchor: { row, col }, focus: { row, col }, mode: 'cell' };
				focusCell = { row, col };
			}
			applySelection();
			return;
		}

		// Column header click → select entire column (ignore resize/sort handles)
		if (th && !th.classList.contains('row-gutter') && !e.target.classList.contains('resize-handle') && !e.target.classList.contains('sort-btn') && th.closest('thead')) {
			const d = getActivePanel();
			if (!d) return;
			// subtract 1 to account for the row-gutter th at index 0
			const ci = Array.from(th.parentElement.children).indexOf(th) - 1;
			if (ci < 0) return;
			const maxRow = d.rows.length - 1;
			if (maxRow < 0) return;
			if (e.shiftKey && sel.anchor) {
				sel.focus = { row: maxRow, col: ci };
				sel.anchor = { ...sel.anchor, row: 0 };
			} else {
				sel = { anchor: { row: 0, col: ci }, focus: { row: maxRow, col: ci }, mode: 'col' };
			}
			focusCell = { row: 0, col: ci };
			applySelection();
			e.preventDefault(); // prevent text selection on header click
		}
	});

	// Drag to extend selection
	document.addEventListener('mousemove', e => {
		if (resizeState) return;
		if (!(e.buttons & 1)) return;
		if (!sel.anchor) return;
		const td = e.target.closest('td');
		if (!td) return;
		const row = parseInt(td.getAttribute('data-row'));
		const col = parseInt(td.getAttribute('data-col'));
		if (isNaN(row) || isNaN(col)) return;
		sel.focus = { row, col };
		focusCell = { row, col };
		applySelection();
	});

	// ── Single-click copy ───────────────────────────────────
	document.addEventListener('click', e => {
		const td = e.target.closest('td');
		if (!td || td.classList.contains('row-num') || resizeState) return;
		const val = td.classList.contains('null-val') ? 'NULL' : td.textContent;
		vscode.postMessage({ type: 'copyValue', value: val });
		td.classList.add('flash');
		setTimeout(() => td.classList.remove('flash'), 300);
	});

	// ── Keyboard Navigation ─────────────────────────────────
	document.addEventListener('keydown', e => {
		const d = getActivePanel();
		if (!d) return;
		const maxRow = d.rows.length - 1;
		const maxCol = d.columns.length - 1;
		if (maxRow < 0) return;

		// Open filter on typing
		if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && !e.key.match(/[\\s]/)) {
			const filterBar = $('.filter-bar', d.panel);
			if (filterBar && filterBar.style.display === 'none') {
				if (e.target === document.body || e.target.closest('table')) {
					filterBar.style.display = 'flex';
					const input = $('.filter-input', d.panel);
					input.value = e.key;
					input.focus();
					e.preventDefault();
					return;
				}
			}
		}

		// Arrow navigation
		const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
		if (arrows[e.key]) {
			e.preventDefault();
			const [dr, dc] = arrows[e.key];
			if (!focusCell) {
				focusCell = { row: 0, col: 0 };
				sel = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 }, mode: 'cell' };
			} else {
				let nr = Math.max(0, Math.min(maxRow, focusCell.row + dr));
				let nc = Math.max(0, Math.min(maxCol, focusCell.col + dc));
				focusCell = { row: nr, col: nc };
				if (e.shiftKey) {
					sel.focus = { row: nr, col: nc };
				} else {
					sel = { anchor: { row: nr, col: nc }, focus: { row: nr, col: nc }, mode: 'cell' };
				}
			}
			applySelection();
			// Scroll into view
			const fc = cellAt(d.table, focusCell.row, focusCell.col);
			if (fc) fc.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			return;
		}

		// Tab / Shift+Tab
		if (e.key === 'Tab') {
			e.preventDefault();
			if (!focusCell) { focusCell = { row: 0, col: 0 }; }
			else {
				if (e.shiftKey) {
					focusCell.col--;
					if (focusCell.col < 0) { focusCell.col = maxCol; focusCell.row = Math.max(0, focusCell.row - 1); }
				} else {
					focusCell.col++;
					if (focusCell.col > maxCol) { focusCell.col = 0; focusCell.row = Math.min(maxRow, focusCell.row + 1); }
				}
			}
			sel = { anchor: { ...focusCell }, focus: { ...focusCell }, mode: 'cell' };
			applySelection();
			const fc = cellAt(d.table, focusCell.row, focusCell.col);
			if (fc) fc.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			return;
		}

		// Ctrl+A → select all
		if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
			e.preventDefault();
			sel = { anchor: { row: 0, col: 0 }, focus: { row: maxRow, col: maxCol }, mode: 'cell' };
			focusCell = { row: 0, col: 0 };
			applySelection();
			return;
		}

		// Ctrl+C → copy selection
		if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
			e.preventDefault();
			copySelection();
			return;
		}

		// Enter/Space → copy focused cell
		if ((e.key === 'Enter' || e.key === ' ') && focusCell) {
			e.preventDefault();
			const val = d.rows[focusCell.row]?.[focusCell.col];
			vscode.postMessage({ type: 'copyValue', value: val === null ? 'NULL' : String(val ?? '') });
			const fc = cellAt(d.table, focusCell.row, focusCell.col);
			if (fc) { fc.classList.add('flash'); setTimeout(() => fc.classList.remove('flash'), 300); }
			return;
		}

		// Escape → clear selection or close filter
		if (e.key === 'Escape') {
			const filterBar = $('.filter-bar', d.panel);
			if (filterBar && filterBar.style.display !== 'none') {
				$('.filter-input', d.panel).value = '';
				applyFilter(d);
				filterBar.style.display = 'none';
			} else {
				clearSelection();
			}
			return;
		}
	});

	// ── Copy Selection as TSV ───────────────────────────────
	function copySelection() {
		const d = getActivePanel();
		if (!d) return;
		const rect = selRect();
		if (!rect) return;
		const lines = [];
		for (let r = rect.r1; r <= rect.r2; r++) {
			const vals = [];
			for (let c = rect.c1; c <= rect.c2; c++) {
				const v = d.rows[r]?.[c];
				vals.push(v === null ? '' : String(v ?? ''));
			}
			lines.push(vals.join('\\t'));
		}
		vscode.postMessage({ type: 'copyValue', value: lines.join('\\n') });
	}

	// ── Floating Toolbar ────────────────────────────────────
	const toolbar = document.getElementById('floatToolbar');

	function updateToolbar() {
		const rect = selRect();
		const cells = rect ? (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1) : 0;
		toolbar.classList.toggle('visible', cells > 1);
	}

	toolbar.addEventListener('click', e => {
		const btn = e.target.closest('button');
		if (!btn) return;
		const action = btn.getAttribute('data-action');
		const d = getActivePanel();
		if (!d) return;

		if (action === 'stats') {
			toggleStats(d.panel);
			return;
		}

		const rect = selRect();
		if (!rect) return;

		if (action === 'copy') {
			copySelection();
			return;
		}

		// Build sub-data for export
		const cols = d.columns.slice(rect.c1, rect.c2 + 1);
		const rows = [];
		for (let r = rect.r1; r <= rect.r2; r++) {
			const obj = {};
			for (let c = rect.c1; c <= rect.c2; c++) {
				obj[d.columns[c]] = d.rows[r]?.[c];
			}
			rows.push(obj);
		}
		const tabIdx = parseInt($('.panel.active')?.getAttribute('data-index') ?? '0');
		vscode.postMessage({ type: 'export', tabIndex: tabIdx, format: action, selection: rect });
	});

	// ── Column Sorting ──────────────────────────────────────
	$$('th').forEach(th => {
		th.addEventListener('click', e => {
			if (!e.target.classList.contains('sort-btn')) return; // only the ↕ button sorts
			const table = th.closest('table');
			if (!table) return;
			const tbody = $('tbody', table);
			if (!tbody) return;
			const colIndex = Array.from(th.parentElement.children).indexOf(th);
			const rows = $$('tr', tbody);
			const isAsc = th.classList.contains('sort-asc');

			$$('th', th.parentElement).forEach(h => h.classList.remove('sort-asc', 'sort-desc'));

			rows.sort((a, b) => {
				const aVal = a.children[colIndex]?.textContent ?? '';
				const bVal = b.children[colIndex]?.textContent ?? '';
				const aNull = a.children[colIndex]?.classList.contains('null-val');
				const bNull = b.children[colIndex]?.classList.contains('null-val');
				if (aNull && bNull) return 0;
				if (aNull) return 1;
				if (bNull) return -1;
				const aNum = Number(aVal);
				const bNum = Number(bVal);
				const numeric = !isNaN(aNum) && !isNaN(bNum) && aVal !== '' && bVal !== '';
				const cmp = numeric ? aNum - bNum : aVal.localeCompare(bVal);
				return isAsc ? -cmp : cmp;
			});

			th.classList.add(isAsc ? 'sort-desc' : 'sort-asc');
			rows.forEach(r => tbody.appendChild(r));

			// Re-index data-row attributes after sort
			rows.forEach((tr, i) => {
				tr.setAttribute('data-row', i);
				$$('td', tr).forEach(td => td.setAttribute('data-row', i));
			});
			// Rebuild panel data rows
			const panelEl = th.closest('.panel');
			if (panelEl) {
				const idx = parseInt(panelEl.getAttribute('data-index'));
				const d = panelDataMap.get(idx);
				if (d) {
					d.rows = $$('tbody tr', d.table).map(tr =>
						$$('td', tr).map(td => td.classList.contains('null-val') ? null : td.textContent)
					);
				}
			}
		});
	});

	// ── Column Stats Toggle ─────────────────────────────────
	function toggleStats(panel) {
		const statRow = $('thead .stat-row', panel);
		if (!statRow) return;
		const show = statRow.style.display === 'none';
		statRow.style.display = show ? '' : 'none';
		const statH = show ? statRow.offsetHeight : 0;
		$$('th', panel).forEach(th => { th.style.top = statH + 'px'; });
	}

	function buildStatsFoot(d) {
		// statTds[0] is the row-gutter corner cell, data cols start at index 1
		const statTds = $$('.stat-td', d.table);
		d.columns.forEach((col, ci) => {
			const td = statTds[ci + 1];
			if (!td) return;
			const values = d.rows.map(r => r[ci]);
			const nonNull = values.filter(v => v !== null && v !== '');
			const total = values.length;
			const nullCount = total - nonNull.length;
			const rt = d.resolvedTypes[col];
			let barsHtml = '';
			let summaryText = '';
			let tooltipText = 'type: ' + rt + '\\ntotal: ' + total + '\\nnulls: ' + nullCount;

			if (rt === 'number') {
				const nums = nonNull.map(v => parseFloat(String(v).replace(/,/g, ''))).filter(n => !isNaN(n));
				if (nums.length > 0) {
					const min = nums.reduce((a, b) => a < b ? a : b, Infinity);
					const max = nums.reduce((a, b) => a > b ? a : b, -Infinity);
					const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
					const buckets = new Array(10).fill(0);
					const range = max - min || 1;
					nums.forEach(n => { const b = Math.min(9, Math.floor((n - min) / range * 10)); buckets[b]++; });
					const maxB = Math.max(...buckets, 1);
					barsHtml = buckets.map(c => '<span class="stat-dist-bar" style="height:' + Math.max(2, Math.round(c / maxB * 18)) + 'px"></span>').join('');
					summaryText = formatNum(min) + '\u2013' + formatNum(max);
					tooltipText += '\\nmin: ' + min + '\\nmax: ' + max + '\\nmean: ' + mean.toFixed(2);
				} else {
					summaryText = '\u2014';
				}
			} else if (rt === 'boolean') {
				const trueCount = nonNull.filter(v => ['true','t','yes','1'].includes(String(v).toLowerCase())).length;
				const falseCount = nonNull.length - trueCount;
				const tH = Math.max(2, Math.round((total > 0 ? trueCount / total : 0) * 18));
				const fH = Math.max(2, Math.round((total > 0 ? falseCount / total : 0) * 18));
				barsHtml = '<span class="stat-dist-bar" style="height:' + tH + 'px"></span>' +
				           '<span class="stat-dist-bar stat-false-bar" style="height:' + fH + 'px"></span>';
				summaryText = (total > 0 ? Math.round(trueCount / total * 100) : 0) + '% true';
				tooltipText += '\\ntrue: ' + trueCount + '\\nfalse: ' + falseCount;
			} else if (rt === 'date') {
				const sorted = nonNull.map(v => String(v)).sort();
				if (sorted.length > 0) {
					barsHtml = '<span class="stat-dist-bar" style="height:10px;flex-grow:1"></span>';
					summaryText = sorted[0] + '\u2013' + sorted[sorted.length - 1];
					tooltipText += '\\nmin: ' + sorted[0] + '\\nmax: ' + sorted[sorted.length - 1];
				}
			} else {
				const freq = {};
				nonNull.forEach(v => { const k = String(v); freq[k] = (freq[k] || 0) + 1; });
				const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
				const maxF = top.length > 0 ? top[0][1] : 1;
				barsHtml = top.map(([, c]) => '<span class="stat-dist-bar" style="height:' + Math.max(2, Math.round(c / maxF * 18)) + 'px"></span>').join('');
				if (nullCount > 0) barsHtml += '<span class="stat-dist-bar null-bar" style="height:' + Math.max(2, Math.round(nullCount / total * 18)) + 'px"></span>';
				const distinct = Object.keys(freq).length;
				summaryText = distinct + ' distinct';
				tooltipText += '\\ndistinct: ' + distinct;
				if (top.length > 0) tooltipText += '\\ntop: ' + top.slice(0, 5).map(([v, c]) => v + ' (' + c + ')').join(', ');
			}

			const nullPct = total > 0 ? Math.round(nullCount / total * 100) : 0;
			if (nullPct > 0) summaryText += ' \u00b7 ' + nullPct + '%\u2205';
			td.innerHTML = '<div class="stat-dist">' + barsHtml + '</div><div class="stat-summary">' + escHtml(summaryText) + '</div>';
			td.title = tooltipText;
		});
	}

	// ── Filter ──────────────────────────────────────────────
	$$('.filter-input').forEach(input => {
		let debounce = null;
		input.addEventListener('input', () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => {
				const panel = input.closest('.panel');
				const idx = parseInt(panel?.getAttribute('data-index'));
				const d = panelDataMap.get(idx);
				if (d) applyFilter(d);
			}, 150);
		});
	});

	$$('.filter-clear').forEach(btn => {
		btn.addEventListener('click', () => {
			const panel = btn.closest('.panel');
			if (!panel) return;
			const input = $('.filter-input', panel);
			input.value = '';
			const idx = parseInt(panel.getAttribute('data-index'));
			const d = panelDataMap.get(idx);
			if (d) applyFilter(d);
			panel.querySelector('.filter-bar').style.display = 'none';
		});
	});

	function applyFilter(d) {
		const input = $('.filter-input', d.panel);
		const status = $('.filter-status', d.panel);
		const query = (input?.value ?? '').trim();
		const rows = $$('tbody tr', d.table);

		if (!query) {
			rows.forEach(tr => tr.classList.remove('filtered-out'));
			if (status) status.textContent = '';
			return;
		}

		const filter = parseFilter(query, d.columns);
		let shown = 0;
		rows.forEach((tr, ri) => {
			const match = filter(d.rows[ri], d.columns);
			tr.classList.toggle('filtered-out', !match);
			if (match) shown++;
		});
		if (status) status.textContent = shown + ' of ' + rows.length + ' rows';
	}

	function parseFilter(query, columns) {
		// Smart filter DSL: "col: >100", "col: contains foo", "col: = bar", or plain text search
		const match = query.match(/^([^:]+):\\s*(.+)$/);
		if (match) {
			const colName = match[1].trim().toLowerCase();
			const expr = match[2].trim();
			const ci = columns.findIndex(c => c.toLowerCase() === colName);
			if (ci >= 0) {
				if (expr.startsWith('>')) {
					const n = parseFloat(expr.slice(1));
					if (!isNaN(n)) return (row) => { const v = parseFloat(String(row[ci]).replace(/,/g, '')); return !isNaN(v) && v > n; };
				}
				if (expr.startsWith('<')) {
					const n = parseFloat(expr.slice(1));
					if (!isNaN(n)) return (row) => { const v = parseFloat(String(row[ci]).replace(/,/g, '')); return !isNaN(v) && v < n; };
				}
				if (expr.startsWith('>=')) {
					const n = parseFloat(expr.slice(2));
					if (!isNaN(n)) return (row) => { const v = parseFloat(String(row[ci]).replace(/,/g, '')); return !isNaN(v) && v >= n; };
				}
				if (expr.startsWith('<=')) {
					const n = parseFloat(expr.slice(2));
					if (!isNaN(n)) return (row) => { const v = parseFloat(String(row[ci]).replace(/,/g, '')); return !isNaN(v) && v <= n; };
				}
				if (expr.startsWith('= ') || expr.startsWith('==')) {
					const val = expr.replace(/^[= ]+/, '').toLowerCase();
					return (row) => String(row[ci] ?? '').toLowerCase() === val;
				}
				if (expr.startsWith('!=') || expr.startsWith('<>')) {
					const val = expr.slice(2).trim().toLowerCase();
					if (val === 'null') return (row) => row[ci] !== null;
					return (row) => String(row[ci] ?? '').toLowerCase() !== val;
				}
				if (expr.toLowerCase().startsWith('contains ')) {
					const val = expr.slice(9).toLowerCase();
					return (row) => String(row[ci] ?? '').toLowerCase().includes(val);
				}
				// Default: contains match for the column
				return (row) => String(row[ci] ?? '').toLowerCase().includes(expr.toLowerCase());
			}
		}
		// Plain text: search all columns
		const lq = query.toLowerCase();
		return (row) => row.some(v => v !== null && String(v).toLowerCase().includes(lq));
	}

	function escHtml(s) {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	// ── Messages from extension ─────────────────────────────
	window.addEventListener('message', e => {
		const msg = e.data;
		if (msg?.type === 'toggleStats') {
			const panel = $('.panel.active');
			if (panel) toggleStats(panel);
		}
		if (msg?.type === 'requestExport') {
			const tabIdx = parseInt($('.panel.active')?.getAttribute('data-index') ?? '0');
			const rect = msg.target === 'file' ? undefined : selRect();
			vscode.postMessage({ type: 'export', tabIndex: tabIdx, format: msg.format, target: msg.target, ...(rect ? { selection: rect } : {}) });
		}
	});

	// ── Context Menu ────────────────────────────────────────
	const ctxMenu = document.getElementById('ctxMenu');

	document.addEventListener('contextmenu', e => {
		e.preventDefault();
		const td = e.target.closest('td');
		const th = e.target.closest('th');
		const d = getActivePanel();
		if (!d) return;

		const items = [];
		if (td) {
			items.push({ label: 'Copy Cell', action: () => {
				const val = td.classList.contains('null-val') ? 'NULL' : td.textContent;
				vscode.postMessage({ type: 'copyValue', value: val });
			}});
		}
		if (selRect()) {
			items.push({ label: 'Copy Selection (TSV)', action: copySelection });
		}

		ctxMenu.innerHTML = '';
		if (items.length === 0) return;
		items.forEach(item => {
			if (item.sep) {
				const sep = document.createElement('div');
				sep.className = 'ctx-sep';
				ctxMenu.appendChild(sep);
				return;
			}
			const div = document.createElement('div');
			div.className = 'ctx-item';
			div.textContent = item.label;
			div.addEventListener('click', () => {
				ctxMenu.classList.remove('visible');
				item.action();
			});
			ctxMenu.appendChild(div);
		});

		ctxMenu.style.top = e.clientY + 'px';
		ctxMenu.style.left = e.clientX + 'px';
		ctxMenu.classList.add('visible');
	});

	document.addEventListener('click', e => {
		if (!e.target.closest('.ctx-menu')) {
			ctxMenu.classList.remove('visible');
		}
	});

	document.addEventListener('keydown', e => {
		if (e.key === 'Escape') ctxMenu.classList.remove('visible');
	});
})();
</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
