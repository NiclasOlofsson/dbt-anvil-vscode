export interface CatalogColumn {
	name: string
	sqlType: string
	isMeasure?: boolean
}

export interface CatalogTable {
	name: string
	type: 'TABLE' | 'VIEW' | 'METRIC_VIEW'
	columns: CatalogColumn[]
}

export interface CatalogSchema {
	name: string
	tables: CatalogTable[]
}

export interface CatalogDefinition {
	name: string
	schemas: CatalogSchema[]
}

export interface SessionState {
	sessionHandle: SessionHandle
	configuration: Record<string, string>
	metricViewEnabled: boolean
	bearerToken?: string
}

export interface HandleIdentifier {
	guid: Buffer
	secret: Buffer
}

export interface SessionHandle {
	sessionId: HandleIdentifier
}

export interface OperationHandle {
	operationId: HandleIdentifier
	operationType: number
	hasResultSet: boolean
	modifiedRowCount?: number
}

export interface ResultColumn {
	name: string
	type: string
	values: unknown[]
	comment?: string
}

export interface OperationResult {
	sessionHandle: SessionHandle
	columns: ResultColumn[]
	fetched: boolean
}

export interface TStatus {
	statusCode: number
}

export const StatusCode = {
	SUCCESS: 0,
	SUCCESS_WITH_INFO: 1,
	STILL_EXECUTING: 2,
	ERROR: 3,
	INVALID_HANDLE: 4,
} as const;

export const OperationType = {
	EXECUTE_STATEMENT: 0,
	GET_TYPE_INFO: 1,
	GET_CATALOGS: 2,
	GET_SCHEMAS: 3,
	GET_TABLES: 4,
	GET_TABLE_TYPES: 5,
	GET_COLUMNS: 6,
	GET_FUNCTIONS: 7,
	GET_PRIMARY_KEYS: 8,
	GET_CROSS_REFERENCE: 9,
} as const;

export const OperationState = {
	INITIALIZED: 0,
	RUNNING: 1,
	FINISHED: 2,
	CANCELED: 3,
	CLOSED: 4,
	ERROR: 5,
	UNKNOWN: 6,
	PENDING: 7,
	TIMEDOUT: 8,
} as const;

export const TypeId = {
	BOOLEAN: 0,
	TINYINT: 1,
	SMALLINT: 2,
	INT: 3,
	BIGINT: 4,
	FLOAT: 5,
	DOUBLE: 6,
	STRING: 7,
	TIMESTAMP: 8,
	BINARY: 9,
	ARRAY: 10,
	MAP: 11,
	STRUCT: 12,
	UNION: 13,
	USER_DEFINED: 14,
	DECIMAL: 15,
	NULL: 16,
	DATE: 17,
	VARCHAR: 18,
	CHAR: 19,
	INTERVAL_YEAR_MONTH: 20,
	INTERVAL_DAY_TIME: 21,
	TIMESTAMP_LOCAL_TZ: 22,
} as const;

// JDBC type codes (java.sql.Types) — used in GetColumns DATA_TYPE column.
// These are distinct from Hive TTypeId values used in Thrift column descriptors.
export const JdbcTypeId = {
	NULL: 0,
	CHAR: 1,
	DECIMAL: 3,
	INT: 4,
	SMALLINT: 5,
	FLOAT: 6,
	DOUBLE: 8,
	VARCHAR: 12,
	BOOLEAN: 16,
	BINARY: -2,
	TINYINT: -6,
	BIGINT: -5,
	DATE: 91,
	TIMESTAMP: 93,
	ARRAY: 2003,
	STRUCT: 2002,
	OTHER: 1111,
} as const;
