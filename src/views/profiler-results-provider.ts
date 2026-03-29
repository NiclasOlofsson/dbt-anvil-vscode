import * as vscode from 'vscode';
import type { ModelProfiler } from '../dbt/model-profiler';
import type { ProfileResult, CteProfile } from '../dbt/profiler-types';

/** TreeItem for a CTE that hasn't been profiled yet (run in progress). */
class PendingCteItem extends vscode.TreeItem {
	constructor(name: string) {
		super(name, vscode.TreeItemCollapsibleState.None);
		this.description = 'pending…';
		this.iconPath = new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('editorCodeLens.foreground'));
		this.contextValue = 'profilerCtePending';
	}
}

/** TreeItem representing one CTE's timing row. */
class CteProfileItem extends vscode.TreeItem {
	constructor(
		readonly cte: CteProfile,
		readonly result: ProfileResult,
	) {
		// Negative marginal time = measurement noise (server ran faster with more CTEs due to warm cache/JIT).
		// Clamp to 0 — it means the CTE had no measurable cost, not that time ran backwards.
		const ms = Math.max(0, cte.marginalTimeMs);
		const label = `${_formatMs(ms)} — ${cte.name}`;

		super(label, vscode.TreeItemCollapsibleState.None);

		const pct = Math.max(0, Math.round(cte.fractionOfTotal * 100));
		const rows = _formatRows(cte.rowCount);
		this.description = `${rows} · ${pct}%`;
		this.tooltip = new vscode.MarkdownString(
			[
				`**${cte.name}**`,
				'',
				'| | |',
				'|---|---|',
				`| Marginal time | \`${_formatMs(ms)}\` |`,
				`| Query time | \`${_formatMs(cte.queryTimeMs)}\` |`,
				`| Row count | \`${cte.rowCount.toLocaleString()}\` |`,
				`| Share of total | \`${pct}%\` |`,
			].join('\n'),
		);
		this.iconPath = _tierIcon(cte.fractionOfTotal);
		this.command = {
			command: 'dbt-studio.profiler.goToCte',
			title: 'Go to CTE',
			arguments: [result.sourceFilePath, cte.definitionLine],
		};
		this.contextValue = 'profilerCte';
	}
}

/** Root item for one profiled model. */
class ModelProfileItem extends vscode.TreeItem {
	constructor(readonly result: ProfileResult) {
		const totalMs = result.status === 'running' && result.cteProfiles.length > 0
			? result.cteProfiles[result.cteProfiles.length - 1].queryTimeMs
			: result.totalTimeMs;
		const label = `${_formatMs(totalMs)} — ${result.modelName}`;

		const collapsed = (result.cteProfiles.length > 0 || (result.pendingCteNames?.length ?? 0) > 0)
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.None;

		super(label, collapsed);

		this.description = result.status === 'running'
			? 'profiling…'
			: result.status === 'error'
				? `error: ${result.error}`
				: _formatRows(result.totalRowCount);

		this.tooltip = result.error ?? result.modelName;
		this.iconPath = _modelIcon(result);
		this.contextValue = 'profilerModel';
	}
}

type TreeEntry = ModelProfileItem | CteProfileItem | PendingCteItem;

export class ProfilerResultsProvider implements vscode.TreeDataProvider<TreeEntry>, vscode.Disposable {
	static readonly viewId = 'dbt-studio.profilerResults';

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeEntry | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly _disposables: vscode.Disposable[] = [];

	constructor(private readonly _profiler: ModelProfiler) {
		this._disposables.push(
			_profiler.onProfileComplete(() => this._onDidChangeTreeData.fire(undefined)),
		);
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
		for (const d of this._disposables) d.dispose();
	}

	getTreeItem(element: TreeEntry): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TreeEntry): TreeEntry[] {
		if (!element) {
			// Root: one row per profiled model, most recently profiled first
			return this._profiler.getAllResults()
				.sort((a, b) => b.timestamp - a.timestamp)
				.map(r => new ModelProfileItem(r));
		}

		if (element instanceof ModelProfileItem) {
			// Completed CTEs in CTE definition order, followed by still-pending ones
			const completed = element.result.cteProfiles
				.map(cte => new CteProfileItem(cte, element.result));

			const completedNames = new Set(element.result.cteProfiles.map(p => p.name));
			const pending = (element.result.pendingCteNames ?? [])
				.filter(n => !completedNames.has(n))
				.map(n => new PendingCteItem(n));

			return [...completed, ...pending];
		}

		return [];
	}
}

function _formatRows(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M rows`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k rows`;
	return `${n} rows`;
}

function _formatMs(ms: number): string {
	if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
	if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`;
	return `${ms.toFixed(0)}ms`;
}

function _tierIcon(fraction: number): vscode.ThemeIcon {
	if (fraction >= 0.5) return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.red'));
	if (fraction >= 0.2) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
	return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.green'));
}

function _modelIcon(result: ProfileResult): vscode.ThemeIcon {
	if (result.status === 'running') return new vscode.ThemeIcon('loading~spin');
	if (result.status === 'error') return new vscode.ThemeIcon('error', new vscode.ThemeColor('editorError.foreground'));
	if (result.status === 'partial') return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
	return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
}
