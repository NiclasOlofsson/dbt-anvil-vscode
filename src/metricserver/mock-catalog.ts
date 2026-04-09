import {
	CatalogColumn,
	CatalogDefinition,
	CatalogSchema,
	CatalogTable,
	ResultColumn,
	JdbcTypeId,
} from './types';

function matchesPattern(value: string, pattern?: string): boolean {
	if (!pattern) return true;
	// SQL LIKE pattern: % = any, _ = single char
	const regex = new RegExp(
		'^' + pattern.replace(/%/g, '.*').replace(/_/g, '.') + '$',
		'i',
	);
	return regex.test(value);
}

function sqlTypeToTypeId(sqlType: string): number {
	const upper = normalizeDriverCompatibleSqlType(sqlType);
	// Order matters: check longer prefixes (BIGINT, SMALLINT, TINYINT) before INT.
	if (upper.startsWith('BIGINT')) return JdbcTypeId.BIGINT;
	if (upper.startsWith('SMALLINT')) return JdbcTypeId.SMALLINT;
	if (upper.startsWith('TINYINT')) return JdbcTypeId.TINYINT;
	if (upper.startsWith('INT')) return JdbcTypeId.INT;
	if (upper.startsWith('FLOAT')) return JdbcTypeId.FLOAT;
	if (upper.startsWith('DOUBLE')) return JdbcTypeId.DOUBLE;
	if (upper.startsWith('BOOL')) return JdbcTypeId.BOOLEAN;
	if (upper === 'DATE') return JdbcTypeId.DATE;
	if (upper.startsWith('TIMESTAMP')) return JdbcTypeId.TIMESTAMP;
	if (upper.startsWith('VARCHAR') || upper === 'STRING' || upper === 'TEXT') return JdbcTypeId.VARCHAR;
	if (upper.startsWith('CHAR')) return JdbcTypeId.CHAR;
	if (upper.startsWith('BINARY') || upper === 'BLOB') return JdbcTypeId.BINARY;
	if (upper.startsWith('ARRAY')) return JdbcTypeId.ARRAY;
	if (upper.startsWith('STRUCT')) return JdbcTypeId.STRUCT;
	if (upper.startsWith('MAP')) return JdbcTypeId.OTHER;
	return JdbcTypeId.VARCHAR;
}

export function filterCatalogs(
	catalogs: CatalogDefinition[],
	catalogName?: string,
): ResultColumn[] {
	const names: string[] = [];
	for (const cat of catalogs) {
		if (matchesPattern(cat.name, catalogName)) {
			names.push(cat.name);
		}
	}
	return [{ name: 'TABLE_CAT', type: 'STRING', values: names, comment: 'Catalog name. NULL if not applicable.' }];
}

export function filterSchemas(
	catalogs: CatalogDefinition[],
	catalogName?: string,
	schemaName?: string,
): ResultColumn[] {
	const catNames: string[] = [];
	const schemaNames: string[] = [];
	for (const cat of catalogs) {
		if (!matchesPattern(cat.name, catalogName)) continue;
		for (const schema of cat.schemas) {
			if (!matchesPattern(schema.name, schemaName)) continue;
			catNames.push(cat.name);
			schemaNames.push(schema.name);
		}
	}
	return [
		{ name: 'TABLE_SCHEM', type: 'STRING', values: schemaNames, comment: 'Schema name.' },
		{ name: 'TABLE_CATALOG', type: 'STRING', values: catNames, comment: 'Catalog name.' },
	];
}

export function filterTables(
	catalogs: CatalogDefinition[],
	metricViewEnabled: boolean,
	catalogName?: string,
	schemaName?: string,
	tableName?: string,
	tableTypes?: string[],
): ResultColumn[] {
	const catNames: string[] = [];
	const schemaNames: string[] = [];
	const tableNames: string[] = [];
	const types: string[] = [];
	const remarks: string[] = [];

	for (const cat of catalogs) {
		if (!matchesPattern(cat.name, catalogName)) continue;
		for (const schema of cat.schemas) {
			if (!matchesPattern(schema.name, schemaName)) continue;
			for (const table of schema.tables) {
				if (!matchesPattern(table.name, tableName)) continue;
				if (table.type === 'METRIC_VIEW' && !metricViewEnabled) continue;
				if (tableTypes && tableTypes.length > 0 && !tableTypes.includes(table.type)) continue;
				catNames.push(cat.name);
				schemaNames.push(schema.name);
				tableNames.push(table.name);
				types.push(table.type);
				remarks.push('');
			}
		}
	}
	return [
		{ name: 'TABLE_CAT', type: 'STRING', values: catNames, comment: 'Catalog name. NULL if not applicable.' },
		{ name: 'TABLE_SCHEM', type: 'STRING', values: schemaNames, comment: 'Schema name.' },
		{ name: 'TABLE_NAME', type: 'STRING', values: tableNames, comment: 'Table name.' },
		{ name: 'TABLE_TYPE', type: 'STRING', values: types, comment: 'The table type, e.g. "TABLE", "VIEW", etc.' },
		{ name: 'REMARKS', type: 'STRING', values: remarks, comment: 'Comments about the table.' },
		{ name: 'TYPE_CAT', type: 'STRING', values: catNames.map(() => ''), comment: 'The types catalog.' },
		{ name: 'TYPE_SCHEM', type: 'STRING', values: catNames.map(() => ''), comment: 'The types schema.' },
		{ name: 'TYPE_NAME', type: 'STRING', values: catNames.map(() => ''), comment: 'Type name.' },
		{ name: 'SELF_REFERENCING_COL_NAME', type: 'STRING', values: catNames.map(() => ''), comment: 'Name of the designated "identifier" column of a typed table.' },
		{ name: 'REF_GENERATION', type: 'STRING', values: catNames.map(() => ''), comment: 'Specifies how values in SELF_REFERENCING_COL_NAME are created.' },
	];
}

export function filterTableTypes(metricViewEnabled: boolean): ResultColumn[] {
	const types = ['TABLE', 'VIEW'];
	if (metricViewEnabled) types.push('METRIC_VIEW');
	return [{ name: 'TABLE_TYPE', type: 'STRING', values: types }];
}

export function filterColumns(
	catalogs: CatalogDefinition[],
	metricViewEnabled: boolean,
	catalogName?: string,
	schemaName?: string,
	tableName?: string,
	columnName?: string,
): ResultColumn[] {
	const catNames: string[] = [];
	const schemaNames: string[] = [];
	const tableNames: string[] = [];
	const colNames: string[] = [];
	const dataTypes: number[] = [];
	const typeNames: string[] = [];
	const columnSizes: Array<number | null> = [];
	const bufferLengths: Array<number | null> = [];
	const decimalDigits: Array<number | null> = [];
	const numPrecRadix: Array<number | null> = [];
	const nullableCodes: Array<number | null> = [];
	const ordinals: number[] = [];
	const isNullables: Array<string | null> = [];
	const remarks: string[] = [];
	const columnDefaults: Array<string | null> = [];
	const sqlDataTypes: Array<number | null> = [];
	const sqlDatetimeSubs: Array<number | null> = [];
	const charOctetLengths: Array<number | null> = [];
	const scopeCatalogs: Array<string | null> = [];
	const scopeSchemas: Array<string | null> = [];
	const scopeTables: Array<string | null> = [];
	const sourceDataTypes: Array<number | null> = [];
	const isAutoIncrement: Array<string | null> = [];

	for (const cat of catalogs) {
		if (!matchesPattern(cat.name, catalogName)) continue;
		for (const schema of cat.schemas) {
			if (!matchesPattern(schema.name, schemaName)) continue;
			for (const table of schema.tables) {
				if (!matchesPattern(table.name, tableName)) continue;
				if (table.type === 'METRIC_VIEW' && !metricViewEnabled) continue;
				for (let i = 0; i < table.columns.length; i++) {
					const col = table.columns[i];
					if (!matchesPattern(col.name, columnName)) continue;
					catNames.push(cat.name);
					schemaNames.push(schema.name);
					tableNames.push(table.name);
					colNames.push(col.name);
					dataTypes.push(sqlTypeToTypeId(col.sqlType));
					typeNames.push(formatTypeName(col, metricViewEnabled, table.type));
					columnSizes.push(inferColumnSize(col.sqlType));
					bufferLengths.push(null);
					decimalDigits.push(inferDecimalDigits(col.sqlType));
					numPrecRadix.push(inferNumericRadix(col.sqlType));
					nullableCodes.push(1);
					ordinals.push(i + 1);
					isNullables.push('YES');
					remarks.push('');
					columnDefaults.push(null);
					sqlDataTypes.push(null);
					sqlDatetimeSubs.push(null);
					charOctetLengths.push(inferCharOctetLength(col.sqlType));
					scopeCatalogs.push(null);
					scopeSchemas.push(null);
					scopeTables.push(null);
					sourceDataTypes.push(null);
					isAutoIncrement.push('NO');
				}
			}
		}
	}
	return [
		{ name: 'TABLE_CAT', type: 'STRING', values: catNames, comment: 'Catalog name. NULL if not applicable' },
		{ name: 'TABLE_SCHEM', type: 'STRING', values: schemaNames, comment: 'Schema name' },
		{ name: 'TABLE_NAME', type: 'STRING', values: tableNames, comment: 'Table name' },
		{ name: 'COLUMN_NAME', type: 'STRING', values: colNames, comment: 'Column name' },
		{ name: 'DATA_TYPE', type: 'INT', values: dataTypes, comment: 'SQL type from java.sql.Types' },
		{ name: 'TYPE_NAME', type: 'STRING', values: typeNames, comment: 'Data source dependent type name, for a UDT the type name is fully qualified' },
		{ name: 'COLUMN_SIZE', type: 'INT', values: columnSizes, comment: 'Column size. For char or date types this is the maximum number of characters, for numeric or decimal types this is precision.' },
		{ name: 'BUFFER_LENGTH', type: 'TINYINT', values: bufferLengths, comment: 'Unused' },
		{ name: 'DECIMAL_DIGITS', type: 'INT', values: decimalDigits, comment: 'The number of fractional digits' },
		{ name: 'NUM_PREC_RADIX', type: 'INT', values: numPrecRadix, comment: 'Radix (typically either 10 or 2)' },
		{ name: 'NULLABLE', type: 'INT', values: nullableCodes, comment: 'Is NULL allowed' },
		{ name: 'REMARKS', type: 'STRING', values: remarks, comment: 'Comment describing column (may be null)' },
		{ name: 'COLUMN_DEF', type: 'STRING', values: columnDefaults, comment: 'Default value (may be null)' },
		{ name: 'SQL_DATA_TYPE', type: 'INT', values: sqlDataTypes, comment: 'Unused' },
		{ name: 'SQL_DATETIME_SUB', type: 'INT', values: sqlDatetimeSubs, comment: 'Unused' },
		{ name: 'CHAR_OCTET_LENGTH', type: 'INT', values: charOctetLengths, comment: 'For char types the maximum number of bytes in the column' },
		{ name: 'ORDINAL_POSITION', type: 'INT', values: ordinals, comment: 'Index of column in table (starting at 1)' },
		{ name: 'IS_NULLABLE', type: 'STRING', values: isNullables, comment: '"NO" means column definitely does not allow NULL values; "YES" means the column might allow NULL values. An empty string means nobody knows.' },
		{ name: 'SCOPE_CATALOG', type: 'STRING', values: scopeCatalogs, comment: 'Catalog of table that is the scope of a reference attribute (null if DATA_TYPE isn\'t REF)' },
		{ name: 'SCOPE_SCHEMA', type: 'STRING', values: scopeSchemas, comment: 'Schema of table that is the scope of a reference attribute (null if the DATA_TYPE isn\'t REF)' },
		{ name: 'SCOPE_TABLE', type: 'STRING', values: scopeTables, comment: 'Table name that this the scope of a reference attribute (null if the DATA_TYPE isn\'t REF)' },
		{ name: 'SOURCE_DATA_TYPE', type: 'SMALLINT', values: sourceDataTypes, comment: 'Source type of a distinct type or user-generated Ref type, SQL type from java.sql.Types (null if DATA_TYPE isn\'t DISTINCT or user-generated REF)' },
		{ name: 'IS_AUTO_INCREMENT', type: 'STRING', values: isAutoIncrement, comment: 'Indicates whether this column is auto incremented.' },
	];
}

function inferColumnSize(sqlType: string): number | null {
	const upper = normalizeDriverCompatibleSqlType(sqlType);
	if (upper === 'INT' || upper === 'INTEGER') return 10;
	if (upper === 'BIGINT') return 19;
	if (upper === 'SMALLINT') return 5;
	if (upper === 'TINYINT') return 3;
	if (upper === 'DOUBLE') return 15;
	if (upper === 'FLOAT') return 7;
	if (upper === 'BOOLEAN') return 1;
	if (upper === 'DATE') return 10;
	if (upper === 'TIMESTAMP') return 29;
	if (upper === 'STRING' || upper === 'TEXT') return 255;
	const varcharMatch = /VARCHAR\((\d+)\)/i.exec(upper);
	if (varcharMatch) return Number(varcharMatch[1]);
	return null;
}

function inferDecimalDigits(sqlType: string): number | null {
	const upper = normalizeDriverCompatibleSqlType(sqlType);
	if (upper === 'DOUBLE' || upper === 'FLOAT') return 15;
	return null;
}

function inferNumericRadix(sqlType: string): number | null {
	const upper = normalizeDriverCompatibleSqlType(sqlType);
	if (['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'DOUBLE', 'FLOAT'].includes(upper)) return 10;
	return null;
}

function inferCharOctetLength(sqlType: string): number | null {
	const upper = normalizeDriverCompatibleSqlType(sqlType);
	if (upper === 'STRING' || upper === 'TEXT') return 255;
	const varcharMatch = /VARCHAR\((\d+)\)/i.exec(upper);
	if (varcharMatch) return Number(varcharMatch[1]);
	const charMatch = /CHAR\((\d+)\)/i.exec(upper);
	if (charMatch) return Number(charMatch[1]);
	return null;
}

function formatTypeName(col: CatalogColumn, metricViewEnabled: boolean, tableType: string): string {
	const typeName = normalizeDriverCompatibleSqlType(col.sqlType);
	if (metricViewEnabled && tableType === 'METRIC_VIEW' && col.isMeasure) {
		return `${typeName} measure`;
	}
	return typeName;
}

function normalizeDriverCompatibleSqlType(sqlType: string): string {
	const upper = sqlType.toUpperCase();
	// Power BI's Databricks ADBC driver rejects DECIMAL metadata/results in this mocked path.
	// Use DOUBLE instead so metadata parsing succeeds consistently during navigator refresh.
	if (upper.startsWith('DECIMAL') || upper.startsWith('NUMERIC')) return 'DOUBLE';
	return upper;
}

export function createDefaultCatalog(): CatalogDefinition {
	return {
		name: 'hive_metastore',
		schemas: [createDefaultSchema()],
	};
}

/**
 * Returns a UC-style catalog array that mirrors what Power BI sees when connected
 * to a Unity Catalog enabled Databricks workspace in metricView compatibility mode:
 * - hive_metastore (legacy, no metric views)
 * - dbt_models (the dbt project catalog, with metric views in default schema)
 */
export function createUCCatalogs(): CatalogDefinition[] {
	return [
		createEmptyCatalog('dev'),
		{
			name: 'hive_metastore',
			schemas: [
				{
					name: 'default',
					tables: [createSampleTable()],
				},
			],
		},
		createEmptyCatalog('prod'),
		createEmptyCatalog('samples'),
		createEmptyCatalog('system'),
		{
			name: 'test',
			schemas: [
				{
					name: 'default',
					tables: [createSampleTable(), createSampleMetricView()],
				},
				{
					name: 'global_temp',
					tables: [],
				},
			],
		},
	];
}

function createEmptyCatalog(name: string): CatalogDefinition {
	return {
		name,
		schemas: [{ name: 'default', tables: [] }],
	};
}

function createDefaultSchema(): CatalogSchema {
	return {
		name: 'default',
		tables: [
			createSampleTable(),
			createSampleMetricView(),
		],
	};
}

function createSampleTable(): CatalogTable {
	return {
		name: 'orders',
		type: 'TABLE',
		columns: [
			{ name: 'order_id', sqlType: 'INT' },
			{ name: 'customer_id', sqlType: 'INT' },
			{ name: 'order_date', sqlType: 'DATE' },
			{ name: 'amount', sqlType: 'DOUBLE' },
			{ name: 'status', sqlType: 'STRING' },
		],
	};
}

function createSampleMetricView(): CatalogTable {
	return {
		name: 'test_metric_view',
		type: 'METRIC_VIEW',
		columns: [
			{ name: 'period', sqlType: 'DATE' },
			{ name: 'total_revenue', sqlType: 'DOUBLE', isMeasure: true },
			{ name: 'order_count', sqlType: 'INT', isMeasure: true },
			{ name: 'avg_order_value', sqlType: 'DOUBLE', isMeasure: true },
		],
	};
}
