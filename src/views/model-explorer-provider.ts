import * as vscode from 'vscode';
import type { ManifestIndexer, IndexedModel, IndexedSource, ManifestIndex } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

type ExplorerItem = GroupItem | ModelItem | SourceItem;

class GroupItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly children: ExplorerItem[],
	) {
		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.contextValue = 'group';
	}
}

class ModelItem extends vscode.TreeItem {
	constructor(public readonly model: IndexedModel) {
		super(model.name, vscode.TreeItemCollapsibleState.None);
		this.description = model.materialisation;
		this.tooltip = `${model.uniqueId}\n${model.description ?? ''}`.trim();
		this.contextValue = 'model';
		this.iconPath = new vscode.ThemeIcon('symbol-class');
		if (model.path) {
			this.command = {
				command: 'vscode.open',
				title: 'Open Model',
				arguments: [vscode.Uri.file(model.path)],
			};
		}
	}
}

class SourceItem extends vscode.TreeItem {
	constructor(public readonly source: IndexedSource) {
		super(source.name, vscode.TreeItemCollapsibleState.None);
		this.description = `${source.sourceName}.${source.schema}`;
		this.tooltip = `${source.uniqueId}\n${source.description ?? ''}`.trim();
		this.contextValue = 'source';
		this.iconPath = new vscode.ThemeIcon('database');
	}
}

export class ModelExplorerProvider implements vscode.TreeDataProvider<ExplorerItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExplorerItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ExplorerItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: ExplorerItem): ExplorerItem[] {
		if (element instanceof GroupItem) {
			return element.children;
		}

		if (element) {
			return [];
		}

		// Root level — build groups from manifest index
		const index = this.indexer.index;
		if (!index) {
			return [new GroupItem('No manifest loaded — run dbt parse', [])];
		}

		return this._buildGroups(index);
	}

	private _buildGroups(index: ManifestIndex): GroupItem[] {
		const groups: GroupItem[] = [];

		// Models grouped by materialization
		const modelsByMat = new Map<string, IndexedModel[]>();
		for (const model of index.models.values()) {
			const mat = model.materialisation;
			if (!modelsByMat.has(mat)) {
				modelsByMat.set(mat, []);
			}
			modelsByMat.get(mat)!.push(model);
		}

		if (modelsByMat.size > 0) {
			const modelChildren: ExplorerItem[] = [];
			for (const [mat, models] of [...modelsByMat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
				const sorted = models.sort((a, b) => a.name.localeCompare(b.name));
				modelChildren.push(new GroupItem(`${mat} (${sorted.length})`, sorted.map(m => new ModelItem(m))));
			}
			groups.push(new GroupItem(`Models (${index.models.size})`, modelChildren));
		}

		// Sources grouped by source_name
		const sourcesByName = new Map<string, IndexedSource[]>();
		for (const source of index.sources.values()) {
			if (!sourcesByName.has(source.sourceName)) {
				sourcesByName.set(source.sourceName, []);
			}
			sourcesByName.get(source.sourceName)!.push(source);
		}

		if (sourcesByName.size > 0) {
			const sourceChildren: ExplorerItem[] = [];
			for (const [name, sources] of [...sourcesByName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
				const sorted = sources.sort((a, b) => a.name.localeCompare(b.name));
				sourceChildren.push(new GroupItem(`${name} (${sorted.length})`, sorted.map(s => new SourceItem(s))));
			}
			groups.push(new GroupItem(`Sources (${index.sources.size})`, sourceChildren));
		}

		return groups;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}
