import * as vscode from 'vscode';
import type { ModelProfiler } from '../dbt/model-profiler';
import type { ProfileResult, CteProfile } from '../dbt/profiler-types';

/**
 * Webview panel that shows a waterfall/Gantt-style bar chart for profiling results.
 * Bars are ordered by CTE dependency (definition) order; widths encode marginal time.
 */
export class ProfilerWaterfallProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'dbt-studio.profilerWaterfall';

	private _view?: vscode.WebviewView;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly _profiler: ModelProfiler,
		private readonly _extensionUri: vscode.Uri,
	) {
		this._disposables.push(
			_profiler.onProfileComplete(result => this._update(result)),
		);
	}

	dispose(): void {
		for (const d of this._disposables) d.dispose();
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		this._renderEmpty();

		// Re-render if the most-recently-profiled result is already available
		const all = this._profiler.getAllResults();
		if (all.length > 0) {
			const latest = all.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
			this._update(latest);
		}
	}

	private _update(result: ProfileResult): void {
		if (!this._view) return;
		this._view.webview.html = _buildHtml(result);
	}

	private _renderEmpty(): void {
		if (!this._view) return;
		this._view.webview.html = _emptyHtml();
	}
}

// ---------------------------------------------------------------------------
// HTML generation (self-contained, no external deps)
// ---------------------------------------------------------------------------

function _emptyHtml(): string {
	return `<!DOCTYPE html><html><body style="padding:16px;color:var(--vscode-foreground);font-family:var(--vscode-font-family)">
<p style="opacity:.6">Run <strong>Profile Model</strong> on a dbt SQL file to see results here.</p>
</body></html>`;
}

function _buildHtml(result: ProfileResult): string {
	if (result.status === 'running') return _spinnerHtml();
	if (result.status === 'error') return _errorHtml(result.error ?? 'Unknown error');

	const ctes = result.cteProfiles;
	const totalMs = result.totalTimeMs || 1;

	const rows = ctes.map(cte => _barRow(cte, totalMs)).join('\n');
	const totalRow = _totalRow(result, totalMs);

	const title = result.status === 'partial'
		? `${result.modelName} (partial)`
		: result.modelName;

	return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 12px 8px;
  }
  h2 { font-size: 1em; font-weight: 600; margin-bottom: 10px; opacity: .85; }
  .chart { width: 100%; }
  .row { display: flex; align-items: center; margin-bottom: 4px; gap: 6px; }
  .label {
    width: 130px;
    min-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: .88em;
    opacity: .9;
    text-align: right;
  }
  .bar-wrap { flex: 1; background: var(--vscode-inputOption-activeBackground, rgba(128,128,128,.2)); border-radius: 2px; height: 14px; position: relative; }
  .bar { height: 100%; border-radius: 2px; min-width: 2px; }
  .meta { font-size: .8em; opacity: .7; white-space: nowrap; min-width: 80px; }
  .divider { border: none; border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.3)); margin: 6px 0; }
  .total .label { font-weight: 600; }
  .total .bar { background: var(--vscode-progressBar-background, #0e70c0); }
</style>
</head>
<body>
<h2>${_esc(title)}</h2>
<div class="chart">
${rows}
<hr class="divider">
${totalRow}
</div>
</body>
</html>`;
}

function _barRow(cte: CteProfile, totalMs: number): string {
	const pct = Math.max(0, Math.min(100, (cte.marginalTimeMs / totalMs) * 100));
	const color = _heatColor(cte.fractionOfTotal);
	const ms = Math.max(0, cte.marginalTimeMs);
	const label = ms >= 1000
		? `${(ms / 1000).toFixed(1)}s`
		: `${ms.toFixed(0)}ms`;
	const rows = _formatRows(cte.rowCount);
	return `<div class="row">
  <span class="label" title="${_esc(cte.name)}">${_esc(cte.name)}</span>
  <div class="bar-wrap"><div class="bar" style="width:${pct.toFixed(2)}%;background:${color}"></div></div>
  <span class="meta">${_esc(label)} · ${_esc(rows)}</span>
</div>`;
}

function _totalRow(result: ProfileResult, totalMs: number): string {
	const label = totalMs >= 1000
		? `${(totalMs / 1000).toFixed(2)}s`
		: `${totalMs.toFixed(0)}ms`;
	const rows = _formatRows(result.totalRowCount);
	return `<div class="row total">
  <span class="label">Total</span>
  <div class="bar-wrap"><div class="bar" style="width:100%"></div></div>
  <span class="meta">${_esc(label)} · ${_esc(rows)}</span>
</div>`;
}

function _spinnerHtml(): string {
	return `<!DOCTYPE html><html><body style="padding:16px;color:var(--vscode-foreground);font-family:var(--vscode-font-family)">
<p>⏳ Profiling…</p></body></html>`;
}

function _errorHtml(msg: string): string {
	return `<!DOCTYPE html><html><body style="padding:16px;color:var(--vscode-foreground);font-family:var(--vscode-font-family)">
<p style="color:var(--vscode-errorForeground)">Profiling failed: ${_esc(msg)}</p></body></html>`;
}

function _heatColor(fraction: number): string {
	// Interpolate between cool blue → orange → red
	if (fraction >= 0.5) return 'var(--vscode-errorForeground, #f44)';
	if (fraction >= 0.25) return 'var(--vscode-editorWarning-foreground, #fa0)';
	return 'var(--vscode-debugIcon-startForeground, #4caf50)';
}

function _formatRows(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M rows`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k rows`;
	return `${n} rows`;
}

function _esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
