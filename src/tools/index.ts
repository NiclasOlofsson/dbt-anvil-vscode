import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { DbtExecutionService } from '../dbt/execution-service';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { CompileCache } from '../dbt/compile-cache';
import type { DatabaseProvider } from '../providers/database/database-provider';
import type { DescribeCache } from '../dbt/describe-cache';
import type { DbtQueryService } from '../services/dbt-query-service';
import type { FtlDocumentParser } from '../ftl/ftl-document-parser';
import type { McpToolRegistry } from '../mcp/host/registry';
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
import { GetDiagnosticsTool } from './get-diagnostics';
import { WorkspaceSymbolsTool } from './workspace-symbols';
import { NavigateSymbolTool } from './navigate-symbol';

interface ToolSchema {
	name: string;
	displayName?: string;
	modelDescription?: string;
	userDescription?: string;
	inputSchema?: Record<string, unknown>;
}

export function registerLanguageModelTools(
	context: vscode.ExtensionContext,
	indexer: ManifestIndexer,
	service: DbtExecutionService,
	loader: ManifestLoader,
	logger: ILogger,
	compileCache: CompileCache,
	databaseProvider: DatabaseProvider,
	describeCache: DescribeCache,
	dbtQueryService: DbtQueryService,
	ftlParser: FtlDocumentParser,
	mcpRegistry?: McpToolRegistry,
): void {
	logger.info('Registering language model tools for Copilot Agent Mode');

	const stateDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;

	const tools: Array<[string, vscode.LanguageModelTool<never>]> = [
		['run_models', new RunModelsTool(service, logger, stateDir)],
		['test_models', new TestModelsTool(service, logger, stateDir)],
		['build_models', new BuildModelsTool(service, logger, stateDir)],
		['compile_model', new CompileModelTool(service, loader, logger, indexer, compileCache)],
		['get_lineage', new GetLineageTool(indexer, logger)],
		['get_column_lineage', new GetColumnLineageTool(indexer, logger, compileCache, describeCache, ftlParser)],
		['list_resources', new ListResourcesTool(indexer, logger)],
		['get_resource_info', new GetResourceInfoTool(indexer, service, loader, logger, compileCache)],
		['get_project_info', new GetProjectInfoTool(indexer, service, loader, logger)],
		['query_database', new QueryDatabaseTool(databaseProvider, indexer, logger, dbtQueryService)],
		['install_deps', new InstallDepsTool(service, logger)],
		['analyze_impact', new AnalyzeImpactTool(indexer, logger)],
		['load_seeds', new LoadSeedsTool(service, logger, stateDir)],
		['snapshot_models', new SnapshotModelsTool(service, logger)],
		['get_diagnostics', new GetDiagnosticsTool(logger)],
		['workspace_symbols', new WorkspaceSymbolsTool(logger)],
		['navigate_symbol', new NavigateSymbolTool(logger)],
	];

	const schemas = loadToolSchemas(context, logger);
	const schemasByName = new Map(schemas.map(s => [s.name, s]));

	const canRegisterCopilot = typeof vscode.lm?.registerTool === 'function';
	if (!canRegisterCopilot) {
		logger.warn('vscode.lm.registerTool is not available in this VS Code version — skipping Copilot registration');
	}

	for (const [name, tool] of tools) {
		if (canRegisterCopilot) {
			context.subscriptions.push(vscode.lm.registerTool(name, tool));
		}

		if (mcpRegistry) {
			const schema = schemasByName.get(name);
			mcpRegistry.register({
				name,
				title: schema?.displayName,
				description: schema?.modelDescription ?? schema?.userDescription ?? '',
				inputSchema: schema?.inputSchema ?? { type: 'object', properties: {} },
				tool,
			});
		}

		logger.info(`  ✓ ${name}`);
	}

	const surfaces: string[] = [];
	if (canRegisterCopilot) { surfaces.push('Copilot'); }
	if (mcpRegistry) { surfaces.push('MCP'); }
	logger.info(`Registered ${tools.length} language model tools (${surfaces.join(', ') || 'no surfaces'})`);
}

/**
 * Reads the `languageModelTools` block from the extension's own package.json.
 * This is the authoritative source of tool descriptions and input schemas —
 * VS Code already uses it for Copilot, and the MCP registry reuses it so the
 * two surfaces cannot drift.
 */
function loadToolSchemas(context: vscode.ExtensionContext, logger: ILogger): ToolSchema[] {
	const pkg = context.extension?.packageJSON as
		{ contributes?: { languageModelTools?: ToolSchema[] } } | undefined;
	const schemas = pkg?.contributes?.languageModelTools;
	if (!Array.isArray(schemas)) {
		logger.warn('Could not read languageModelTools from package.json — MCP tool schemas will be empty');
		return [];
	}
	return schemas;
}
