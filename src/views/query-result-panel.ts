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
				// View hasn't been resolved yet — focusing it triggers resolveWebviewView.
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
		// Reveal (triggers resolveWebviewView on first call).
		void vscode.commands.executeCommand(`${QueryResultPanel.viewId}.focus`);
		// If already resolved, push results in immediately.
		if (this._view && this._results.length > 0) {
			this._view.webview.html = this._getHtml(this._results);
		}
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

	private _handleMessage(msg: { type: string; value?: string; tabIndex?: number }): void {
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

	private _emptyHtml(): string {
		return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground)"><p>Run a query (F5) to see results.</p></body></html>`;
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

			let tableHtml = '<table><thead><tr>';
			for (const col of res.columns) {
				tableHtml += `<th data-col="${escapeHtml(col)}">${escapeHtml(col)}</th>`;
			}
			tableHtml += '</tr></thead><tbody>';
			for (const row of res.rows) {
				tableHtml += '<tr>';
				for (const col of res.columns) {
					const val = row[col];
					if (val === null || val === undefined) {
						tableHtml += '<td class="null-val" title="Click to copy">NULL</td>';
					} else {
						const s = String(val);
						const display = s.length > 200 ? s.substring(0, 200) + '…' : s;
						tableHtml += `<td title="Click to copy">${escapeHtml(display)}</td>`;
					}
				}
				tableHtml += '</tr>';
			}
			tableHtml += '</tbody></table>';

			return `<div class="panel${i === 0 ? ' active' : ''}" data-index="${i}">
				<div class="table-wrap">${tableHtml}</div>
				<div class="footer">
					<span>${res.rowCount} rows · ${timeStr}</span>
					<button class="export-btn" data-index="${i}">Copy CSV</button>
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
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
body {
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
}
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
.panel { display: none; flex: 1; flex-direction: column; overflow: hidden; }
.panel.active { display: flex; }
.table-wrap { flex: 1; overflow: auto; }
table { border-collapse: collapse; width: max-content; min-width: 100%; }
th {
	position: sticky; top: 0; z-index: 1;
	background: var(--vscode-editorGroupHeader-tabsBackground);
	padding: 4px 10px; text-align: left; white-space: nowrap;
	border-bottom: 2px solid var(--vscode-panel-border);
	cursor: pointer; user-select: none;
	font-weight: 600;
}
th:hover { background: var(--vscode-list-hoverBackground); }
th::after { content: ''; margin-left: 4px; }
th.sort-asc::after { content: ' ▲'; }
th.sort-desc::after { content: ' ▼'; }
td {
	padding: 3px 10px; white-space: nowrap;
	border-bottom: 1px solid var(--vscode-editorGroup-border);
	cursor: default; max-width: 400px; overflow: hidden; text-overflow: ellipsis;
}
td:hover { background: var(--vscode-list-hoverBackground); }
tr:nth-child(even) { background: var(--vscode-editor-background); }
tr:nth-child(odd) { background: var(--vscode-editorGroupHeader-tabsBackground); }
.null-val { font-style: italic; opacity: 0.5; }
.footer {
	display: flex; justify-content: space-between; align-items: center;
	padding: 4px 10px; border-top: 1px solid var(--vscode-panel-border);
	background: var(--vscode-sideBar-background); flex-shrink: 0;
	font-size: 0.9em; opacity: 0.8;
}
.export-btn {
	background: transparent; border: 1px solid var(--vscode-button-border, var(--vscode-foreground));
	color: var(--vscode-foreground); padding: 2px 8px; cursor: pointer;
	border-radius: 3px; font-size: 0.85em; font-family: inherit;
}
.export-btn:hover { background: var(--vscode-button-hoverBackground); }
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
<script nonce="${nonce}">
(function() {
	const vscode = acquireVsCodeApi();

	// Tab switching
	document.querySelectorAll('.tab').forEach(tab => {
		tab.addEventListener('click', () => {
			document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
			document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
			tab.classList.add('active');
			const idx = tab.getAttribute('data-index');
			document.querySelector('.panel[data-index="' + idx + '"]')?.classList.add('active');
		});
	});

	// Cell click → copy
	document.querySelectorAll('td').forEach(td => {
		td.addEventListener('click', () => {
			const val = td.classList.contains('null-val') ? 'NULL' : td.textContent;
			vscode.postMessage({ type: 'copyValue', value: val });
		});
	});

	// Export CSV
	document.querySelectorAll('.export-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			vscode.postMessage({ type: 'exportCsv', tabIndex: parseInt(btn.getAttribute('data-index')) });
		});
	});

	// Column sorting (client-side)
	document.querySelectorAll('th').forEach(th => {
		th.addEventListener('click', () => {
			const table = th.closest('table');
			if (!table) return;
			const tbody = table.querySelector('tbody');
			if (!tbody) return;
			const colIndex = Array.from(th.parentElement.children).indexOf(th);
			const rows = Array.from(tbody.querySelectorAll('tr'));
			const isAsc = th.classList.contains('sort-asc');

			// Clear all sort indicators in this table
			th.parentElement.querySelectorAll('th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));

			rows.sort((a, b) => {
				const aVal = a.children[colIndex]?.textContent ?? '';
				const bVal = b.children[colIndex]?.textContent ?? '';
				const aNum = Number(aVal);
				const bNum = Number(bVal);
				const numeric = !isNaN(aNum) && !isNaN(bNum) && aVal !== '' && bVal !== '';
				const cmp = numeric ? aNum - bNum : aVal.localeCompare(bVal);
				return isAsc ? -cmp : cmp;
			});

			th.classList.add(isAsc ? 'sort-desc' : 'sort-asc');
			rows.forEach(r => tbody.appendChild(r));
		});
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
