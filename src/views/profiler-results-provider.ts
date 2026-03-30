import * as vscode from 'vscode';
import type { ModelProfiler } from '../dbt/model-profiler';
import type { ProfileResult } from '../dbt/profiler-types';

/** TreeItem for a CTE or full-model step that hasn't executed yet (run in progress). */
class PendingCteItem extends vscode.TreeItem {
	constructor(name: string) {
		super(name, vscode.TreeItemCollapsibleState.None);
		this.description = 'pending…';
		this.iconPath = new vscode.ThemeIcon('loading~spin');
		this.contextValue = 'profilerCtePending';
	}
}

/**
 * TreeItem for a completed profiling step — either a CTE or the final full-model SELECT.
 * Heat icon is ranked against the slowest step in the same run (ms / maxStepMs).
 */
class StepItem extends vscode.TreeItem {
	constructor(
		name: string,
		ms: number,
		rowCount: number,
		maxStepMs: number,
		navigateArgs?: [string, string],
	) {
		super(`${_formatMs(ms)} — ${name}`, vscode.TreeItemCollapsibleState.None);

		this.description = _formatRows(rowCount);
		this.tooltip = _tooltipTable(name, [
			['Query time', _formatMs(ms)],
			['Row count', rowCount.toLocaleString()],
		]);
		this.iconPath = _tierIcon(ms / maxStepMs);
		if (navigateArgs) {
			this.command = {
				command: 'dbt-studio.profiler.goToCte',
				title: 'Go to CTE',
				arguments: navigateArgs,
			};
		}
		this.contextValue = navigateArgs ? 'profilerCte' : 'profilerFullModel';
	}
}

/** Root item for one profiled model. */
class ModelProfileItem extends vscode.TreeItem {
	constructor(readonly result: ProfileResult) {
		const label = result.modelName;

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

type TreeEntry = ModelProfileItem | StepItem | PendingCteItem;

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
			const { result } = element;
			const lastCteMs = result.cteProfiles.length > 0 ? result.cteProfiles[result.cteProfiles.length - 1].queryTimeMs : 0;
			const fullModelMs = result.totalTimeMs > 0 ? result.totalTimeMs - lastCteMs : 0;
			const maxStepMs = Math.max(...result.cteProfiles.map(c => c.queryTimeMs), fullModelMs, 1);

			const completed = result.cteProfiles.map(cte => new StepItem(
				cte.name, cte.queryTimeMs, cte.rowCount, maxStepMs,
				[result.sourceFilePath, cte.name],
			));

			const completedNames = new Set(result.cteProfiles.map(p => p.name));
			const pending = (result.pendingCteNames ?? [])
				.filter(n => !completedNames.has(n))
				.map(n => new PendingCteItem(n));

			const allCtesDone = pending.length === 0 && result.status !== 'error';
			const fullModel: StepItem[] | PendingCteItem[] = allCtesDone
				? [result.totalTimeMs > 0
					? new StepItem(`full ${result.modelName}`, fullModelMs, result.totalRowCount, maxStepMs)
					: new PendingCteItem(`full ${result.modelName}`)]
				: [];

			return [...completed, ...pending, ...fullModel];
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

function _tooltipTable(title: string, rows: [string, string][]): vscode.MarkdownString {
	const lines = [
		`**${title}**`, '',
		'| | |', '|---|---|',
		...rows.map(([k, v]) => `| ${k} | \`${v}\` |`),
	];
	return new vscode.MarkdownString(lines.join('\n'));
}

function _tierIcon(fraction: number): vscode.ThemeIcon {
	if (fraction >= 0.5) return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.red'));
	if (fraction >= 0.2) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
	return new vscode.ThemeIcon('testing-passed-icon', new vscode.ThemeColor('charts.green'));
}

function _modelIcon(result: ProfileResult): vscode.ThemeIcon {
	if (result.status === 'running') return new vscode.ThemeIcon('loading~spin');
	if (result.status === 'error') return new vscode.ThemeIcon('testing-error-icon', new vscode.ThemeColor('editorError.foreground'));
	if (result.status === 'partial') return new vscode.ThemeIcon('testing-skipped-icon', new vscode.ThemeColor('editorWarning.foreground'));
	return new vscode.ThemeIcon('testing-passed-icon', new vscode.ThemeColor('charts.green'));
}
