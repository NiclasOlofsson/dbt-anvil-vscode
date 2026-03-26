import type * as vscode from 'vscode';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { ILogger } from '../types/logger';

export interface ColumnInfo {
	name: string;
	/** 0-based line of the column expression in the document */
	line: number;
}

export interface CteInfo {
	name: string;
	/** 0-based line of the CTE name token in the document */
	line: number;
	/** 0-based line of the closing paren of the CTE body */
	endLine: number;
	columns: ColumnInfo[];
}

export interface RefInfo {
	model: string;
	/** 0-based line */
	line: number;
}

export interface SourceInfo {
	sourceName: string;
	tableName: string;
	/** 0-based line */
	line: number;
}

export interface DocumentModel {
	ctes: CteInfo[];
	refs: RefInfo[];
	sources: SourceInfo[];
	finalColumns: string[];
	timing: { parseMs: number; totalMs: number };
}

interface CacheEntry {
	version: number;
	model: DocumentModel;
}

/**
 * Caches DocumentModel per document URI + version.
 * Call `getDocumentModel` from providers — returns a cached result if the
 * document hasn't changed since the last parse, otherwise invokes the bridge.
 *
 * Concurrent calls for the same (URI, version) share a single in-flight
 * promise — VS Code can fire provideDocumentSymbols several times at once
 * (outline, breadcrumbs, …) and without this deduplication each concurrent
 * call would issue its own bridge request before the first one populates
 * the cache.
 */
export class ParseService {
	private readonly _cache = new Map<string, CacheEntry>();
	private readonly _inflight = new Map<string, Promise<DocumentModel | null>>();

	constructor(
		private readonly _bridge: BridgeRunner,
		private readonly _logger: ILogger,
	) {}

	/**
	 * Return the DocumentModel for the given document.
	 * Re-parses via the bridge only when the version has changed.
	 */
	async getDocumentModel(
		document: vscode.TextDocument,
		dialect: string,
	): Promise<DocumentModel | null> {
		const key = document.uri.toString();
		const cached = this._cache.get(key);
		if (cached && cached.version === document.version) {
			return cached.model;
		}

		// Deduplicate concurrent requests for the same version.
		const inflightKey = `${key}@${document.version}`;
		const existing = this._inflight.get(inflightKey);
		if (existing) {
			return existing;
		}

		const promise = this._parse(document, key, dialect);
		this._inflight.set(inflightKey, promise);
		try {
			return await promise;
		} finally {
			this._inflight.delete(inflightKey);
		}
	}

	private async _parse(
		document: vscode.TextDocument,
		key: string,
		dialect: string,
	): Promise<DocumentModel | null> {
		const result = await this._bridge.invokeRaw({
			parse_document: true,
			sql: document.getText(),
			dialect: dialect || 'ansi',
		});

		if (!result.success || !result.data) {
			const errMsg = (result.data as Record<string, unknown>)?.['error'] ?? 'no response';
			this._logger.debug(`[parse-service] parse_document failed for ${document.fileName}: ${String(errMsg)}`);
			return null;
		}

		const data = result.data as unknown as (DocumentModel & { success: boolean });
		const model: DocumentModel = {
			ctes: data.ctes ?? [],
			refs: data.refs ?? [],
			sources: data.sources ?? [],
			finalColumns: data.finalColumns ?? [],
			timing: data.timing ?? { parseMs: 0, totalMs: 0 },
		};

		this._cache.set(key, { version: document.version, model });
		this._logger.debug(
			`[parse-service] parsed ${document.fileName} — ${model.ctes.length} CTEs, `
			+ `${model.refs.length} refs in ${model.timing.totalMs}ms (sqlglot: ${model.timing.parseMs}ms)`,
		);

		return model;
	}

	/** Remove cached entry when a document is closed. */
	evict(uri: vscode.Uri): void {
		this._cache.delete(uri.toString());
	}
}
