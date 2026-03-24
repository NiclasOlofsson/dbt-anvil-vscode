import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';

export interface TestResultEntry {
	name: string;
	status: 'pass' | 'fail' | 'warn' | 'error' | 'skip';
	message?: string;
	executionTime?: number;
}

type TestItem = TestGroupItem | TestResultItem;

class TestGroupItem extends vscode.TreeItem {
	constructor(
		label: string,
		public readonly children: TestResultItem[],
	) {
		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.contextValue = 'testGroup';
	}
}

class TestResultItem extends vscode.TreeItem {
	constructor(public readonly entry: TestResultEntry) {
		super(entry.name, vscode.TreeItemCollapsibleState.None);
		this.description = entry.executionTime !== undefined
			? `${entry.executionTime.toFixed(2)}s`
			: undefined;
		this.tooltip = entry.message ?? entry.status;
		this.contextValue = 'testResult';

		const iconMap: Record<TestResultEntry['status'], string> = {
			pass: 'testing-passed-icon',
			fail: 'testing-failed-icon',
			warn: 'warning',
			error: 'testing-error-icon',
			skip: 'testing-skipped-icon',
		};
		this.iconPath = new vscode.ThemeIcon(iconMap[entry.status]);
	}
}

export class TestResultsProvider implements vscode.TreeDataProvider<TestItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TestItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _results: TestResultEntry[] = [];

	constructor(private readonly logger: ILogger) {}

	setResults(results: TestResultEntry[]): void {
		this._results = results;
		this._onDidChangeTreeData.fire();
	}

	clear(): void {
		this._results = [];
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TestItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TestItem): TestItem[] {
		if (element instanceof TestGroupItem) {
			return element.children;
		}

		if (element) {
			return [];
		}

		if (this._results.length === 0) {
			return [];
		}

		// Group by status
		const byStatus = new Map<string, TestResultEntry[]>();
		for (const r of this._results) {
			if (!byStatus.has(r.status)) {
				byStatus.set(r.status, []);
			}
			byStatus.get(r.status)!.push(r);
		}

		const order: TestResultEntry['status'][] = ['fail', 'error', 'warn', 'pass', 'skip'];
		const groups: TestGroupItem[] = [];

		for (const status of order) {
			const entries = byStatus.get(status);
			if (entries && entries.length > 0) {
				const items = entries
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(e => new TestResultItem(e));
				groups.push(new TestGroupItem(`${status.toUpperCase()} (${entries.length})`, items));
			}
		}

		return groups;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}
