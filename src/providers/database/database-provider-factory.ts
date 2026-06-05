import * as vscode from 'vscode';
import type { ILogger } from '../../types/logger';
import type { DbtExecutionService } from '../../dbt/execution-service';
import type { ProfileConnection, DatabricksConnection, DuckdbConnection } from '../../dbt/dbt-project-service';
import type { DatabaseProvider } from './database-provider';
import { DatabricksProvider } from './databricks-provider';
import { DbtDatabaseProvider } from './dbt-database-provider';

/**
 * Create the appropriate DatabaseProvider for the given connection config.
 *
 * - `connection.type === 'databricks'` → DatabricksProvider (direct REST API, parallel-capable)
 * - `connection.type === 'duckdb'` on Windows → DuckdbProvider (native node-api)
 * - everything else → DbtDatabaseProvider (routes through dbt show / bridge)
 *
 * @param connection    Active connection from DbtProjectService (may be undefined if profiles.yml unresolvable).
 * @param projectDir    Absolute path to the dbt project directory.
 * @param executionService  Shared execution service.
 * @param logger        Logger instance.
 */
export async function createDatabaseProvider(
	connection: ProfileConnection | undefined,
	projectDir: string,
	executionService: DbtExecutionService,
	logger: ILogger,
): Promise<DatabaseProvider> {
	const adapterType = connection?.type?.toLowerCase();

	if (!adapterType) {
		logger.info('DatabaseProviderFactory: no connection — using DbtDatabaseProvider');
		return new DbtDatabaseProvider('unknown', executionService, logger);
	}

	const preferNative = vscode.workspace.getConfiguration('dbt-anvil').get<boolean>('database.preferNativeAdapter', true);

	if (preferNative && adapterType === 'databricks') {
		logger.info('DatabaseProviderFactory: using DatabricksProvider');
		return new DatabricksProvider(
			connection as DatabricksConnection,
			executionService,
			logger,
		);
	}

	if (preferNative && adapterType === 'duckdb' && process.platform === 'win32') {
		logger.info('DatabaseProviderFactory: using DuckdbProvider');
		// Dynamic import keeps @duckdb/node-api out of the module graph on non-Windows
		// platforms where the native binary is not bundled.
		const { DuckdbProvider } = await import('./duckdb-provider.js');
		return new DuckdbProvider(
			connection as DuckdbConnection,
			projectDir,
			executionService,
			logger,
		);
	}

	logger.info(`DatabaseProviderFactory: using DbtDatabaseProvider for adapter "${adapterType}"`);
	return new DbtDatabaseProvider(adapterType, executionService, logger);
}
