import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { DbtExecutionService } from '../dbt/execution-service';
import type { ManifestLoader } from '../dbt/manifest-loader';
import { RunModelsTool } from './run-models';
import { TestModelsTool } from './test-models';
import { BuildModelsTool } from './build-models';
import { CompileModelTool } from './compile-model';
import { GetLineageTool } from './get-lineage';
import { GetColumnLineageTool } from './get-column-lineage';
import { ListResourcesTool } from './list-resources';
import { GetResourceInfoTool } from './get-resource-info';
import { GetProjectInfoTool } from './get-project-info';
import { QueryDatabaseTool } from './query-database';
import { InstallDepsTool } from './install-deps';
import { AnalyzeImpactTool } from './analyze-impact';
import { LoadSeedsTool } from './load-seeds';
import { SnapshotModelsTool } from './snapshot-models';

export function registerLanguageModelTools(
	context: vscode.ExtensionContext,
	indexer: ManifestIndexer,
	service: DbtExecutionService,
	loader: ManifestLoader,
	logger: ILogger,
): void {
	logger.info('Registering language model tools for Copilot Agent Mode');

	const tools: Array<[string, vscode.LanguageModelTool<never>]> = [
		['run_models', new RunModelsTool(service, logger)],
		['test_models', new TestModelsTool(service, logger)],
		['build_models', new BuildModelsTool(service, logger)],
		['compile_model', new CompileModelTool(service, loader, logger)],
		['get_lineage', new GetLineageTool(indexer, logger)],
		['get_column_lineage', new GetColumnLineageTool(indexer, service, logger)],
		['list_resources', new ListResourcesTool(indexer, logger)],
		['get_resource_info', new GetResourceInfoTool(indexer, service, loader, logger)],
		['get_project_info', new GetProjectInfoTool(indexer, service, loader, logger)],
		['query_database', new QueryDatabaseTool(service, indexer, logger)],
		['install_deps', new InstallDepsTool(service, logger)],
		['analyze_impact', new AnalyzeImpactTool(indexer, logger)],
		['load_seeds', new LoadSeedsTool(service, logger)],
		['snapshot_models', new SnapshotModelsTool(service, logger)],
	];

	for (const [name, tool] of tools) {
		context.subscriptions.push(vscode.lm.registerTool(name, tool));
		logger.info(`  ✓ ${name}`);
	}

	logger.info(`Registered ${tools.length} language model tools for Copilot Agent Mode`);
}
