import * as vscode from 'vscode';
import { parseDbtTestOutput } from '../dbt/test-result-parser';
import { DbtExecutionService, Priority } from '../dbt/execution-service';
import type { CteTestRunner } from '../dbt/cte-test-runner';
import type { TestExplorerProvider, TestGroupItem, TestNodeItem } from './test-explorer-provider';
import type { ILogger } from '../types/logger';

/**
 * Bridges dbt Studio's test execution to the native VS Code Testing panel.
 *
 * All test execution — whether triggered from the sidebar tree, a CodeLens
 * action, or the native Testing panel beaker icon — routes through
 * `runTests()` / `_runHandler` so that:
 *  - the native panel shows persistent pass/fail history
 *  - the sidebar tree icons stay in sync
 */
export class VsTestController implements vscode.Disposable {
	private readonly _controller: vscode.TestController;
	private readonly _runProfile: vscode.TestRunProfile;
	/** Maps dbt uniqueId → { native TestItem, sidebar TestNodeItem } */
	private readonly _itemMap = new Map<string, { item: vscode.TestItem; node: TestNodeItem }>();
	/** Maps model name → dbt uniqueIds */
	private readonly _modelMap = new Map<string, string[]>();
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly explorerProvider: TestExplorerProvider,
		private readonly executionService: DbtExecutionService,
		private readonly logger: ILogger,
		private readonly cteTestRunner: CteTestRunner,
	) {
		this._controller = vscode.tests.createTestController('dbt-studio', 'dbt Tests');
		this._runProfile = this._controller.createRunProfile(
			'Run',
			vscode.TestRunProfileKind.Run,
			(request, token) => this._runHandler(request, token),
			true,
		);

		this._build();

		// Rebuild native items whenever the sidebar tree changes (new manifest etc.)
		this._disposables.push(
			explorerProvider.onDidChangeTreeData(() => this._build()),
		);
	}

	/**
	 * Run all tests belonging to a specific model.
	 */
	async runTestsForModel(modelName: string): Promise<void> {
		const uids = this._modelMap.get(modelName);
		if (!uids || uids.length === 0) {
			void vscode.window.showInformationMessage(`No tests found for '${modelName}' in the test tree.`);
			return;
		}
		await this.runTests(uids);
	}

	/**
	 * Entry point for sidebar commands and CodeLens actions.
	 * Pass `uniqueIds` to run specific tests, or omit to run all.
	 */
	async runTests(uniqueIds?: string[]): Promise<void> {
		let include: vscode.TestItem[] | undefined;
		if (uniqueIds) {
			include = uniqueIds.flatMap(uid => {
				const entry = this._itemMap.get(uid);
				return entry ? [entry.item] : [];
			});
		}
		const request = new vscode.TestRunRequest(include);
		const cts = new vscode.CancellationTokenSource();
		try {
			await this._runHandler(request, cts.token);
		} finally {
			cts.dispose();
		}
	}

	dispose(): void {
		this._runProfile.dispose();
		this._controller.dispose();
		this._disposables.forEach(d => d.dispose());
	}

	// ---- Private ----

	private _build(): void {
		this._itemMap.clear();
		this._modelMap.clear();
		this._controller.items.replace([]);

		for (const category of this.explorerProvider.getRoot()) {
			const catItem = this._controller.createTestItem(
				`cat:${category.label as string}`,
				category.label as string,
			);
			for (const group of category.children) {
				this._buildGroupItem(catItem, group);
			}
			this._controller.items.add(catItem);
		}
	}

	private _buildGroupItem(parent: vscode.TestItem, group: TestGroupItem): void {
		const groupItem = this._controller.createTestItem(
			`grp:${parent.id}:${group.label as string}`,
			group.label as string,
		);
		for (const node of group.children) {
			const nodeItem = this._controller.createTestItem(node.uniqueId, node.label as string, node.fileUri);
			nodeItem.description = node.description as string | undefined;
			if (node.testRange) {
				nodeItem.range = node.testRange;
			}
			this._itemMap.set(node.uniqueId, { item: nodeItem, node });
			if (group.rawName) {
				const existing = this._modelMap.get(group.rawName) ?? [];
				existing.push(node.uniqueId);
				this._modelMap.set(group.rawName, existing);
			}
			groupItem.children.add(nodeItem);
		}
		parent.children.add(groupItem);
	}

	private async _runHandler(
		request: vscode.TestRunRequest,
		token: vscode.CancellationToken,
	): Promise<void> {
		const run = this._controller.createTestRun(request);

		try {
			const leaves = this._collectLeaves(request);
			const cteLeaves = leaves.filter(([, n]) => n.kind === 'cte_test');
			const regularLeaves = leaves.filter(([, n]) => n.kind !== 'cte_test');

			// Mark everything started
			for (const [item, node] of leaves) {
				run.started(item);
				this.explorerProvider.markRunning(node.uniqueId);
			}

			// Batch-run regular (dbt) tests with JSON output for per-test results
			if (regularLeaves.length > 0 && !token.isCancellationRequested) {
				await this._runRegularBatch(run, regularLeaves, request.include === undefined, token);
			}

			// Run CTE tests one at a time (binary pass/fail from bridge)
			for (const [item, node] of cteLeaves) {
				if (token.isCancellationRequested) {
					run.skipped(item);
					this.explorerProvider.markResult(node.uniqueId, false);
					continue;
				}
				await this._runCteTest(run, item, node);
			}
		} finally {
			run.end();
		}
	}

	private async _runRegularBatch(
		run: vscode.TestRun,
		leaves: Array<[vscode.TestItem, TestNodeItem]>,
		isAll: boolean,
		token: vscode.CancellationToken,
	): Promise<void> {
		const args = isAll
			? ['test', '--log-format', 'json']
			: ['test', '--select', ...leaves.map(([, n]) => n.uniqueId), '--log-format', 'json'];

		const label = isAll ? 'all tests' : `test (${leaves.length})`;
		this.logger.info(`VsTestController: ${label} → dbt ${args.join(' ')}`);

		const result = await this.executionService.submit({
			type: 'test',
			args,
			priority: Priority.User,
			origin: 'user',
			label,
		});

		if (token.isCancellationRequested) return;

		const parsed = parseDbtTestOutput(result.stdout);

		for (const [item, node] of leaves) {
			const shortName = node.label as string;
			const testResult = parsed.get(node.uniqueId);

			if (testResult) {
				const durationMs = testResult.executionTime !== undefined
					? Math.round(testResult.executionTime * 1000)
					: undefined;
				switch (testResult.status) {
					case 'pass':
					case 'warn':
						run.passed(item, durationMs);
						this.explorerProvider.markResult(node.uniqueId, true);
						break;
					case 'skip':
						run.skipped(item);
						this.explorerProvider.markResult(node.uniqueId, false);
						break;
					case 'error': {
						const errMsg = testResult.message ?? `Test ${shortName} errored`;
						run.errored(item, new vscode.TestMessage(errMsg), durationMs);
						this.explorerProvider.markResult(node.uniqueId, false);
						break;
					}
					default: {
						const failMsg = testResult.failures !== undefined
							? `${shortName}: ${testResult.failures} failing rows`
							: (testResult.message ?? `Test ${shortName} failed`);
						run.failed(item, new vscode.TestMessage(failMsg), durationMs);
						this.explorerProvider.markResult(node.uniqueId, false);
					}
				}
			} else {
				// Test not found in JSON output — fall back to overall success flag
				if (result.success) {
					run.passed(item);
					this.explorerProvider.markResult(node.uniqueId, true);
				} else {
					run.failed(item, new vscode.TestMessage(`Test ${shortName} failed`));
					this.explorerProvider.markResult(node.uniqueId, false);
				}
			}
		}
	}

	private async _runCteTest(
		run: vscode.TestRun,
		item: vscode.TestItem,
		node: TestNodeItem,
	): Promise<void> {
		if (!node.yamlFilePath || !node.testName) {
			run.errored(item, new vscode.TestMessage('CTE test is missing yamlFilePath or testName'));
			this.explorerProvider.markResult(node.uniqueId, false);
			return;
		}

		const result = await this.cteTestRunner.runCteTest(node.yamlFilePath, node.testName);

		if (result.success) {
			run.passed(item);
			this.explorerProvider.markResult(node.uniqueId, true);
		} else {
			const msg = result.stderr || result.stdout || `CTE test ${node.testName} failed`;
			run.failed(item, new vscode.TestMessage(msg));
			this.explorerProvider.markResult(node.uniqueId, false);
		}
	}

	/** Collect all leaf TestNodeItems from the TestRunRequest. */
	private _collectLeaves(request: vscode.TestRunRequest): Array<[vscode.TestItem, TestNodeItem]> {
		const leaves: Array<[vscode.TestItem, TestNodeItem]> = [];

		const walkCollection = (col: vscode.TestItemCollection) => {
			col.forEach(item => {
				if (item.children.size > 0) {
					walkCollection(item.children);
				} else {
					const entry = this._itemMap.get(item.id);
					if (entry) leaves.push([item, entry.node]);
				}
			});
		};

		if (request.include) {
			for (const item of request.include) {
				if (item.children.size > 0) {
					walkCollection(item.children);
				} else {
					const entry = this._itemMap.get(item.id);
					if (entry) leaves.push([item, entry.node]);
				}
			}
		} else {
			walkCollection(this._controller.items);
		}

		return leaves;
	}
}
