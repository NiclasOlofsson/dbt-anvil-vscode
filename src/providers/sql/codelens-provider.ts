import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ModelProfiler } from '../../dbt/model-profiler';
import type { DbtPathResolver } from '../../dbt/dbt-path-resolver';
import type { ILogger } from '../../types/logger';
import { splitStatements } from '../../dbt/statement-splitter';

/**
 * CodeLens above dbt SQL model files: Run | Build | Test | Compile | Profile.
 * Also shows ad-hoc Run lenses for non-model SQL files.
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider {
	private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	private _profiler?: ModelProfiler;
	private _pathResolver?: DbtPathResolver;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	setProfiler(profiler: ModelProfiler): void {
		this._profiler = profiler;
		profiler.onProfileComplete(() => this.refresh());
	}

	setPathResolver(resolver: DbtPathResolver): void {
		this._pathResolver = resolver;
	}

	refresh(): void {
		this._onDidChangeCodeLenses.fire();
	}

	provideCodeLenses(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): vscode.CodeLens[] {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.codeLens', true)) return [];
		return this._sqlCodeLenses(document);
	}

	private _sqlCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const category = this._pathResolver?.classifyFile(document.fileName);
		const isManifestModel = category === 'model' || category === 'seed' || category === 'snapshot';

		if (!isManifestModel) {
			return this._adHocLenses(document);
		}

		const modelName = this._getModelName(document);
		const topRange = new vscode.Range(0, 0, 0, 0);
		this.logger.debug(`CodeLens: adding lenses for model '${modelName}'`);

		return [
			new vscode.CodeLens(topRange, {
				title: '$(run) Run',
				command: 'dbt-studio.runModel',
				tooltip: `dbt run -s ${modelName}`,
			}),
			new vscode.CodeLens(topRange, {
				title: '$(package) Build',
				command: 'dbt-studio.buildModel',
				tooltip: `dbt build -s ${modelName}`,
			}),
			new vscode.CodeLens(topRange, {
				title: '$(beaker) Test',
				command: 'dbt-studio.testModel',
				tooltip: `dbt test -s ${modelName}`,
			}),
			new vscode.CodeLens(topRange, {
				title: '$(gear) Compile',
				command: 'dbt-studio.compileModel',
				tooltip: `dbt compile -s ${modelName}`,
			}),
			...this._profileLens(document, modelName!, topRange),
		];
	}

	private _profileLens(
		document: vscode.TextDocument,
		modelName: string,
		range: vscode.Range,
	): vscode.CodeLens[] {
		const result = this._profiler?.getResultForFile(document.fileName);
		if (result?.status === 'running') {
			const n = result.cteProfiles.length;
			const total = result.totalCtes ?? '?';
			return [
				new vscode.CodeLens(range, {
					title: `$(loading~spin) Profiling (${n}/${total})`,
					command: 'dbt-studio.profiler.profileModel',
					tooltip: `Profiling ${modelName} — ${n} of ${total} CTEs done`,
				}),
				new vscode.CodeLens(range, {
					title: '$(stop-circle) Stop',
					command: 'dbt-studio.profiler.cancelProfiling',
					tooltip: 'Cancel profiling',
				}),
			];
		}
		let title = '$(clock) Profile';
		if (result?.status === 'complete') {
			const ms = result.totalTimeMs;
			const timeStr = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
			title = `$(clock) Profile (${timeStr})`;
		}
		return [new vscode.CodeLens(range, {
			title,
			command: 'dbt-studio.profiler.profileModel',
			tooltip: `Profile all CTEs in ${modelName}`,
		})];
	}

	private _adHocLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const text = document.getText();
		const statements = splitStatements(text);
		if (statements.length === 0) return [];

		const lenses: vscode.CodeLens[] = [];

		// "Run All" at top of file when there are multiple statements
		if (statements.length > 1) {
			lenses.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
				title: `$(run-all) Run All (${statements.length})`,
				command: 'dbt-studio.executeAll',
				tooltip: `Execute all ${statements.length} statements`,
			}));
		}

		// Per-statement "Run" lens
		for (const stmt of statements) {
			const range = new vscode.Range(stmt.startLine, 0, stmt.startLine, 0);
			lenses.push(new vscode.CodeLens(range, {
				title: '$(play) Run',
				command: 'dbt-studio.executeStatement',
				arguments: [stmt.sql],
				tooltip: stmt.sql.length > 80 ? stmt.sql.substring(0, 80) + '…' : stmt.sql,
			}));
		}

		return lenses;
	}

	private _getModelName(document: vscode.TextDocument): string | undefined {
		const fileName = document.fileName.split(/[\\/]/).pop();
		if (!fileName) return undefined;
		return fileName.replace(/\.sql$/, '');
	}
}
