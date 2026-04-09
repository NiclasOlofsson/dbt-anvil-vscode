/* eslint-disable @typescript-eslint/no-explicit-any */
import { MetricLogger } from './logger';
import { SessionStore } from './session-store';
import { OperationStore } from './operation-store';
import {
	CatalogDefinition,
	OperationState,
	OperationType,
	ResultColumn,
	StatusCode,
	TStatus,
	TypeId,
} from './types';
import {
	filterCatalogs,
	filterColumns,
	filterSchemas,
	filterTables,
	filterTableTypes,
} from './mock-catalog';
import { createOpenSessionResponse } from './thrift-extensions';

// Thrift handler callback signature: (err, response) => void
type Callback = (err: Error | null, result?: unknown) => void;

const DATABRICKS_SERVER_PROTOCOL_VERSION = 42242; // value real Databricks sends in OpenSession response

function okStatus(): TStatus {
	return { statusCode: StatusCode.SUCCESS };
}

function errorStatus(message: string): TStatus {
	return { statusCode: StatusCode.ERROR, errorMessage: message } as TStatus & { errorMessage: string };
}

function buildTableSchema(columns: ResultColumn[]): object {
	return {
		columns: columns.map((col, i) => ({
			columnName: col.name,
			typeDesc: {
				types: [{
					primitiveEntry: { type: sqlTypeNameToTypeId(col.type) },
				}],
			},
			position: i + 1,
			comment: col.comment ?? null,
		})),
	};
}

function sqlTypeNameToTypeId(typeName: string): number {
	const upper = typeName.toUpperCase();
	if (upper === 'INT' || upper === 'INTEGER') return TypeId.INT;
	if (upper === 'STRING') return TypeId.STRING;
	if (upper === 'BIGINT') return TypeId.BIGINT;
	if (upper === 'DOUBLE') return TypeId.DOUBLE;
	if (upper === 'BOOLEAN') return TypeId.BOOLEAN;
	if (upper === 'DATE') return TypeId.DATE;
	if (upper === 'SMALLINT') return TypeId.SMALLINT;
	if (upper === 'TINYINT') return TypeId.TINYINT;
	return TypeId.STRING;
}

function buildRowSet(columns: ResultColumn[], fetched: boolean): object {
	if (fetched) {
		return {
			startRowOffset: { buffer: Buffer.alloc(8) },
			rows: [],
			columns: [],
		};
	}
	return {
		startRowOffset: { buffer: Buffer.alloc(8) },
		rows: [],
		columns: columns.map(col => {
			const type = col.type.toUpperCase();
			const nulls = Buffer.alloc(Math.max(1, Math.ceil(col.values.length / 8)));
			for (let i = 0; i < col.values.length; i++) {
				if (col.values[i] === null || col.values[i] === undefined) {
					nulls[i >> 3] |= 1 << (i % 8);
				}
			}
			if (type === 'INT' || type === 'INTEGER') {
				return { i32Val: { values: col.values.map(v => Number(v ?? 0)), nulls } };
			}
			if (type === 'TINYINT') {
				return { byteVal: { values: col.values.map(v => Number(v ?? 0)), nulls } };
			}
			if (type === 'SMALLINT') {
				return { i16Val: { values: col.values.map(v => Number(v ?? 0)), nulls } };
			}
			if (type === 'BIGINT') {
				return { i64Val: { values: col.values.map(v => BigInt(Number(v ?? 0))), nulls } };
			}
			if (type === 'DOUBLE' || type === 'FLOAT') {
				return { doubleVal: { values: col.values.map(v => Number(v ?? 0)), nulls } };
			}
			if (type === 'BOOLEAN') {
				return { boolVal: { values: col.values.map(v => Boolean(v)), nulls } };
			}
			// STRING, DATE, TIMESTAMP, and anything else serialized as string
			return { stringVal: { values: col.values.map(v => String(v ?? '')), nulls } };
		}),
	};
}

export class MetricServerHandler {
	private sessions: SessionStore;
	private operations: OperationStore;
	private catalogs: CatalogDefinition[];
	private logger: MetricLogger;

	constructor(catalogs: CatalogDefinition[], logger?: MetricLogger) {
		this.sessions = new SessionStore();
		this.operations = new OperationStore();
		this.catalogs = catalogs;
		this.logger = logger ?? new MetricLogger();
	}

	OpenSession(req: any, callback: Callback): void {
		const config: Record<string, string> = {};
		if (req.configuration) {
			for (const [k, v] of Object.entries(req.configuration)) {
				config[String(k)] = String(v);
			}
		}
		const session = this.sessions.create(config);
		const response = createOpenSessionResponse({
			status: okStatus(),
			serverProtocolVersion: DATABRICKS_SERVER_PROTOCOL_VERSION,
			sessionHandle: session.sessionHandle,
			configuration: null,
		});
		callback(null, response);
	}

	CloseSession(req: any, callback: Callback): void {
		if (!req.sessionHandle) {
			callback(null, { status: errorStatus('Missing session handle') });
			return;
		}
		this.operations.removeForSession(req.sessionHandle);
		this.sessions.remove(req.sessionHandle);
		this.logger.debug('CloseSession');
		callback(null, { status: okStatus() });
	}

	GetInfo(req: any, callback: Callback): void {
		// infoType values: 0=CLI_MAX_DRIVER_CONNECTIONS, 2=CLI_SERVER_NAME, etc.
		const infoType = req.infoType ?? 0;
		let infoValue: any = { stringValue: 'Spark SQL' };
		if (infoType === 17) infoValue = { stringValue: 'Spark SQL' };
		else if (infoType === 18) infoValue = { stringValue: '3.1.1' };
		this.logger.debug(`GetInfo: type=${infoType}`);
		callback(null, { status: okStatus(), infoValue });
	}

	GetTypeInfo(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		// Power BI's Databricks ADBC driver does not handle DECIMAL correctly in this mocked path.
		// Advertise DOUBLE instead so type parsing succeeds during refresh and navigator discovery.
		const types    = ['VOID', 'BOOLEAN', 'STRING', 'BINARY', 'TINYINT', 'SMALLINT', 'INT', 'BIGINT', 'FLOAT', 'DOUBLE', 'DATE', 'TIMESTAMP', 'VARCHAR', 'CHAR'];
		const dataTypes = [0, 16, 12, -2, -6, 5, 4, -5, 6, 8, 91, 93, 12, 1];
		const precision = [0, 0, 0, 0, 3, 5, 10, 19, 7, 15, 0, 0, 0, 0];
		const nullable  = types.map(() => 1);
		const caseSens  = types.map((t) => t === 'STRING' || t === 'VARCHAR' || t === 'CHAR');
		const searchable = types.map(() => 3);
		const unsignedAttr = types.map((t) => !['TINYINT','SMALLINT','INT','BIGINT','FLOAT','DOUBLE'].includes(t));
		const zeros     = types.map(() => 0);
		const falses    = types.map(() => false);
		const empty     = types.map(() => '');
		const columns: ResultColumn[] = [
			{ name: 'TYPE_NAME',             type: 'STRING',   values: types },
			{ name: 'DATA_TYPE',             type: 'INT',      values: dataTypes },
			{ name: 'PRECISION',             type: 'INT',      values: precision },
			{ name: 'LITERAL_PREFIX',        type: 'STRING',   values: empty },
			{ name: 'LITERAL_SUFFIX',        type: 'STRING',   values: empty },
			{ name: 'CREATE_PARAMS',         type: 'STRING',   values: empty },
			{ name: 'NULLABLE',              type: 'SMALLINT', values: nullable },
			{ name: 'CASE_SENSITIVE',        type: 'BOOLEAN',  values: caseSens },
			{ name: 'SEARCHABLE',            type: 'SMALLINT', values: searchable },
			{ name: 'UNSIGNED_ATTRIBUTE',    type: 'BOOLEAN',  values: unsignedAttr },
			{ name: 'FIXED_PREC_SCALE',      type: 'BOOLEAN',  values: falses },
			{ name: 'AUTO_INCREMENT',        type: 'BOOLEAN',  values: falses },
			{ name: 'LOCAL_TYPE_NAME',       type: 'STRING',   values: empty },
			{ name: 'MINIMUM_SCALE',         type: 'SMALLINT', values: zeros },
			{ name: 'MAXIMUM_SCALE',         type: 'SMALLINT', values: zeros },
			{ name: 'SQL_DATA_TYPE',         type: 'INT',      values: zeros },
			{ name: 'SQL_DATETIME_SUB',      type: 'INT',      values: zeros },
			{ name: 'NUM_PREC_RADIX',        type: 'INT',      values: types.map((t) => ['TINYINT','SMALLINT','INT','BIGINT','FLOAT','DOUBLE'].includes(t) ? 10 : 0) },
		];
		const handle = this.operations.create(session.sessionHandle, OperationType.GET_TYPE_INFO, columns);
		callback(null, { status: okStatus(), operationHandle: handle });
	}

	GetCatalogs(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		const columns = filterCatalogs(this.catalogs);
		const handle = this.operations.create(session.sessionHandle, OperationType.GET_CATALOGS, columns);
		this.logger.debug(`GetCatalogs: ${columns[0].values.length} results`);
		callback(null, { status: okStatus(), operationHandle: handle });
	}

	GetSchemas(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		const columns = filterSchemas(this.catalogs, req.catalogName, req.schemaName);
		const handle = this.operations.create(session.sessionHandle, OperationType.GET_SCHEMAS, columns);
		this.logger.debug(`GetSchemas: catalog=${req.catalogName ?? '*'}, schema=${req.schemaName ?? '*'}, ${columns[0].values.length} results`);
		callback(null, { status: okStatus(), operationHandle: handle });
	}

	GetTables(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		this.logger.debug(`GetTables REQUEST: catalog=${JSON.stringify(req.catalogName)}, schema=${JSON.stringify(req.schemaName)}, table=${JSON.stringify(req.tableName)}, tableTypes=${JSON.stringify(req.tableTypes)}`);
		const columns = filterTables(
			this.catalogs,
			session.metricViewEnabled,
			req.catalogName,
			req.schemaName,
			req.tableName,
			req.tableTypes,
		);
		const handle = this.operations.create(session.sessionHandle, OperationType.GET_TABLES, columns);
		this.logger.debug(`GetTables: catalog=${req.catalogName ?? '*'}, schema=${req.schemaName ?? '*'}, table=${req.tableName ?? '*'}, metricView=${session.metricViewEnabled}, ${columns[0].values.length} results`);
		callback(null, { status: okStatus(), operationHandle: handle });
	}

	GetTableTypes(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		const columns = filterTableTypes(session.metricViewEnabled);
		const handle = this.operations.create(session.sessionHandle, OperationType.GET_TABLE_TYPES, columns);
		this.logger.debug(`GetTableTypes: metricView=${session.metricViewEnabled}, types=[${columns[0].values.join(', ')}]`);
		callback(null, { status: okStatus(), operationHandle: handle });
	}

	GetColumns(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		const columns = filterColumns(
			this.catalogs,
			session.metricViewEnabled,
			req.catalogName,
			req.schemaName,
			req.tableName,
			req.columnName,
		);
		const handle = this.operations.create(session.sessionHandle, OperationType.GET_COLUMNS, columns);
		this.logger.debug(`GetColumns: table=${req.tableName ?? '*'}, ${columns[0].values.length} results`);
		callback(null, { status: okStatus(), operationHandle: handle });
	}

	GetFunctions(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		// Empty result — no functions in mock
		const columns: ResultColumn[] = [
			{ name: 'FUNCTION_CAT', type: 'STRING', values: [] },
			{ name: 'FUNCTION_SCHEM', type: 'STRING', values: [] },
			{ name: 'FUNCTION_NAME', type: 'STRING', values: [] },
			{ name: 'FUNCTION_TYPE', type: 'INT', values: [] },
		];
		const handle = this.operations.create(session.sessionHandle, OperationType.GET_FUNCTIONS, columns);
		callback(null, { status: okStatus(), operationHandle: handle });
	}

	GetPrimaryKeys(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		const columns: ResultColumn[] = [
			{ name: 'TABLE_CAT', type: 'STRING', values: [] },
			{ name: 'TABLE_SCHEM', type: 'STRING', values: [] },
			{ name: 'TABLE_NAME', type: 'STRING', values: [] },
			{ name: 'COLUMN_NAME', type: 'STRING', values: [] },
			{ name: 'KEY_SEQ', type: 'INT', values: [] },
			{ name: 'PK_NAME', type: 'STRING', values: [] },
		];
		const handle = this.operations.create(session.sessionHandle, OperationType.GET_PRIMARY_KEYS, columns);
		callback(null, { status: okStatus(), operationHandle: handle });
	}

	GetCrossReference(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		const columns: ResultColumn[] = [
			{ name: 'PKTABLE_CAT', type: 'STRING', values: [] },
			{ name: 'PKTABLE_SCHEM', type: 'STRING', values: [] },
			{ name: 'PKTABLE_NAME', type: 'STRING', values: [] },
			{ name: 'PKCOLUMN_NAME', type: 'STRING', values: [] },
			{ name: 'FKTABLE_CAT', type: 'STRING', values: [] },
			{ name: 'FKTABLE_SCHEM', type: 'STRING', values: [] },
			{ name: 'FKTABLE_NAME', type: 'STRING', values: [] },
			{ name: 'FKCOLUMN_NAME', type: 'STRING', values: [] },
			{ name: 'KEY_SEQ', type: 'INT', values: [] },
		];
		const handle = this.operations.create(session.sessionHandle, OperationType.GET_CROSS_REFERENCE, columns);
		callback(null, { status: okStatus(), operationHandle: handle });
	}

	ExecuteStatement(req: any, callback: Callback): void {
		const session = this.sessions.get(req.sessionHandle);
		if (!session) {
			callback(null, { status: errorStatus('Invalid session') });
			return;
		}
		const sql = (req.statement ?? '').trim();
		this.logger.debug(`ExecuteStatement: ${sql.substring(0, 100)}`);

		// Handle USE <schema> — no-op, acknowledge with empty result
		if (/^USE\s+\S+$/i.test(sql)) {
			const columns: ResultColumn[] = [{ name: 'result', type: 'STRING', values: ['OK'] }];
			const handle = this.operations.create(session.sessionHandle, OperationType.EXECUTE_STATEMENT, columns);
			callback(null, { status: okStatus(), operationHandle: handle });
			return;
		}

		// Handle SET key=value (SSP mechanism)
		const setMatch = sql.match(/^SET\s+(\S+)\s*=\s*(.+)$/i);
		if (setMatch) {
			const [, key, value] = setMatch;
			session.configuration[key] = value;
			if (key === 'spark.sql.thriftserver.metadata.metricview.enabled'
				|| key === 'spark.databricks.metadata.metricview.enabled') {
				session.metricViewEnabled = value.toLowerCase() === 'true';
				this.logger.debug(`  -> metricViewEnabled=${session.metricViewEnabled}`);
			}
			const columns: ResultColumn[] = [
				{ name: 'key', type: 'STRING', values: [key] },
				{ name: 'value', type: 'STRING', values: [value] },
			];
			const handle = this.operations.create(session.sessionHandle, OperationType.EXECUTE_STATEMENT, columns);
			callback(null, { status: okStatus(), operationHandle: handle });
			return;
		}

		const preview = sql.length > 120 ? `${sql.slice(0, 120)}...` : sql;
		this.logger.warn(`ExecuteStatement passthrough disabled: ${preview}`);
		callback(null, {
			status: errorStatus('ExecuteStatement SQL passthrough is disabled in metricserver'),
		});
	}

	GetOperationStatus(req: any, callback: Callback): void {
		const op = this.operations.get(req.operationHandle);
		if (!op) {
			callback(null, {
				status: okStatus(),
				operationState: OperationState.CLOSED,
				hasResultSet: false,
			});
			return;
		}
		callback(null, {
			status: okStatus(),
			operationState: OperationState.FINISHED,
			hasResultSet: true,
		});
	}

	GetResultSetMetadata(req: any, callback: Callback): void {
		const op = this.operations.get(req.operationHandle);
		if (!op) {
			callback(null, { status: errorStatus('Invalid operation handle') });
			return;
		}
		callback(null, {
			status: okStatus(),
			schema: buildTableSchema(op.columns),
		});
	}

	FetchResults(req: any, callback: Callback): void {
		const op = this.operations.get(req.operationHandle);
		if (!op) {
			callback(null, {
				status: okStatus(),
				hasMoreRows: false,
				results: buildRowSet([], true),
			});
			return;
		}
		const results = buildRowSet(op.columns, op.fetched);
		if (!op.fetched) {
			this.operations.markFetched(req.operationHandle);
		}
		callback(null, {
			status: okStatus(),
			hasMoreRows: false,
			results,
		});
	}

	CancelOperation(_req: any, callback: Callback): void {
		this.logger.debug('CancelOperation');
		callback(null, { status: okStatus() });
	}

	CloseOperation(req: any, callback: Callback): void {
		this.operations.remove(req.operationHandle);
		callback(null, { status: okStatus() });
	}

	GetDelegationToken(_req: any, callback: Callback): void {
		callback(null, { status: errorStatus('Not supported') });
	}

	CancelDelegationToken(_req: any, callback: Callback): void {
		callback(null, { status: errorStatus('Not supported') });
	}

	RenewDelegationToken(_req: any, callback: Callback): void {
		callback(null, { status: errorStatus('Not supported') });
	}

	GetQueryId(_req: any, callback: Callback): void {
		callback(null, { queryId: 'mock-query-id' });
	}

	SetClientInfo(_req: any, callback: Callback): void {
		callback(null, { status: okStatus() });
	}

	UploadData(_req: any, callback: Callback): void {
		callback(null, { status: errorStatus('Not supported') });
	}

	DownloadData(_req: any, callback: Callback): void {
		callback(null, { status: errorStatus('Not supported') });
	}
}
