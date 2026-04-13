import type { BridgeRunner } from '../dbt/bridge-runner';
import type { DocumentModel, SqlglotWarning, TokenInfo } from './parse-service';
import type { DocumentParser, ParseOptions } from './document-parser';

export class BridgeDocumentParser implements DocumentParser {
	constructor(private readonly _bridge: BridgeRunner) {}

	async parse(sql: string, dialect: string, options?: ParseOptions): Promise<DocumentModel> {
		const request: Record<string, unknown> = {
			parse_document: true,
			sql,
			dialect: dialect || 'ansi',
		};

		if (options?.schema && Object.keys(options.schema).length > 0) {
			request['schema'] = options.schema;
		}
		if (options?.schemaMapping && Object.keys(options.schemaMapping).length > 0) {
			request['schema_mapping'] = options.schemaMapping;
		}

		const result = await this._bridge.invokeRaw(request);
		if (!result.success || !result.data) {
			const errMsg = (result.data as Record<string, unknown>)?.['error'] ?? 'no response';
			throw new Error(String(errMsg));
		}
		return buildModel(result.data);
	}
}

function buildModel(raw: unknown): DocumentModel {
	const d = raw as unknown as (DocumentModel & { success: boolean; sqlglotWarnings?: SqlglotWarning[]; aliases?: Record<string, string[]> });
	return {
		ctes: d.ctes ?? [],
		refs: d.refs ?? [],
		sources: d.sources ?? [],
		finalColumns: d.finalColumns ?? [],
		finalSelect: d.finalSelect ?? undefined,
		tokens: (d as unknown as Record<string, unknown>).tokens as TokenInfo[] ?? [],
		timing: d.timing ?? { parseMs: 0, totalMs: 0 },
		sqlglotWarnings: d.sqlglotWarnings ?? [],
		aliases: d.aliases ?? {},
	};
}
