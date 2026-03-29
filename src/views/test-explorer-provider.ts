import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import type { ManifestIndexer, ManifestIndex } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { DbtNode, DbtUnitTest } from '../dbt/manifest-types';
import type { ILogger } from '../types/logger';

// ---- Tree item types ----

export type TestItem = TestCategoryItem | TestGroupItem | TestNodeItem;

export class TestCategoryItem extends vscode.TreeItem {
	constructor(
		label: string,
		public readonly children: TestGroupItem[],
	) {
		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.contextValue = 'testCategory';
	}
}

export class TestGroupItem extends vscode.TreeItem {
	constructor(
		label: string,
		public readonly children: TestNodeItem[],
		public readonly rawName?: string,
		collapsibleState?: vscode.TreeItemCollapsibleState,
	) {
		super(label, collapsibleState ?? vscode.TreeItemCollapsibleState.Collapsed);
		this.contextValue = 'testGroup';
	}
}

type TestStatus = 'pass' | 'fail' | 'warn' | 'error' | 'skip' | 'unknown' | 'running';

const statusIcon: Record<TestStatus, string> = {
	pass: 'testing-passed-icon',
	fail: 'testing-failed-icon',
	warn: 'warning',
	error: 'testing-error-icon',
	skip: 'testing-skipped-icon',
	unknown: 'circle-outline',
	running: 'sync~spin',
};

export interface TestRunResult {
	uniqueId: string;
	status: TestStatus;
	message?: string;
	executionTime?: number;
}

/**
 * Parse a YAML schema file and return a map of test name to 0-based line number
 * for all entries under the given top-level key (e.g. 'unit_tests').
 * Uses the yaml package's CST so colon-containing names, quoted strings, and
 * multi-line values all resolve correctly.
 */
function findTestLines(content: string, topKey: string): Map<string, number> {
	const lineNumbers = new Map<string, number>();
	try {
		const doc = parseDocument(content);
		if (!isMap(doc.contents)) return lineNumbers;

		for (const pair of doc.contents.items) {
			if (!isScalar(pair.key) || pair.key.value !== topKey) continue;
			if (!isSeq(pair.value)) break;

			for (const item of pair.value.items) {
				if (!isMap(item)) continue;
				for (const p of item.items) {
					if (!isScalar(p.key) || p.key.value !== 'name') continue;
					if (!isScalar(p.value) || p.value.value === null || p.value.value === undefined) continue;
					const testName = String(p.value.value);
					const range = p.value.range;
					if (range) {
						const line = content.slice(0, range[0]).split('\n').length - 1;
						lineNumbers.set(testName, line);
					}
					break;
				}
			}
			break;
		}
	} catch {
		// Ignore parse errors — callers handle missing line numbers gracefully
	}
	return lineNumbers;
}

export class TestNodeItem extends vscode.TreeItem {
	public status: TestStatus = 'unknown';
	public readonly yamlFilePath?: string;
	public readonly testName?: string;
	public readonly fileUri?: vscode.Uri;
	public readonly testRange?: vscode.Range;

	constructor(
		public readonly uniqueId: string,
		public readonly kind: 'unit_test' | 'data_test' | 'cte_test',
		label: string,
		options?: { description?: string; tooltip?: string; filePath?: string; yamlFilePath?: string; testName?: string; lineNumber?: number },
	) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = options?.description;
		this.tooltip = options?.tooltip ?? uniqueId;
		this.yamlFilePath = options?.yamlFilePath;
		const openFilePath = options?.filePath ?? options?.yamlFilePath;
		if (openFilePath) {
			this.fileUri = vscode.Uri.file(openFilePath);
		}
		if (options?.lineNumber !== undefined) {
			this.testRange = new vscode.Range(options.lineNumber, 0, options.lineNumber, 0);
		}
		this.testName = options?.testName;
		if (kind === 'cte_test') {
			this.contextValue = 'cteTestNode';
		} else {
			this.contextValue = kind === 'unit_test' ? 'unitTestNode' : 'dataTestNode';
		}
		this.iconPath = new vscode.ThemeIcon(statusIcon['unknown']);
		if (this.fileUri) {
			this.command = {
				title: 'Open Test Definition',
				command: 'vscode.open',
				arguments: [this.fileUri, { selection: this.testRange }],
			};
		}
	}

	applyResult(result: TestRunResult): void {
		this.status = result.status;
		this.iconPath = new vscode.ThemeIcon(statusIcon[result.status]);
		if (result.executionTime !== undefined) {
			this.description = `${this.description ?? ''} (${result.executionTime.toFixed(2)}s)`.trim();
		}
		if (result.message) {
			this.tooltip = result.message;
		}
	}
}

// ---- Provider ----

export class TestExplorerProvider implements vscode.TreeDataProvider<TestItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TestItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _rootItems: TestItem[] = [];
	private _testItemMap = new Map<string, TestNodeItem>();
	private _resultCache = new Map<string, TestStatus>();
	private _testNameIndex = new Map<string, string>();

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	refresh(): void {
		this._rebuildTree();
		this._onDidChangeTreeData.fire();
	}

	applyResults(results: TestRunResult[]): void {
		for (const result of results) {
			const item = this._testItemMap.get(result.uniqueId);
			if (item) {
				item.applyResult(result);
			}
		}
		this._onDidChangeTreeData.fire();
	}

	clearResults(): void {
		this._resultCache.clear();
		for (const item of this._testItemMap.values()) {
			item.status = 'unknown';
			item.iconPath = new vscode.ThemeIcon(statusIcon['unknown']);
		}
		this._onDidChangeTreeData.fire();
	}

	markRunning(uniqueId: string): void {
		this._resultCache.set(uniqueId, 'running');
		const item = this._testItemMap.get(uniqueId);
		if (item) {
			item.status = 'running';
			item.iconPath = new vscode.ThemeIcon(statusIcon['running']);
			this._onDidChangeTreeData.fire(item);
		}
	}

	markResult(uniqueId: string, success: boolean): void {
		const status: TestStatus = success ? 'pass' : 'fail';
		this._resultCache.set(uniqueId, status);
		const item = this._testItemMap.get(uniqueId);
		if (item) {
			item.status = status;
			item.iconPath = new vscode.ThemeIcon(statusIcon[status]);
			this._onDidChangeTreeData.fire(item);
		}
	}

	markRunningByName(testName: string): void {
		const uniqueId = this._testNameIndex.get(testName);
		if (uniqueId) this.markRunning(uniqueId);
	}

	markResultByName(testName: string, success: boolean): void {
		const uniqueId = this._testNameIndex.get(testName);
		if (uniqueId) this.markResult(uniqueId, success);
	}

	getAllTestNodes(): TestNodeItem[] {
		if (this._rootItems.length === 0) {
			this._rebuildTree();
		}
		return Array.from(this._testItemMap.values());
	}

	getRoot(): TestCategoryItem[] {
		if (this._rootItems.length === 0) {
			this._rebuildTree();
		}
		return this._rootItems.filter(i => i instanceof TestCategoryItem) as TestCategoryItem[];
	}


	resolveUidByName(testName: string): string | undefined {
		return this._testNameIndex.get(testName);
	}

	getTreeItem(element: TestItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TestItem): TestItem[] {
		if (!element) {
			if (this._rootItems.length === 0) {
				this._rebuildTree();
			}
			return this._rootItems;
		}
		if (element instanceof TestCategoryItem) {
			return element.children;
		}
		if (element instanceof TestGroupItem) {
			return element.children;
		}
		return [];
	}

	// ---- Internal ----

	private _rebuildTree(): void {
		this._testItemMap.clear();
		this._testNameIndex.clear();

		const index = this.indexer.index;
		if (!index) {
			this._rootItems = [];
			return;
		}

		const { manifest } = this.loader.load();
		const unitGroups = this._buildUnitTestGroups(manifest.unit_tests ?? {}, index);
		const cteGroups = this._scanCteTests(this.loader.projectDir);
		const combinedUnitGroups = this._mergeGroups(unitGroups, cteGroups);
		const dataGroups = this._buildDataTestGroups(manifest.nodes, index);

		const categories: TestItem[] = [];

		if (combinedUnitGroups.length > 0) {
			const totalUnit = combinedUnitGroups.reduce((n: number, g: TestGroupItem) => n + g.children.length, 0);
			categories.push(new TestCategoryItem(`Unit Tests (${totalUnit})`, combinedUnitGroups));
		}

		if (dataGroups.length > 0) {
			const totalData = dataGroups.reduce((n, g) => n + g.children.length, 0);
			categories.push(new TestCategoryItem(`Data Tests (${totalData})`, dataGroups));
		}

		// Re-apply cached results after rebuild (skip 'running' — test is no longer in flight)
		for (const [uid, status] of this._resultCache) {
			if (status === 'running') continue;
			const item = this._testItemMap.get(uid);
			if (item) {
				item.status = status;
				item.iconPath = new vscode.ThemeIcon(statusIcon[status]);
			}
		}

		this._rootItems = categories;
	}

	private _buildUnitTestGroups(
		unitTests: Record<string, DbtUnitTest>,
		index: ManifestIndex,
	): TestGroupItem[] {
		const byModel = new Map<string, TestNodeItem[]>();
		const ungrouped: TestNodeItem[] = [];
		const fileCache = new Map<string, string>();
		const lineMapCache = new Map<string, Map<string, number>>();

		for (const [uid, ut] of Object.entries(unitTests)) {
			const modelDep = (ut.depends_on?.nodes ?? []).find(d => d.startsWith('model.'));
			const modelName = modelDep
				? (index.models.get(modelDep)?.name ?? modelDep.split('.').pop() ?? modelDep)
				: undefined;

			const projectDir = this.loader.projectDir;
			const filePath = ut.original_file_path
				? `${projectDir}/${ut.original_file_path}`
				: undefined;

			let lineNumber: number | undefined;
			if (filePath && ut.name) {
				if (!fileCache.has(filePath)) {
					try { fileCache.set(filePath, fs.readFileSync(filePath, 'utf8')); } catch { /* skip */ }
				}
				const content = fileCache.get(filePath);
				if (content) {
					if (!lineMapCache.has(filePath)) {
						lineMapCache.set(filePath, findTestLines(content, 'unit_tests'));
					}
					lineNumber = lineMapCache.get(filePath)!.get(ut.name);
				}
			}

			const descFull = ut.description?.trim() ?? '';
			const firstLine = descFull.split('\n')[0].trim();
			const descShort = firstLine.length > 60 ? firstLine.slice(0, 57).replace(/\s+\S*$/, '') + '…' : firstLine || undefined;
			const item = new TestNodeItem(uid, 'unit_test', ut.name, {
				description: descShort || undefined,
				tooltip: `${uid}\n${descFull}`.trim(),
				filePath,
				testName: ut.name,
				lineNumber,
			});
			this._testItemMap.set(uid, item);
			this._testNameIndex.set(ut.name, uid);

			if (modelName) {
				if (!byModel.has(modelName)) {
					byModel.set(modelName, []);
				}
				byModel.get(modelName)!.push(item);
			} else {
				ungrouped.push(item);
			}
		}

		return this._sortedGroups(byModel, ungrouped, 'symbol-method', 'beaker');
	}

	private _buildDataTestGroups(
		nodes: Record<string, DbtNode>,
		index: ManifestIndex,
	): TestGroupItem[] {
		const byModel = new Map<string, TestNodeItem[]>();
		const ungrouped: TestNodeItem[] = [];

		for (const [uid, node] of Object.entries(nodes)) {
			if (node.resource_type !== 'test') {
				continue;
			}
			const modelDep = (node.depends_on?.nodes ?? []).find(d => d.startsWith('model.'));
			const modelName = modelDep
				? (index.models.get(modelDep)?.name ?? modelDep.split('.').pop() ?? modelDep)
				: undefined;

			const testName = node.test_metadata?.name ?? node.name;
			const kwargs = node.test_metadata?.kwargs ?? {};
			const col = kwargs['column_name'] as string | undefined;

			const item = new TestNodeItem(uid, 'data_test', testName, {
				description: col ? `on ${col}` : undefined,
			});
			this._testItemMap.set(uid, item);

			if (modelName) {
				if (!byModel.has(modelName)) {
					byModel.set(modelName, []);
				}
				byModel.get(modelName)!.push(item);
			} else {
				ungrouped.push(item);
			}
		}

		return this._sortedGroups(byModel, ungrouped, 'symbol-class', 'beaker');
	}

	private _sortedGroups(
		byModel: Map<string, TestNodeItem[]>,
		ungrouped: TestNodeItem[],
		modelIcon: string,
		otherIcon: string,
	): TestGroupItem[] {
		const groups: TestGroupItem[] = [];

		for (const [modelName, items] of [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const sorted = items.sort((a, b) => (a.label as string).localeCompare(b.label as string));
			const group = new TestGroupItem(`${modelName} (${sorted.length})`, sorted, modelName);
			group.iconPath = new vscode.ThemeIcon(modelIcon);
			groups.push(group);
		}

		if (ungrouped.length > 0) {
			const sorted = ungrouped.sort((a, b) => (a.label as string).localeCompare(b.label as string));
			const group = new TestGroupItem(`Other (${sorted.length})`, sorted);
			group.iconPath = new vscode.ThemeIcon(otherIcon);
			groups.push(group);
		}

		return groups;
	}

	private _findYamlFiles(dir: string): string[] {
		const results: string[] = [];
		if (!fs.existsSync(dir)) return results;
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...this._findYamlFiles(full));
			} else if (entry.isFile() && /\.(yml|yaml)$/.test(entry.name)) {
				results.push(full);
			}
		}
		return results;
	}

	private _scanCteTests(projectDir: string): TestGroupItem[] {
		try {
			const projectFile = path.join(projectDir, 'dbt_project.yml');
			if (!fs.existsSync(projectFile)) return [];

			const projectConfig = yaml.load(fs.readFileSync(projectFile, 'utf8')) as Record<string, unknown> ?? {};
			const testPaths = (projectConfig['test-paths'] as string[] | undefined) ?? ['tests'];

			const scanDirs: string[] = testPaths.map(p => path.join(projectDir, p));
			const unitTestsDir = path.join(projectDir, 'unit_tests');
			if (fs.existsSync(unitTestsDir) && !scanDirs.includes(unitTestsDir)) {
				scanDirs.push(unitTestsDir);
			}

			const byModel = new Map<string, TestNodeItem[]>();

			for (const scanDir of scanDirs) {
				const yamlFiles = this._findYamlFiles(scanDir);
				for (const yamlFile of yamlFiles) {
					try {
						const raw = fs.readFileSync(yamlFile, 'utf8');
						const content = yaml.load(raw) as Record<string, unknown> | null;
						if (!content) continue;

						const unitTests = content['unit_tests'] as Array<Record<string, unknown>> | undefined;
						if (!Array.isArray(unitTests)) continue;

						const lineMap = findTestLines(raw, 'unit_tests');

						for (const test of unitTests) {
							const config = test['config'] as Record<string, unknown> | undefined;
							if (config?.['cte_test'] !== true) continue;

							const testName = test['name'] as string | undefined;
							const modelSpec = test['model'] as string | undefined;
							if (!testName || !modelSpec || !modelSpec.includes('::')) continue;

							const baseModel = modelSpec.split('::')[0];
							const lineNumber = lineMap.get(testName);
							const item = new TestNodeItem(
								`cte_test.${baseModel}.${testName}`,
								'cte_test',
								testName,
								{
									tooltip: `CTE test: ${testName}\nModel: ${modelSpec}`,
									yamlFilePath: yamlFile,
									testName,
									lineNumber,
								},
							);
							this._testItemMap.set(item.uniqueId, item);
							this._testNameIndex.set(testName, item.uniqueId);

							if (!byModel.has(baseModel)) {
								byModel.set(baseModel, []);
							}
							byModel.get(baseModel)!.push(item);
						}
					} catch {
						// Skip unparseable YAML files
					}
				}
			}

			const groups: TestGroupItem[] = [];
			for (const [modelName, items] of [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
				const sorted = items.sort((a, b) => (a.label as string).localeCompare(b.label as string));
				const group = new TestGroupItem(`${modelName} (${sorted.length})`, sorted, modelName);
				group.iconPath = new vscode.ThemeIcon('symbol-method');
				groups.push(group);
			}

			return groups;
		} catch {
			return [];
		}
	}

	private _mergeGroups(base: TestGroupItem[], extra: TestGroupItem[]): TestGroupItem[] {
		const byModel = new Map<string, TestNodeItem[]>();

		for (const group of [...base, ...extra]) {
			const modelName = (group.label as string).replace(/\s*\(\d+\)\s*$/, '');
			if (!byModel.has(modelName)) {
				byModel.set(modelName, []);
			}
			byModel.get(modelName)!.push(...group.children);
		}

		const merged: TestGroupItem[] = [];
		for (const [modelName, items] of [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const sorted = items.sort((a, b) => (a.label as string).localeCompare(b.label as string));
			const group = new TestGroupItem(`${modelName} (${sorted.length})`, sorted, modelName);
			group.iconPath = new vscode.ThemeIcon('symbol-method');
			merged.push(group);
		}

		return merged;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}
}
