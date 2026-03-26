// dbt manifest.json v10+ type definitions

export type ResourceType =
	| 'model'
	| 'seed'
	| 'snapshot'
	| 'test'
	| 'analysis'
	| 'source'
	| 'exposure'
	| 'metric'
	| 'semantic_model'
	| 'saved_query'
	| 'unit_test';

export interface DbtColumnInfo {
	name: string;
	description?: string;
	data_type?: string;
	meta?: Record<string, unknown>;
	tags?: string[];
	constraints?: DbtColumnConstraint[];
}

export interface DbtColumnConstraint {
	type: string;
	expression?: string;
	name?: string;
}

export interface DbtNodeConfig {
	materialized?: string;
	schema?: string;
	database?: string;
	alias?: string;
	tags?: string[];
	meta?: Record<string, unknown>;
	enabled?: boolean;
	full_refresh?: boolean;
	unique_key?: string | string[];
	on_schema_change?: string;
	grants?: Record<string, string[]>;
	contract?: { enforced: boolean };
	[key: string]: unknown;
}

export interface DbtDependsOn {
	macros: string[];
	nodes: string[];
}

export interface DbtNode {
	unique_id: string;
	name: string;
	resource_type: ResourceType;
	package_name: string;
	path: string;
	original_file_path: string;
	fqn: string[];
	description?: string;
	columns: Record<string, DbtColumnInfo>;
	config?: DbtNodeConfig;
	tags: string[];
	meta: Record<string, unknown>;
	depends_on: DbtDependsOn;
	refs: DbtRef[];
	sources: [string, string][];
	compiled?: boolean;
	compiled_code?: string;
	raw_code?: string;
	schema?: string;
	database?: string;
	alias?: string;
	checksum?: { name: string; checksum: string };
	// For tests
	test_metadata?: {
		name: string;
		kwargs: Record<string, unknown>;
		namespace?: string;
	};
	// For seeds
	root_path?: string;
}

export interface DbtRef {
	name: string;
	package?: string;
	version?: number | string;
}

export interface DbtSource {
	unique_id: string;
	name: string;
	source_name: string;
	resource_type: 'source';
	package_name: string;
	path: string;
	original_file_path: string;
	fqn: string[];
	description?: string;
	columns: Record<string, DbtColumnInfo>;
	tags: string[];
	meta: Record<string, unknown>;
	schema: string;
	database?: string;
	identifier: string;
	loaded_at_field?: string;
	freshness?: DbtFreshness;
	source_description?: string;
}

export interface DbtFreshness {
	warn_after?: { count: number; period: string };
	error_after?: { count: number; period: string };
	filter?: string;
}

export interface DbtExposure {
	unique_id: string;
	name: string;
	resource_type: 'exposure';
	package_name: string;
	path: string;
	original_file_path: string;
	fqn: string[];
	description?: string;
	type?: string;
	owner?: { name?: string; email?: string };
	tags: string[];
	meta: Record<string, unknown>;
	depends_on: DbtDependsOn;
	refs: DbtRef[];
	sources: [string, string][];
}

export interface DbtMetric {
	unique_id: string;
	name: string;
	resource_type: 'metric';
	package_name: string;
	path: string;
	description?: string;
	tags: string[];
	meta: Record<string, unknown>;
	depends_on: DbtDependsOn;
}

export interface DbtMacro {
	unique_id: string;
	name: string;
	package_name: string;
	path: string;
	original_file_path: string;
	description?: string;
	macro_sql: string;
	arguments?: DbtMacroArgument[];
	depends_on: { macros: string[] };
}

export interface DbtMacroArgument {
	name: string;
	type?: string;
	description?: string;
}

export interface DbtManifestMetadata {
	dbt_schema_version: string;
	dbt_version: string;
	generated_at: string;
	invocation_id: string;
	env: Record<string, string>;
	adapter_type?: string;
	project_name?: string;
}

export interface DbtProjectConfig {
	name: string;
	version?: string;
	'config-version'?: number;
	profile?: string;
	'model-paths'?: string[];
	'seed-paths'?: string[];
	'test-paths'?: string[];
	'analysis-paths'?: string[];
	'macro-paths'?: string[];
	'snapshot-paths'?: string[];
	'docs-paths'?: string[];
	'target-path'?: string;
	'log-path'?: string;
	'packages-install-path'?: string;
	quoting?: Record<string, boolean>;
	models?: Record<string, unknown>;
	seeds?: Record<string, unknown>;
	snapshots?: Record<string, unknown>;
}

export interface DbtUnitTest {
	unique_id: string;
	name: string;
	resource_type: 'unit_test';
	package_name: string;
	model: string;
	path: string;
	original_file_path: string;
	fqn: string[];
	description?: string;
	tags: string[];
	config?: DbtNodeConfig;
	depends_on: DbtDependsOn;
	schema?: string;
	given?: unknown[];
	expect?: unknown;
	overrides?: unknown;
}

export interface DbtManifest {
	metadata: DbtManifestMetadata;
	nodes: Record<string, DbtNode>;
	sources: Record<string, DbtSource>;
	exposures: Record<string, DbtExposure>;
	metrics: Record<string, DbtMetric>;
	macros: Record<string, DbtMacro>;
	docs: Record<string, unknown>;
	semantic_models?: Record<string, unknown>;
	saved_queries?: Record<string, unknown>;
	unit_tests?: Record<string, DbtUnitTest>;
	parent_map: Record<string, string[]>;
	child_map: Record<string, string[]>;
	group_map?: Record<string, string[]>;
	disabled?: Record<string, DbtNode>;
}
