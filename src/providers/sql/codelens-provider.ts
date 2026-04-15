import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { DbtPathResolver } from '../../dbt/dbt-path-resolver';
import type { QueryRunner } from '../../dbt/query-runner';
import type { ParseService } from '../../services/parse-service';
import type { ILogger } from '../../types/logger';
import { splitStatements } from '../../dbt/statement-splitter';

/**
 * CodeLens above dbt SQL model files: Run | Build | Test | Compile | Profile.
 * Also shows ad-hoc Run lenses for non-model SQL files.
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider {
	private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	private _pathResolver?: DbtPathResolver;
	private _queryRunner?: QueryRunner;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) {}

	setPathResolver(resolver: DbtPathResolver): void {
		this._pathResolver = resolver;
	}

	setQueryRunner(runner: QueryRunner): void {
		this._queryRunner = runner;
		runner.onRunningChange(() => this.refresh());
	}

	refresh(): void {
		this._onDidChangeCodeLenses.fire();
	}

	provideCodeLenses(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.codeLens', true)) return [];
		return this._sqlCodeLenses(document);
	}

	private async _sqlCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		const category = this._pathResolver?.classifyFile(document.fileName);
		const isManifestModel = category === 'model' || category === 'seed' || category === 'snapshot';

		if (!isManifestModel) {
			return this._adHocLenses(document);
		}

		const modelName = this._getModelName(document);
		this.logger.debug(`CodeLens: adding lenses for model '${modelName}'`);

		const modelId = this.indexer.findModelByFilePath(document.fileName);
		const adapterType = this.indexer.dialect;
		const model = modelId
			? await this.parseService.getDocumentModel(document, adapterType, { skipEnrichment: true })
			: null;

		return (model?.ctes ?? []).map(cte =>
			new vscode.CodeLens(new vscode.Range(cte.line, 0, cte.line, 0), {
				title: 'Query CTE...',
				command: 'dbt-studio.queryCte',
				arguments: [modelId, cte.name],
				tooltip: `Query CTE: ${cte.name}\n\nTip: place cursor inside this CTE and press Ctrl+F5 to run it without clicking.`,
			}),
		);
	}

	private _adHocLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const text = document.getText();
		const statements = splitStatements(text);
		if (statements.length === 0) return [];

		const lenses: vscode.CodeLens[] = [];

		const runningUri = this._queryRunner?.runningUri;
		const runningLine = this._queryRunner?.runningLine;
		const isRunningDoc = runningUri === document.uri.toString();

		// Per-statement "Run" lens
		for (const stmt of statements) {
			const range = new vscode.Range(stmt.startLine, 0, stmt.startLine, 0);
			const isRunning = isRunningDoc && runningLine === stmt.startLine;
			lenses.push(new vscode.CodeLens(range, isRunning
				? { title: 'Running...', command: '' }
				: { title: 'Press F5 to run', command: '' }));
		}

		return lenses;
	}

	private _getModelName(document: vscode.TextDocument): string | undefined {
		const fileName = document.fileName.split(/[\\/]/).pop();
		if (!fileName) return undefined;
		return fileName.replace(/\.sql$/, '');
	}
}
