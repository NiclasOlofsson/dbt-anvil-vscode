import * as vscode from 'vscode';
import type { ILogger } from '../../types/logger';
import type { DbtExecutionService } from '../../dbt/execution-service';
import type { DatabaseProvider } from './database-provider';
import { DatabricksProvider } from './databricks-provider';
import { DbtDatabaseProvider } from './dbt-database-provider';
import { DuckdbProvider } from './duckdb-provider';
import { ProfilesReader, type DatabricksConnection, type DuckdbConnection } from './profiles-reader';

/**
 * Create the appropriate DatabaseProvider for the given dbt adapter type.
 *
 * - `'databricks'` → DatabricksProvider (direct REST API, parallel-capable)
 * - everything else → DbtDatabaseProvider (routes through dbt show / bridge)
 *
 * @param adapterType   The adapter type from the loaded dbt manifest.
 * @param profileName   The profile name from dbt_project.yml (via ProjectConfig).
 * @param profilesDir   The resolved profiles directory (from EnvDetector).
 * @param executionService  Shared execution service (used by Databricks provider for compile_inline).
 * @param logger        Logger instance.
 */
export async function createDatabaseProvider(
	adapterType: string,
	profileName: string,
	profilesDir: string,
	projectDir: string,
	executionService: DbtExecutionService,
	logger: ILogger,
): Promise<DatabaseProvider> {
	const preferNative = vscode.workspace.getConfiguration('dbt-studio').get<boolean>('database.preferNativeAdapter', true);
	if (preferNative && adapterType === 'databricks') {
		const reader = new ProfilesReader(profileName, profilesDir);
		const connection = await reader.readConnection();

		if (connection && connection.type === 'databricks') {
			logger.info('DatabaseProviderFactory: using DatabricksProvider');
			return new DatabricksProvider(
				connection as DatabricksConnection,
				executionService,
				logger,
			);
		}

		logger.warn(
			'DatabaseProviderFactory: adapter is databricks but could not read connection from ' +
			`profiles.yml at "${profilesDir}" — falling back to DbtDatabaseProvider`,
		);
	}

	if (preferNative && adapterType === 'duckdb' && process.platform === 'win32') {
		const reader = new ProfilesReader(profileName, profilesDir);
		const connection = await reader.readConnection();

		if (connection && connection.type === 'duckdb') {
			logger.info('DatabaseProviderFactory: using DuckdbProvider');
			return new DuckdbProvider(
				connection as DuckdbConnection,
				projectDir,
				executionService,
				logger,
			);
		}

		logger.warn(
			'DatabaseProviderFactory: adapter is duckdb but could not read connection from ' +
			`profiles.yml at "${profilesDir}" — falling back to DbtDatabaseProvider`,
		);
	}

	logger.info(`DatabaseProviderFactory: using DbtDatabaseProvider for adapter "${adapterType}"`);
	return new DbtDatabaseProvider(adapterType, executionService, logger);
}
