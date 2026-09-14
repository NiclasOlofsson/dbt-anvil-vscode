import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import type { ConnectionConfiguration } from 'tedious';
import * as tediousModule from 'tedious';
import type { ILogger } from '../../../types/logger';
import type { DbtExecutionService } from '../../../dbt/execution-service';
import { Priority } from '../../../dbt/execution-service';
import type { FabricConnection } from '../../../dbt/dbt-project-service';
import type { CancelSignal } from '../../../providers/database/database-provider';
import { FabricProvider } from '../../../providers/database/fabric-provider';

// The real tedious .d.ts doesn't describe our test double's extra surface
// (instances, execSqlImpl, cancelled, parameters, sql...), so this file
// treats the mocked module loosely rather than fighting the real types.
const tedious = tediousModule as any;

vi.mock('tedious', async () => {
	const { EventEmitter } = await import('node:events');

	class RequestError extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.code = code;
		}
	}

	class Request extends EventEmitter {
		sql: string;
		callback: (err?: Error) => void;
		parameters: Array<{ name: string; type: unknown; value: unknown }> = [];

		constructor(sql: string, callback: (err?: Error) => void) {
			super();
			this.sql = sql;
			this.callback = callback;
		}

		addParameter(name: string, type: unknown, value: unknown): void {
			this.parameters.push({ name, type, value });
		}
	}

	class Connection extends EventEmitter {
		// Scriptable per test: given the request (and this connection), emit
		// columnMetadata/row events and invoke request.callback.
		static execSqlImpl: ((request: Request, conn: Connection) => void) | undefined;
		static instances: Connection[] = [];

		config: unknown;
		cancelled = false;
		cancel = vi.fn(() => { this.cancelled = true; });
		close = vi.fn(() => { setImmediate(() => this.emit('end')); });

		constructor(config: unknown) {
			super();
			this.config = config;
			Connection.instances.push(this);
		}

		connect(cb: (err?: Error) => void): void {
			setImmediate(() => cb());
		}

		execSql(request: Request): void {
			if (!Connection.execSqlImpl) throw new Error('test did not set Connection.execSqlImpl');
			Connection.execSqlImpl(request, this);
		}
	}

	return { Connection, Request, RequestError, TYPES: { NVarChar: {} } };
});

const { Connection, RequestError } = tedious;

// -------- shared helpers --------

function col(colName: string, typeName: string, extra: { precision?: number; scale?: number; dataLength?: number } = {}) {
	return { colName, type: { name: typeName }, ...extra };
}

function rowValues(colNames: string[], values: unknown[]) {
	return colNames.map((colName, i) => ({ value: values[i], metadata: { colName } }));
}

const INFO_SCHEMA_COLS = ['COLUMN_NAME', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH', 'NUMERIC_PRECISION', 'NUMERIC_SCALE', 'DATETIME_PRECISION'] as const;

function infoSchemaMeta() {
	return INFO_SCHEMA_COLS.map(name => col(name, 'NVarChar', { dataLength: 100 }));
}

function infoSchemaRow(values: Partial<Record<typeof INFO_SCHEMA_COLS[number], unknown>>) {
	return INFO_SCHEMA_COLS.map(name => ({ value: name in values ? values[name] : null, metadata: { colName: name } }));
}

function describeHandler(rows: Array<Partial<Record<typeof INFO_SCHEMA_COLS[number], unknown>>>, capture?: (request: any) => void) {
	return (request: any): void => {
		capture?.(request);
		request.emit('columnMetadata', infoSchemaMeta());
		for (const r of rows) request.emit('row', infoSchemaRow(r));
		request.callback();
	};
}

function makeLogger(): ILogger {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		setLogLevel: vi.fn(),
		getLogLevel: vi.fn(),
	};
}

function makeExecutionService(): DbtExecutionService {
	return {
		compileInline: vi.fn(async (s: string) => s.replace(/\{\{.*?\}\}/g, 'compiled')),
		submit: vi.fn(),
	} as unknown as DbtExecutionService;
}

function makeConnectionConfig(overrides: Partial<FabricConnection> = {}): FabricConnection {
	return {
		type: 'fabric',
		host: 'myserver.datawarehouse.fabric.microsoft.com',
		database: 'mydb',
		...overrides,
	};
}

function makeProvider(overrides: Partial<FabricConnection> = {}, executionService = makeExecutionService(), logger = makeLogger()): FabricProvider {
	return new FabricProvider(makeConnectionConfig(overrides), executionService, logger);
}

function fakeSession(token: string): vscode.AuthenticationSession {
	return { id: 'session-id', accessToken: token, account: { id: 'account-id', label: 'test account' }, scopes: [] };
}

function mockSignedIn(token = 'test-token'): void {
	vi.mocked(vscode.authentication.getSession).mockResolvedValue(fakeSession(token));
}

/** Poll until predicate is true, yielding a macrotask each time so pending microtasks/timers can settle. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out waiting for condition');
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

async function buildConfig(overrides: Partial<FabricConnection> = {}): Promise<ConnectionConfiguration> {
	mockSignedIn();
	Connection.execSqlImpl = (request: any) => {
		request.emit('columnMetadata', [col('SCHEMA_NAME', 'NVarChar', { dataLength: 100 })]);
		request.callback();
	};
	const provider = makeProvider(overrides);
	await provider.listSchemas();
	return Connection.instances.at(-1).config as ConnectionConfiguration;
}

beforeEach(() => {
	vi.mocked(vscode.authentication.getSession).mockReset();
	Connection.instances.length = 0;
	Connection.execSqlImpl = undefined;
});

// -------- tests --------

describe('FabricProvider constructor', () => {
	it('uses server as an alias for host when host is absent', async () => {
		const config = await buildConfig({ host: undefined, server: 'aliashost.fabric.example' });
		expect(config.server).toBe('aliashost.fabric.example');
	});

	it('parses a tcp: prefix and a ,port suffix out of the host string', async () => {
		const config = await buildConfig({ host: 'tcp:myserver.datawarehouse.fabric.microsoft.com,14330' });
		expect(config.server).toBe('myserver.datawarehouse.fabric.microsoft.com');
		expect(config.options?.port).toBe(14330);
	});

	it('prefers an explicit port field over one parsed from the host string', async () => {
		const config = await buildConfig({ host: 'myserver,14330', port: 1500 });
		expect(config.options?.port).toBe(1500);
	});

	it('throws when neither host nor server is set, so a broken profile fails fast', () => {
		expect(() => new FabricProvider(makeConnectionConfig({ host: undefined }), makeExecutionService(), makeLogger()))
			.toThrow(/no host/);
	});

	it('defaults port to 1433, encrypt to true, and trustServerCertificate to false', async () => {
		const config = await buildConfig({});
		expect(config.options?.port).toBe(1433);
		expect(config.options?.encrypt).toBe(true);
		expect(config.options?.trustServerCertificate).toBe(false);
	});
});

describe('FabricProvider authentication', () => {
	it.each(['CLI', undefined, 'auto', 'ActiveDirectoryInteractive'])(
		'uses the VS Code Microsoft session as an Entra access token for authentication=%s',
		async (authMode) => {
			mockSignedIn('tok-123');
			Connection.execSqlImpl = (request: any) => {
				request.emit('columnMetadata', [col('SCHEMA_NAME', 'NVarChar', { dataLength: 100 })]);
				request.callback();
			};
			const provider = makeProvider({ authentication: authMode });
			await provider.listSchemas();

			expect(vscode.authentication.getSession).toHaveBeenCalledWith(
				'microsoft', ['https://database.windows.net/.default'], { silent: true },
			);
			const config = Connection.instances.at(-1).config as ConnectionConfiguration;
			expect(config.authentication).toEqual({ type: 'azure-active-directory-access-token', options: { token: 'tok-123' } });
		},
	);

	it('adds a VSCODE_TENANT scope when tenant_id is set', async () => {
		const config = await buildConfig({ tenant_id: 'tid-1' });
		expect(vscode.authentication.getSession).toHaveBeenCalledWith(
			'microsoft', ['https://database.windows.net/.default', 'VSCODE_TENANT:tid-1'], { silent: true },
		);
		expect(config).toBeDefined();
	});

	it('uses a service principal secret and never calls getSession when client credentials are configured', async () => {
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('SCHEMA_NAME', 'NVarChar', { dataLength: 100 })]);
			request.callback();
		};
		const provider = makeProvider({
			authentication: 'ServicePrincipal', client_id: 'cid', client_secret: 'secret', tenant_id: 'tid',
		});
		await provider.listSchemas();

		expect(vscode.authentication.getSession).not.toHaveBeenCalled();
		const config = Connection.instances.at(-1).config as ConnectionConfiguration;
		expect(config.authentication).toEqual({
			type: 'azure-active-directory-service-principal-secret',
			options: { clientId: 'cid', clientSecret: 'secret', tenantId: 'tid' },
		});
	});
});

describe('FabricProvider authentication prompting', () => {
	it('prompts interactively when silent auth fails and the request is user-priority, so foreground queries can still sign in', async () => {
		vi.mocked(vscode.authentication.getSession)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(fakeSession('tok-interactive'));
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback();
		};
		const provider = makeProvider();
		await provider.query('select 1', -1, undefined, Priority.User);

		expect(vscode.authentication.getSession).toHaveBeenNthCalledWith(
			2, 'microsoft', ['https://database.windows.net/.default'], { createIfNone: true },
		);
	});

	it('never prompts interactively for background work and rejects with a sign-in message instead', async () => {
		vi.mocked(vscode.authentication.getSession).mockResolvedValue(undefined);
		const provider = makeProvider();

		await expect(provider.describe('customers')).rejects.toThrow(/Sign in/);

		expect(vscode.authentication.getSession).toHaveBeenCalledTimes(2);
		expect(vscode.authentication.getSession).toHaveBeenNthCalledWith(
			2, 'microsoft', ['https://database.windows.net/.default'], {},
		);
	});
});

describe('FabricProvider query() - Jinja compilation', () => {
	it('compiles SQL through the bridge before executing when it contains Jinja', async () => {
		mockSignedIn();
		let capturedSql = '';
		Connection.execSqlImpl = (request: any) => {
			capturedSql = request.sql;
			request.emit('columnMetadata', [col('x', 'IntN', { dataLength: 4 })]);
			request.callback();
		};
		const executionService = makeExecutionService();
		const provider = makeProvider({}, executionService);

		await provider.query('select {{ 1 }}', -1);

		expect(executionService.compileInline).toHaveBeenCalledWith('select {{ 1 }}');
		expect(capturedSql).toBe('select compiled');
	});

	it('sends plain SQL unchanged, never calling the bridge for SQL with no Jinja', async () => {
		mockSignedIn();
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('x', 'IntN', { dataLength: 4 })]);
			request.callback();
		};
		const executionService = makeExecutionService();
		const provider = makeProvider({}, executionService);

		await provider.query('select 1', -1);

		expect(executionService.compileInline).not.toHaveBeenCalled();
	});
});

describe('FabricProvider query() - column type mapping and value coercion', () => {
	it('maps tedious IntN/DecimalN/VarChar/NVarChar/DateTime2N/BitN metadata to human-readable SQL type strings', async () => {
		mockSignedIn();
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [
				col('id', 'IntN', { dataLength: 4 }),
				col('big', 'IntN', { dataLength: 8 }),
				col('amount', 'DecimalN', { precision: 19, scale: 4 }),
				col('note', 'VarChar', { dataLength: 65535 }),
				col('name', 'NVarChar', { dataLength: 100 }),
				col('ts', 'DateTime2N', { scale: 6 }),
				col('flag', 'BitN', {}),
			]);
			request.emit('row', rowValues(
				['id', 'big', 'amount', 'note', 'name', 'ts', 'flag'],
				[1, 42, '1.2345', 'x', 'y', new Date('2024-01-01T00:00:00.000Z'), true],
			));
			request.callback();
		};
		const provider = makeProvider();

		const result = await provider.query('select 1', -1);

		expect(result.columnTypes).toEqual({
			id: 'int', big: 'bigint', amount: 'decimal(19,4)', note: 'varchar(max)',
			name: 'nvarchar(50)', ts: 'datetime2(6)', flag: 'bit',
		});
		expect(typeof result.executionTimeMs).toBe('number');
	});

	it('renders Date values as ISO strings and Buffers as 0x-prefixed hex, keeping rows JSON-friendly for the result panel', async () => {
		mockSignedIn();
		const date = new Date('2024-06-01T12:34:56.000Z');
		const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('d', 'DateTime2N', { scale: 3 }), col('b', 'VarBinary', { dataLength: 16 })]);
			request.emit('row', rowValues(['d', 'b'], [date, buf]));
			request.callback();
		};
		const provider = makeProvider();

		const result = await provider.query('select 1', -1);

		expect(result.rows[0]['d']).toBe(date.toISOString());
		expect(result.rows[0]['b']).toBe('0xdeadbeef');
	});
});

describe('FabricProvider query() - row limit', () => {
	it('cancels the connection once the limit is reached and returns exactly the limited rows', async () => {
		mockSignedIn();
		Connection.execSqlImpl = (request: any, conn: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			for (let i = 1; i <= 5 && !conn.cancelled; i++) {
				request.emit('row', rowValues(['n'], [i]));
			}
			request.callback(conn.cancelled ? new RequestError('Operation cancelled', 'ECANCEL') : undefined);
		};
		const provider = makeProvider();

		const result = await provider.query('select 1', 2);

		expect(result.rows).toHaveLength(2);
		expect(result.rowCount).toBe(2);
		expect(Connection.instances.at(-1).cancel).toHaveBeenCalledTimes(1);
	});

	it('returns every row and never cancels when limit is -1 (no limit)', async () => {
		mockSignedIn();
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			for (let i = 1; i <= 5; i++) request.emit('row', rowValues(['n'], [i]));
			request.callback();
		};
		const provider = makeProvider();

		const result = await provider.query('select 1', -1);

		expect(result.rows).toHaveLength(5);
		expect(Connection.instances.at(-1).cancel).not.toHaveBeenCalled();
	});
});

describe('FabricProvider query() - cancel by caller', () => {
	it('rejects with a cancelled-by-caller message when the abort signal fires mid-stream', async () => {
		mockSignedIn();
		let abortListener: (() => void) | undefined;
		const signal: CancelSignal = {
			aborted: false,
			addEventListener: (_type, listener) => { abortListener = listener; },
			removeEventListener: () => { abortListener = undefined; },
		};
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.emit('row', rowValues(['n'], [1]));
			abortListener?.();
			request.callback(new RequestError('Operation cancelled', 'ECANCEL'));
		};
		const provider = makeProvider();

		await expect(provider.query('select 1', -1, signal)).rejects.toThrow(/cancelled by caller/);
		expect(Connection.instances.at(-1).cancel).toHaveBeenCalledTimes(1);
	});

	it('keeps the pooled connection healthy after a caller-abort cancellation, so it is reused next time', async () => {
		mockSignedIn();
		let abortListener: (() => void) | undefined;
		const signal: CancelSignal = {
			aborted: false,
			addEventListener: (_type, listener) => { abortListener = listener; },
			removeEventListener: () => { abortListener = undefined; },
		};
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			abortListener?.();
			request.callback(new RequestError('Operation cancelled', 'ECANCEL'));
		};
		const provider = makeProvider();

		await expect(provider.query('select 1', -1, signal)).rejects.toThrow(/cancelled by caller/);

		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback();
		};
		await provider.query('select 2', -1);

		expect(Connection.instances).toHaveLength(1);
	});
});

describe('FabricProvider query() - errors', () => {
	it('rejects with a FabricProvider-prefixed message carrying the original text for a non-cancel request failure', async () => {
		mockSignedIn();
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback(new Error('deadlock victim'));
		};
		const provider = makeProvider();

		await expect(provider.query('select 1', -1)).rejects.toThrow('FabricProvider: deadlock victim');
	});

	it('rejects with the server text on a RequestError, and the pooled connection is reused by the next query', async () => {
		mockSignedIn();
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback(new RequestError('Invalid column name \'x\'.', 'EREQUEST'));
		};
		const provider = makeProvider();

		await expect(provider.query('select x', -1)).rejects.toThrow(/Invalid column name/);

		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback();
		};
		await provider.query('select 1', -1);

		expect(Connection.instances).toHaveLength(1);
	});

	it('closes the connection after a plain Error (transport failure) and opens a new one for the next query', async () => {
		mockSignedIn();
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback(new Error('deadlock victim'));
		};
		const provider = makeProvider();

		await expect(provider.query('select 1', -1)).rejects.toThrow('FabricProvider: deadlock victim');
		expect(Connection.instances).toHaveLength(1);
		expect(Connection.instances[0].close).toHaveBeenCalledTimes(1);

		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback();
		};
		await provider.query('select 2', -1);

		expect(Connection.instances).toHaveLength(2);
	});
});

describe('FabricProvider query() - forceDbtShow hint', () => {
	it('routes to dbt show via the execution service and never opens a native connection, so timings stay comparable', async () => {
		const submit = vi.fn().mockResolvedValue({ success: true, stdout: '{"show": []}', stderr: '' });
		const executionService = { compileInline: vi.fn(async (s: string) => s), submit } as unknown as DbtExecutionService;
		const provider = makeProvider({}, executionService);

		await provider.query('select 1', 10, undefined, Priority.Tool, { forceDbtShow: true });

		expect(submit).toHaveBeenCalledTimes(1);
		const request = submit.mock.calls[0][0];
		expect(request.args).toEqual(expect.arrayContaining(['show', '--inline', '--limit']));
		expect(Connection.instances).toHaveLength(0);
	});
});

describe('FabricProvider describe()', () => {
	it('splits a three-part qualified name into database, schema, and table for INFORMATION_SCHEMA.COLUMNS', async () => {
		mockSignedIn();
		let capturedSql = '';
		let capturedParams: any[] = [];
		Connection.execSqlImpl = describeHandler(
			[{ COLUMN_NAME: 'id', DATA_TYPE: 'int' }],
			request => { capturedSql = request.sql; capturedParams = request.parameters; },
		);
		const provider = makeProvider();

		await provider.describe('customers', { qualifiedName: 'hopper.raw.udd__oatbatch' });

		expect(capturedSql).toContain('[hopper].INFORMATION_SCHEMA.COLUMNS');
		expect(capturedParams).toEqual([
			{ name: 'schema', type: expect.anything(), value: 'raw' },
			{ name: 'table', type: expect.anything(), value: 'udd__oatbatch' },
		]);
	});

	it('unquotes a fully bracketed qualified name before resolving the relation', async () => {
		mockSignedIn();
		let capturedSql = '';
		let capturedParams: any[] = [];
		Connection.execSqlImpl = describeHandler(
			[{ COLUMN_NAME: 'id', DATA_TYPE: 'int' }],
			request => { capturedSql = request.sql; capturedParams = request.parameters; },
		);
		const provider = makeProvider();

		await provider.describe('[hopper].[raw].[t]');

		expect(capturedSql).toContain('[hopper].INFORMATION_SCHEMA.COLUMNS');
		expect(capturedParams).toEqual([
			{ name: 'schema', type: expect.anything(), value: 'raw' },
			{ name: 'table', type: expect.anything(), value: 't' },
		]);
	});

	it('binds schema \'dbo\' and table \'tbl\' from a fully bracketed three-part qualifiedName, targeting [my.db].INFORMATION_SCHEMA.COLUMNS', async () => {
		mockSignedIn();
		let capturedSql = '';
		let capturedParams: any[] = [];
		Connection.execSqlImpl = describeHandler(
			[{ COLUMN_NAME: 'id', DATA_TYPE: 'int' }],
			request => { capturedSql = request.sql; capturedParams = request.parameters; },
		);
		const provider = makeProvider();

		await provider.describe('customers', { qualifiedName: '[my.db].[dbo].[tbl]' });

		expect(capturedSql).toContain('[my.db].INFORMATION_SCHEMA.COLUMNS');
		expect(capturedParams).toEqual([
			{ name: 'schema', type: expect.anything(), value: 'dbo' },
			{ name: 'table', type: expect.anything(), value: 'tbl' },
		]);
	});

	it('unescapes a doubled ] inside a bracketed database name (]] -> ])', async () => {
		mockSignedIn();
		let capturedSql = '';
		let capturedParams: any[] = [];
		Connection.execSqlImpl = describeHandler(
			[{ COLUMN_NAME: 'id', DATA_TYPE: 'int' }],
			request => { capturedSql = request.sql; capturedParams = request.parameters; },
		);
		const provider = makeProvider();

		await provider.describe('customers', { qualifiedName: '[a]]b].[s].[t]' });

		expect(capturedSql).toContain('[a]]b].INFORMATION_SCHEMA.COLUMNS');
		expect(capturedParams).toEqual([
			{ name: 'schema', type: expect.anything(), value: 's' },
			{ name: 'table', type: expect.anything(), value: 't' },
		]);
	});

	it('uses the profile database for a two-part schema.table name', async () => {
		mockSignedIn();
		let capturedSql = '';
		let capturedParams: any[] = [];
		Connection.execSqlImpl = describeHandler(
			[{ COLUMN_NAME: 'id', DATA_TYPE: 'int' }],
			request => { capturedSql = request.sql; capturedParams = request.parameters; },
		);
		const provider = makeProvider({ database: 'mydb' });

		await provider.describe('silver.orders');

		expect(capturedSql).toContain('[mydb].INFORMATION_SCHEMA.COLUMNS');
		expect(capturedParams).toEqual([
			{ name: 'schema', type: expect.anything(), value: 'silver' },
			{ name: 'table', type: expect.anything(), value: 'orders' },
		]);
	});

	it('uses sourceName as the schema for a bare relation name marked as a source', async () => {
		mockSignedIn();
		let capturedParams: any[] = [];
		Connection.execSqlImpl = describeHandler(
			[{ COLUMN_NAME: 'id', DATA_TYPE: 'int' }],
			request => { capturedParams = request.parameters; },
		);
		const provider = makeProvider();

		await provider.describe('udd__oatbatch', { isSource: true, sourceName: 'raw' });

		expect(capturedParams).toEqual(expect.arrayContaining([{ name: 'schema', type: expect.anything(), value: 'raw' }]));
	});

	it('uses the profile schema, defaulting to dbo, for a bare relation name with no source', async () => {
		mockSignedIn();
		let capturedParams: any[] = [];
		Connection.execSqlImpl = describeHandler(
			[{ COLUMN_NAME: 'id', DATA_TYPE: 'int' }],
			request => { capturedParams = request.parameters; },
		);
		const provider = makeProvider();

		await provider.describe('customers');

		expect(capturedParams).toEqual(expect.arrayContaining([{ name: 'schema', type: expect.anything(), value: 'dbo' }]));
	});

	it('composes SQL type strings from INFORMATION_SCHEMA rows for varchar, decimal, datetime2, int, and bit', async () => {
		mockSignedIn();
		Connection.execSqlImpl = describeHandler([
			{ COLUMN_NAME: 'a', DATA_TYPE: 'varchar', CHARACTER_MAXIMUM_LENGTH: -1 },
			{ COLUMN_NAME: 'b', DATA_TYPE: 'varchar', CHARACTER_MAXIMUM_LENGTH: 8000 },
			{ COLUMN_NAME: 'c', DATA_TYPE: 'decimal', NUMERIC_PRECISION: 19, NUMERIC_SCALE: 4 },
			{ COLUMN_NAME: 'd', DATA_TYPE: 'datetime2', DATETIME_PRECISION: 6 },
			{ COLUMN_NAME: 'e', DATA_TYPE: 'int' },
			{ COLUMN_NAME: 'f', DATA_TYPE: 'bit' },
		]);
		const provider = makeProvider();

		const columns = await provider.describe('t');

		expect(Object.fromEntries(columns.map(c => [c.name, c.type]))).toEqual({
			a: 'varchar(max)', b: 'varchar(8000)', c: 'decimal(19,4)', d: 'datetime2(6)', e: 'int', f: 'bit',
		});
	});

	it('rejects with "not found" on zero rows, so the describe cache never pins an empty column list', async () => {
		mockSignedIn();
		Connection.execSqlImpl = describeHandler([]);
		const provider = makeProvider();

		await expect(provider.describe('missing_table')).rejects.toThrow(/not found/);
	});
});

describe('FabricProvider listSchemas() and listTables()', () => {
	it('targets INFORMATION_SCHEMA.SCHEMATA and excludes system schemas that are never dbt targets', async () => {
		mockSignedIn();
		let capturedSql = '';
		Connection.execSqlImpl = (request: any) => {
			capturedSql = request.sql;
			request.emit('columnMetadata', [col('SCHEMA_NAME', 'NVarChar', { dataLength: 100 })]);
			request.callback();
		};
		const provider = makeProvider();

		await provider.listSchemas();

		expect(capturedSql).toContain('[mydb].INFORMATION_SCHEMA.SCHEMATA');
		for (const schema of ['sys', 'INFORMATION_SCHEMA', 'guest', 'queryinsights']) {
			expect(capturedSql).toContain(`'${schema}'`);
		}
		expect(capturedSql).toContain('db[_]%');
	});

	it('overrides the profile database when an explicit database argument is given', async () => {
		mockSignedIn();
		let capturedSql = '';
		Connection.execSqlImpl = (request: any) => {
			capturedSql = request.sql;
			request.emit('columnMetadata', [col('SCHEMA_NAME', 'NVarChar', { dataLength: 100 })]);
			request.callback();
		};
		const provider = makeProvider();

		await provider.listSchemas('otherdb');

		expect(capturedSql).toContain('[otherdb].INFORMATION_SCHEMA.SCHEMATA');
	});

	it('binds schema as a parameter and targets INFORMATION_SCHEMA.TABLES for listTables', async () => {
		mockSignedIn();
		let capturedSql = '';
		let capturedParams: any[] = [];
		Connection.execSqlImpl = (request: any) => {
			capturedSql = request.sql;
			capturedParams = request.parameters;
			request.emit('columnMetadata', [col('TABLE_NAME', 'NVarChar', { dataLength: 100 })]);
			request.callback();
		};
		const provider = makeProvider();

		await provider.listTables('raw');

		expect(capturedSql).toContain('[mydb].INFORMATION_SCHEMA.TABLES');
		expect(capturedParams).toEqual([{ name: 'schema', type: expect.anything(), value: 'raw' }]);
	});
});

describe('FabricProvider connection pool', () => {
	it('reuses one pooled connection across two sequential queries instead of reconnecting every time', async () => {
		mockSignedIn();
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback();
		};
		const provider = makeProvider();

		await provider.query('select 1', -1);
		await provider.query('select 2', -1);

		expect(Connection.instances).toHaveLength(1);
	});

	it('closes and drops a connection whose request threw a non-RequestError, instead of returning it to the pool', async () => {
		mockSignedIn();
		Connection.execSqlImpl = () => { throw new Error('synchronous failure'); };
		const provider = makeProvider();

		await expect(provider.query('select 1', -1)).rejects.toThrow('synchronous failure');
		expect(Connection.instances).toHaveLength(1);
		expect(Connection.instances[0].close).toHaveBeenCalledTimes(1);

		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback();
		};
		await provider.query('select 2', -1);

		expect(Connection.instances).toHaveLength(2);
	});

	it('opens at most 4 connections when 6 queries run concurrently', async () => {
		mockSignedIn();
		const pending: Array<{ request: any }> = [];
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			pending.push({ request });
			// callback is deliberately withheld — released by the test below
		};
		const provider = makeProvider();

		const results = Array.from({ length: 6 }, () => provider.query('select 1', -1));
		await waitFor(() => pending.length === 4);
		expect(Connection.instances).toHaveLength(4);

		while (pending.length > 0) pending.shift()!.request.callback();
		await waitFor(() => pending.length === 2);
		expect(Connection.instances).toHaveLength(4);

		while (pending.length > 0) pending.shift()!.request.callback();
		await Promise.all(results);
		expect(Connection.instances).toHaveLength(4);
	});

	it('closes every pooled connection on dispose', async () => {
		mockSignedIn();
		Connection.execSqlImpl = (request: any) => {
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			request.callback();
		};
		const provider = makeProvider();
		await provider.query('select 1', -1);

		provider.dispose();

		for (const conn of Connection.instances as any[]) {
			expect(conn.close).toHaveBeenCalledTimes(1);
		}
	});

	it('resolves a queued waiter on dispose, so the 5th of 5 concurrent queries settles instead of hanging', async () => {
		mockSignedIn();
		const pending: Array<{ request: any }> = [];
		Connection.execSqlImpl = (request: any, conn: any) => {
			if (Connection.instances.indexOf(conn) === 4) {
				// The 5th connection only opens once dispose() frees the queued waiter: answer it immediately.
				request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
				request.callback();
				return;
			}
			request.emit('columnMetadata', [col('n', 'IntN', { dataLength: 4 })]);
			pending.push({ request });
			// callback deliberately withheld — these 4 connections stay busy until drained below
		};
		const provider = makeProvider();

		const results = Array.from({ length: 5 }, () => provider.query('select 1', -1));
		await waitFor(() => pending.length === 4);
		expect(Connection.instances).toHaveLength(4);

		provider.dispose();

		const settled = await Promise.race([
			results[4].then(() => 'settled', () => 'settled'),
			new Promise(resolve => setTimeout(() => resolve('timeout'), 200)),
		]);
		expect(settled).toBe('settled');

		for (const p of pending.splice(0)) p.request.callback();
		await Promise.allSettled(results);
	});
});
