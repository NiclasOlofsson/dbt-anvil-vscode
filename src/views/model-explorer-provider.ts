import * as vscode from 'vscode';
import type { ManifestIndexer, IndexedModel, IndexedSource, ManifestIndex } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import { materializationIcon } from '../providers/common/icons';

// ---- Tree item types ----

export type ExplorerItem = GroupItem | ModelItem | SourceItem;

export class GroupItem extends vscode.TreeItem {
	constructor(
		label: string,
		public readonly children: ExplorerItem[],
		collapsibleState?: vscode.TreeItemCollapsibleState,
	) {
		super(label, collapsibleState ?? vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = 'group';
	}
}



export class ModelItem extends vscode.TreeItem {
	constructor(public readonly model: IndexedModel) {
		super(model.name, vscode.TreeItemCollapsibleState.None);
		this.description = model.layer
			? `${model.layer.name} · ${model.materialisation}`
			: model.materialisation;
		this.tooltip = `${model.uniqueId}\n${model.description ?? ''}`.trim();
		this.contextValue = 'modelItem';
		this.iconPath = materializationIcon(model.materialisation);
		if (model.path) {
			this.command = {
				command: 'vscode.open',
				title: 'Open Model',
				arguments: [vscode.Uri.file(model.path)],
			};
			this.resourceUri = vscode.Uri.file(model.path);
		}
	}
}

export class SourceItem extends vscode.TreeItem {
	constructor(public readonly source: IndexedSource) {
		super(source.name, vscode.TreeItemCollapsibleState.None);
		this.description = source.schema;
		this.tooltip = `${source.uniqueId}\n${source.description ?? ''}`.trim();
		this.contextValue = 'sourceItem';
		this.iconPath = new vscode.ThemeIcon('database');
	}
}

// ---- Provider ----

interface DirNode {
	children: Map<string, DirNode>;
	models: IndexedModel[];
}

export class ModelExplorerProvider implements vscode.TreeDataProvider<ExplorerItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExplorerItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _rootItems: ExplorerItem[] = [];
	private _parentMap = new Map<ExplorerItem, ExplorerItem | undefined>();
	private _modelItemMap = new Map<string, ModelItem>();
	private _followActive: boolean;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly projectDir: string,
		private readonly globalState: vscode.Memento,
	) {
		this._followActive = globalState.get<boolean>('dbt-anvil.explorerFollowActive', false);
	}

	get followActive(): boolean {
		return this._followActive;
	}

	toggleFollow(): void {
		this._followActive = !this._followActive;
		void this.globalState.update('dbt-anvil.explorerFollowActive', this._followActive);
		void vscode.commands.executeCommand('setContext', 'dbt-anvil.explorerFollowActive', this._followActive);
	}

	refresh(): void {
		this._rebuildTree();
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ExplorerItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: ExplorerItem): ExplorerItem[] {
		if (!element) {
			if (this._rootItems.length === 0) {
				this._rebuildTree();
			}
			return this._rootItems;
		}
		if (element instanceof GroupItem) {
			return element.children;
		}
		return [];
	}

	getParent(element: ExplorerItem): ExplorerItem | undefined {
		return this._parentMap.get(element);
	}

	findModelItemForReveal(uniqueId: string): ModelItem | undefined {
		return this._modelItemMap.get(uniqueId);
	}

	// ---- Internal ----

	private _rebuildTree(): void {
		this._parentMap.clear();
		this._modelItemMap.clear();

		const index = this.indexer.index;
		if (!index) {
			this._rootItems = [];
			return;
		}

		this._rootItems = this._buildRoots(index);
		this._registerParents(undefined, this._rootItems);
	}

	private _registerParents(parent: ExplorerItem | undefined, children: ExplorerItem[]): void {
		for (const child of children) {
			this._parentMap.set(child, parent);
			if (child instanceof ModelItem && !this._modelItemMap.has(child.model.uniqueId)) {
				this._modelItemMap.set(child.model.uniqueId, child);
			}
			if (child instanceof GroupItem) {
				this._registerParents(child, child.children);
			}
		}
	}

	private _buildRoots(index: ManifestIndex): GroupItem[] {
		const roots: GroupItem[] = [];

		const dirChildren = this._buildDirectoryTree(index);
		if (dirChildren.length > 0) {
			roots.push(new GroupItem(
				`Models (${index.models.size})`,
				dirChildren,
				vscode.TreeItemCollapsibleState.Expanded,
			));
		}

		const tagChildren = this._buildTagGroups(index);
		if (tagChildren.length > 0) {
			roots.push(new GroupItem('By Tag', tagChildren));
		}

		const sourceChildren = this._buildSourceGroups(index);
		if (sourceChildren.length > 0) {
			roots.push(new GroupItem(
				`Sources (${index.sources.size})`,
				sourceChildren,
				vscode.TreeItemCollapsibleState.Expanded,
			));
		}

		return roots;
	}

	private _buildDirectoryTree(index: ManifestIndex): ExplorerItem[] {
		const root: DirNode = { children: new Map(), models: [] };
		const normProjectDir = this.projectDir.replace(/\\/g, '/').toLowerCase();

		for (const model of index.models.values()) {
			const normPath = model.path.replace(/\\/g, '/');
			const lowerPath = normPath.toLowerCase();

			let relativePath: string;
			if (lowerPath.startsWith(normProjectDir)) {
				relativePath = normPath.substring(this.projectDir.length).replace(/^[\\/]/, '');
			} else {
				relativePath = normPath;
			}

			const parts = relativePath.split('/');
			const dirParts = parts.slice(0, -1);

			let current = root;
			for (const part of dirParts) {
				if (!current.children.has(part)) {
					current.children.set(part, { children: new Map(), models: [] });
				}
				current = current.children.get(part)!;
			}
			current.models.push(model);
		}

		return this._convertDirNode(root);
	}

	private _convertDirNode(node: DirNode): ExplorerItem[] {
		const items: ExplorerItem[] = [];

		const sortedDirs = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		for (const [name, child] of sortedDirs) {
			const childItems = this._convertDirNode(child);
			const total = this._countModels(child);
			const group = new GroupItem(`${name} (${total})`, childItems);
			group.iconPath = new vscode.ThemeIcon('folder');
			items.push(group);
		}

		const sortedModels = [...node.models].sort((a, b) => a.name.localeCompare(b.name));
		for (const model of sortedModels) {
			items.push(new ModelItem(model));
		}

		return items;
	}

	private _countModels(node: DirNode): number {
		let count = node.models.length;
		for (const child of node.children.values()) {
			count += this._countModels(child);
		}
		return count;
	}

	private _buildTagGroups(index: ManifestIndex): GroupItem[] {
		const tagMap = new Map<string, IndexedModel[]>();
		for (const model of index.models.values()) {
			for (const tag of model.tags) {
				if (!tagMap.has(tag)) tagMap.set(tag, []);
				tagMap.get(tag)!.push(model);
			}
		}

		return [...tagMap.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([tag, models]) => {
				const sorted = [...models].sort((a, b) => a.name.localeCompare(b.name));
				const group = new GroupItem(
					`${tag} (${sorted.length})`,
					sorted.map(m => new ModelItem(m)),
				);
				group.iconPath = new vscode.ThemeIcon('tag');
				return group;
			});
	}

	private _buildSourceGroups(index: ManifestIndex): GroupItem[] {
		const sourceMap = new Map<string, IndexedSource[]>();
		for (const source of index.sources.values()) {
			if (!sourceMap.has(source.sourceName)) {
				sourceMap.set(source.sourceName, []);
			}
			sourceMap.get(source.sourceName)!.push(source);
		}

		return [...sourceMap.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([name, sources]) => {
				const sorted = [...sources].sort((a, b) => a.name.localeCompare(b.name));
				const group = new GroupItem(
					`${name} (${sorted.length})`,
					sorted.map(s => new SourceItem(s)),
				);
				group.iconPath = new vscode.ThemeIcon('database');
				return group;
			});
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}
