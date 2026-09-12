import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ILogger } from '../../../types/logger';
import type { DbtExecutionService } from '../../../dbt/execution-service';
import { createDatabaseProvider } from '../../../providers/database/database-provider-factory';
import { FabricProvider } from '../../../providers/database/fabric-provider';
import { DbtDatabaseProvider } from '../../../providers/database/dbt-database-provider';

// FabricProvider imports tedious at module load time; the factory only ever
// constructs the provider here, so a minimal, non-scriptable mock is enough.
vi.mock('tedious', () => ({
	Connection: class {},
	Request: class {},
	RequestError: class extends Error {},
	TYPES: { NVarChar: {} },
}));

function makeExecutionService(): DbtExecutionService {
	return { compileInline: vi.fn(), submit: vi.fn() } as unknown as DbtExecutionService;
}

function makeLogger(): ILogger {
	return {
		trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
		setLogLevel: vi.fn(), getLogLevel: vi.fn(),
	};
}

describe('createDatabaseProvider', () => {
	const executionService = makeExecutionService();
	const logger = makeLogger();

	it('returns a FabricProvider for a fabric connection when preferNativeAdapter is true', async () => {
		const provider = await createDatabaseProvider({ type: 'fabric', host: 'x', database: 'd' }, '/proj', executionService, logger);

		expect(provider).toBeInstanceOf(FabricProvider);
		expect(provider.adapterType).toBe('fabric');
	});

	it('falls back to DbtDatabaseProvider for a fabric connection when preferNativeAdapter is false', async () => {
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
			get: vi.fn(() => false), has: vi.fn(), update: vi.fn(),
		} as never);

		const provider = await createDatabaseProvider({ type: 'fabric', host: 'x', database: 'd' }, '/proj', executionService, logger);

		expect(provider).toBeInstanceOf(DbtDatabaseProvider);
	});

	it('returns DbtDatabaseProvider for an adapter with no native implementation', async () => {
		const provider = await createDatabaseProvider({ type: 'snowflake' }, '/proj', executionService, logger);

		expect(provider).toBeInstanceOf(DbtDatabaseProvider);
		expect(provider.adapterType).toBe('snowflake');
	});
});
