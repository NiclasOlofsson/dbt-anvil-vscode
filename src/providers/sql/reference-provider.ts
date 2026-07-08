import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ILogger } from '../../types/logger';
import { ParseService } from '../../services/parse-service';
import type { DocumentModel } from '../../services/parse-service';
import type { Sym } from '../../ftl/sqllens/api';
import { isLinePositionInComment, computeCommentRanges, isOffsetInComment } from '../common/comment-utils';
import { SQL_KEYWORDS } from './sql-keywords';
import { isRelationSym, qualifierRangeOf, rangeOfSpan, relationForAlias, relationNameRangeOf, symMatchesCte } from './sym-spans';

/**
 * Find All References for ref('model'), source('src', 'table'), and column
 * names within the current SQL model.  For ref/source uses the manifest
 * dependency graph — no workspace-wide scan.
 */
export class DbtReferenceProvider implements vscode.ReferenceProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) { }

	async provideReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.ReferenceContext,
		token: vscode.CancellationToken,
	): Promise<vscode.Location[]> {
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.references', true)) return [];
		const line = document.lineAt(position.line).text;

		// Skip comments
		if (isLinePositionInComment(line, position.character)) return [];

		if (this.parseService) {
			const model = await this.parseService.getDocumentModel(document);
			if (!token.isCancellationRequested && model) {
				// Check refs: full {{ ref(...) }} jinja span is clickable
				const ref = model.refs.find(r =>
					r.line === position.line &&
					r.jinjaCol !== undefined && r.jinjaEndCol !== undefined &&
					position.character >= r.jinjaCol && position.character < r.jinjaEndCol,
				);
				if (ref) return this._findRefUsages(ref.model, token);

				// Check sources: only the table name identifier span
				const src = model.sources.find(s =>
					s.line === position.line &&
					s.tableNameCol !== undefined && s.tableNameEndCol !== undefined &&
					position.character >= s.tableNameCol && position.character < s.tableNameEndCol,
				);
				if (src) return this._findSourceUsages(src.sourceName, src.tableName, token);

				// Sym-based dispatch using resolved position
				const sym = ParseService.symAtPosition(model, position.line, position.character);
				if (!sym) return [];

				if (sym.kind === 'column') {
					const partIndex = ParseService.partIndexAtPosition(sym, position.line, position.character);
					const isQualifierPart = sym.partSpans !== undefined
						&& partIndex !== undefined
						&& partIndex < sym.partSpans.length - 1;
					if (isQualifierPart) {
						// Qualifier `o` in `o.col` — find the relation it resolves to (identity-based:
						// two nested scopes can share an alias name, so matching by name risks finding
						// the wrong one). An unresolved qualifier yields no references.
						const relation = sym.source;
						if (relation) return this._findAliasReferences(document, relation, model);
						return [];
					}
					const bareName = sym.name.split('.').pop()!;
					return this._findColumnReferences(document, bareName, token);
				}

				if (isRelationSym(sym)) {
					// CTE name → in-file references (position-matched, not name-matched —
					// see symMatchesCte's doc comment for why name comparison is unsafe here)
					const cte = model.ctes.find(c => symMatchesCte(sym, c));
					if (cte) return this._findCteReferences(document, model, cte);

					// relation that matches a ref() → cross-file references
					const matchingRef = model.refs.find(r => r.model === sym.name);
					if (matchingRef) return this._findRefUsages(sym.name, token);
				}

				if (sym.kind === 'alias') {
					const relation = relationForAlias(sym, model.symbols ?? []);
					if (relation) return this._findAliasReferences(document, relation, model);
				}

				return [];
			}
		}

		// Fallback when parseService is not available
		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refRe.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._findRefUsages(match[1], token);
			}
		}

		const sourceRe = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = sourceRe.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._findSourceUsages(match[1], match[2], token);
			}
		}

		return [];
	}

	private async _findRefUsages(modelName: string, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const index = this.indexer.index;
		if (!index) return [];

		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return [];

		const locations: vscode.Location[] = [];
		const pattern = new RegExp(`ref\\(\\s*['"]${this._escapeRegex(modelName)}['"]\\s*\\)`, 'g');

		for (const model of models) {
			// Include the model definition itself
			if (model.path) {
				locations.push(new vscode.Location(vscode.Uri.file(model.path), new vscode.Position(0, 0)));
			}

			// Use childMap to find downstream dependents
			const childIds = index.childMap.get(model.uniqueId) ?? [];
			const filePaths = this._resolveFilePaths(childIds, index);

			for (const filePath of filePaths) {
				if (token.isCancellationRequested) break;
				const found = await this._findPatternInFile(vscode.Uri.file(filePath), pattern);
				locations.push(...found);
			}
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for ref('${modelName}')`);
		return locations;
	}

	private async _findSourceUsages(sourceName: string, tableName: string, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const index = this.indexer.index;
		if (!index) return [];

		const found = this.indexer.findSourceByKey(sourceName, tableName);
		if (!found) return [];

		const locations: vscode.Location[] = [];
		const pattern = new RegExp(
			`source\\(\\s*['"]${this._escapeRegex(sourceName)}['"]\\s*,\\s*['"]${this._escapeRegex(tableName)}['"]\\s*\\)`,
			'g',
		);

		const childIds = index.childMap.get(found.uid) ?? [];
		const filePaths = this._resolveFilePaths(childIds, index);

		for (const filePath of filePaths) {
			if (token.isCancellationRequested) break;
			const found = await this._findPatternInFile(vscode.Uri.file(filePath), pattern);
			locations.push(...found);
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for source('${sourceName}', '${tableName}')`);
		return locations;
	}

	/** Resolve a list of unique IDs to file paths via the models index. */
	private _resolveFilePaths(
		uniqueIds: string[],
		index: import('../../indexing/manifest-indexer').ManifestIndex,
	): string[] {
		const paths: string[] = [];
		const seen = new Set<string>();
		for (const uid of uniqueIds) {
			const model = index.models.get(uid);
			if (model?.path && !seen.has(model.path)) {
				seen.add(model.path);
				paths.push(model.path);
			}
		}
		return paths;
	}

	/** Open a single file and find all positions matching the pattern. */
	private async _findPatternInFile(fileUri: vscode.Uri, pattern: RegExp): Promise<vscode.Location[]> {
		const locations: vscode.Location[] = [];
		try {
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const text = doc.getText();
			const commentRanges = computeCommentRanges(text);
			let m;
			pattern.lastIndex = 0;
			while ((m = pattern.exec(text)) !== null) {
				if (isOffsetInComment(m.index, commentRanges)) continue;
				const pos = doc.positionAt(m.index);
				const endPos = doc.positionAt(m.index + m[0].length);
				locations.push(new vscode.Location(fileUri, new vscode.Range(pos, endPos)));
			}
		} catch {
			// File could not be opened — skip
		}
		return locations;
	}

	private _escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	// ---- CTE name references within the current file ----

	private _findCteReferences(
		document: vscode.TextDocument,
		model: DocumentModel,
		cte: import('../../services/parse-service').CteInfo,
	): vscode.Location[] {
		const locations: vscode.Location[] = [];

		// CTE definition site (the name token after WITH / comma)
		const defCol = cte.col ?? 0;
		locations.push(new vscode.Location(
			document.uri,
			new vscode.Range(cte.line, defCol, cte.line, defCol + cte.name.length),
		));

		// Every relation-kind reference Sym identifying the SAME cte (position-matched,
		// not name-matched — see symMatchesCte's doc comment).
		for (const s of model.symbols ?? []) {
			if (!isRelationSym(s) || !s.modifiers.includes('reference')) continue;
			if (!symMatchesCte(s, cte)) continue;
			locations.push(new vscode.Location(document.uri, relationNameRangeOf(s)));
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for CTE '${cte.name}'`);
		return locations;
	}

	// ---- Table alias references within the current file ----

	/**
	 * `relation` is matched by identity (object === ), not by alias name — two nested
	 * scopes can declare the same alias text, and only object identity tells them apart.
	 */
	private _findAliasReferences(
		document: vscode.TextDocument,
		relation: Sym,
		model: DocumentModel,
	): vscode.Location[] {
		const locations: vscode.Location[] = [];

		const alias = relation.alias;
		if (!alias) return locations;

		// Alias definition site
		locations.push(new vscode.Location(document.uri, rangeOfSpan(alias.span)));

		// Every column reference bound to this SAME relation (identity, not name)
		for (const s of model.symbols ?? []) {
			if (s.kind !== 'column' || !s.modifiers.includes('reference')) continue;
			if (s.source !== relation) continue;
			const qRange = qualifierRangeOf(s);
			if (qRange) locations.push(new vscode.Location(document.uri, qRange));
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for alias '${alias.name}'`);
		return locations;
	}

	// ---- Column references within the current file ----

	private _findColumnReferences(
		document: vscode.TextDocument,
		columnName: string,
		token: vscode.CancellationToken,
	): vscode.Location[] {
		const text = document.getText();
		const commentRanges = computeCommentRanges(text);
		const pattern = new RegExp(`\\b${this._escapeRegex(columnName)}\\b`, 'gi');
		const locations: vscode.Location[] = [];
		let m;
		while ((m = pattern.exec(text)) !== null) {
			if (token.isCancellationRequested) break;
			if (isOffsetInComment(m.index, commentRanges)) continue;
			if (SQL_KEYWORDS.has(m[0].toUpperCase())) continue;
			const pos = document.positionAt(m.index);
			// Skip occurrences inside Jinja blocks
			const matchLine = document.lineAt(pos.line).text;
			const beforeMatch = matchLine.substring(0, pos.character);
			if (/\{\{[^}]*$/.test(beforeMatch) || /\{%[^%]*$/.test(beforeMatch)) continue;
			locations.push(new vscode.Location(document.uri, new vscode.Range(pos, document.positionAt(m.index + m[0].length))));
		}
		this.logger.debug(`ReferenceProvider: found ${locations.length} column references for '${columnName}'`);
		return locations;
	}
}
