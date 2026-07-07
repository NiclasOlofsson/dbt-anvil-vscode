import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ILogger } from '../../types/logger';
import { ParseService } from '../../services/parse-service';
import type { CteInfo, DocumentModel, RefInfo, SourceInfo } from '../../services/parse-service';
import { computeCommentRanges, isOffsetInComment } from '../common/comment-utils';
import { isRelationSym, relationNameRangeOf, symMatchesCte } from './sym-spans';

// ── Tagged subclass so we can recover kind/metadata from the item VS Code echoes back ──

type HierarchyKind = 'model' | 'cte';

class DbtHierarchyItem extends vscode.CallHierarchyItem {
	constructor(
		kind: vscode.SymbolKind,
		name: string,
		detail: string,
		uri: vscode.Uri,
		range: vscode.Range,
		selectionRange: vscode.Range,
		readonly hierarchyKind: HierarchyKind,
		readonly modelUid: string | undefined,
		readonly cteName: string | undefined,
	) {
		super(kind, name, detail, uri, range, selectionRange);
	}
}

// ── Main provider ──

export class DbtCallHierarchyProvider implements vscode.CallHierarchyProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) {}

	async prepareCallHierarchy(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<DbtHierarchyItem | null> {
		const model = await this.parseService.getDocumentModel(document);
		if (!model) return null;

		// Determine scope: CTE if cursor falls inside a CTE body
		const cte = _cteAtPosition(model.ctes, position.line);
		if (cte) return this._prepareCteItem(document, cte);

		return this._prepareModelItem(document, position, model);
	}

	async provideCallHierarchyIncomingCalls(
		item: vscode.CallHierarchyItem,
		token: vscode.CancellationToken,
	): Promise<vscode.CallHierarchyIncomingCall[]> {
		if (!(item instanceof DbtHierarchyItem)) return [];

		if (item.hierarchyKind === 'model') return this._incomingForModel(item, token);
		if (item.hierarchyKind === 'cte') return this._incomingForCte(item, token);
		return [];
	}

	async provideCallHierarchyOutgoingCalls(
		item: vscode.CallHierarchyItem,
		token: vscode.CancellationToken,
	): Promise<vscode.CallHierarchyOutgoingCall[]> {
		if (!(item instanceof DbtHierarchyItem)) return [];

		if (item.hierarchyKind === 'model') return this._outgoingForModel(item, token);
		if (item.hierarchyKind === 'cte') return this._outgoingForCte(item, token);
		return [];
	}

	// ── Prepare helpers ──

	private _prepareModelItem(
		document: vscode.TextDocument,
		position: vscode.Position,
		model: DocumentModel,
	): DbtHierarchyItem | null {
		// Cursor on ref('x') → hierarchy for the target model
		const ref = model.refs.find(r =>
			r.line === position.line &&
			r.jinjaCol !== undefined && r.jinjaEndCol !== undefined &&
			position.character >= r.jinjaCol && position.character < r.jinjaEndCol,
		);
		if (ref) return this._modelItemForRef(ref);

		// Cursor on source('x','y') → source leaf (no callers, no call stack beyond this)
		const src = model.sources.find(s =>
			s.line === position.line &&
			s.jinjaCol !== undefined && s.jinjaEndCol !== undefined &&
			position.character >= s.jinjaCol && position.character < s.jinjaEndCol,
		);
		if (src) return this._sourceItem(src, document.uri);

		// Fallback: current file's model
		const uid = this.indexer.findModelByFilePath(document.fileName);
		const fullRange = new vscode.Range(0, 0, document.lineCount - 1, 0);
		const name = _modelNameFromPath(document.fileName);
		return new DbtHierarchyItem(
			vscode.SymbolKind.Module,
			name,
			document.fileName,
			document.uri,
			fullRange,
			fullRange,
			'model',
			uid,
			undefined,
		);
	}

	private _prepareCteItem(
		document: vscode.TextDocument,
		cte: CteInfo,
	): DbtHierarchyItem {
		const nameRange = new vscode.Range(cte.line, cte.col ?? 0, cte.line, (cte.col ?? 0) + cte.name.length);
		const bodyRange = new vscode.Range(cte.line, 0, cte.endLine, 0);
		return new DbtHierarchyItem(
			vscode.SymbolKind.Function,
			cte.name,
			'CTE',
			document.uri,
			bodyRange,
			nameRange,
			'cte',
			undefined,
			cte.name,
		);
	}

	private _modelItemForRef(ref: RefInfo): DbtHierarchyItem | null {
		const index = this.indexer.index;
		if (!index) return null;
		const models = this.indexer.findModelsByName(ref.model);
		if (models.length === 0) return null;
		const target = models[0];
		const uri = vscode.Uri.file(target.path);
		const range = new vscode.Range(0, 0, 0, 0);
		return new DbtHierarchyItem(
			vscode.SymbolKind.Module,
			target.name,
			target.path,
			uri,
			range,
			range,
			'model',
			target.uniqueId,
			undefined,
		);
	}

	private _sourceItem(src: SourceInfo, fallbackUri: vscode.Uri): DbtHierarchyItem {
		const range = new vscode.Range(src.line, src.jinjaCol ?? src.col, src.line, src.jinjaEndCol ?? src.col + 10);
		return new DbtHierarchyItem(
			vscode.SymbolKind.Interface,
			`${src.sourceName}.${src.tableName}`,
			'source',
			fallbackUri,
			range,
			range,
			'model',
			undefined,
			undefined,
		);
	}

	// ── Model-level incoming (callers) ──

	private async _incomingForModel(
		item: DbtHierarchyItem,
		token: vscode.CancellationToken,
	): Promise<vscode.CallHierarchyIncomingCall[]> {
		const index = this.indexer.index;
		if (!index || !item.modelUid) return [];

		const childIds = index.childMap.get(item.modelUid) ?? [];
		if (childIds.length === 0) return [];

		const calls: vscode.CallHierarchyIncomingCall[] = [];
		const pattern = new RegExp(`ref\\(\\s*['"]${_escapeRegex(item.name)}['"]\\s*\\)`, 'g');

		for (const uid of childIds) {
			if (token.isCancellationRequested) break;
			const callerModel = index.models.get(uid);
			if (!callerModel?.path) continue;

			const locations = await this._findPatternInFile(vscode.Uri.file(callerModel.path), pattern, token);
			if (locations.length === 0) continue;

			const uid2 = this.indexer.findModelByFilePath(callerModel.path);
			const callerRange = new vscode.Range(0, 0, 0, 0);
			const callerItem = new DbtHierarchyItem(
				vscode.SymbolKind.Module,
				callerModel.name,
				callerModel.path,
				vscode.Uri.file(callerModel.path),
				callerRange,
				callerRange,
				'model',
				uid2,
				undefined,
			);
			calls.push(new vscode.CallHierarchyIncomingCall(callerItem, locations.map(l => l.range)));
		}

		this.logger.debug(`CallHierarchy: ${calls.length} incoming callers for model '${item.name}'`);
		return calls;
	}

	// ── Model-level outgoing (callees) ──

	private async _outgoingForModel(
		item: DbtHierarchyItem,
		_token: vscode.CancellationToken,
	): Promise<vscode.CallHierarchyOutgoingCall[]> {
		// Open the model file and parse it
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(item.uri);
		} catch {
			return [];
		}

		const model = await this.parseService.getDocumentModel(document);
		if (!model) return [];

		const calls: vscode.CallHierarchyOutgoingCall[] = [];

		// ref() calls → model items
		for (const ref of model.refs) {
			const targetItem = this._modelItemForRef(ref);
			if (!targetItem) continue;
			const fromRange = new vscode.Range(
				ref.line, ref.jinjaCol ?? ref.col,
				ref.line, ref.jinjaEndCol ?? ref.col + ref.model.length,
			);
			calls.push(new vscode.CallHierarchyOutgoingCall(targetItem, [fromRange]));
		}

		// source() calls → leaf items
		for (const src of model.sources) {
			const targetItem = this._sourceItem(src, item.uri);
			const fromRange = new vscode.Range(
				src.line, src.jinjaCol ?? src.col,
				src.line, src.jinjaEndCol ?? src.col + 10,
			);
			calls.push(new vscode.CallHierarchyOutgoingCall(targetItem, [fromRange]));
		}

		this.logger.debug(`CallHierarchy: ${calls.length} outgoing calls for model '${item.name}'`);
		return calls;
	}

	// ── CTE-level incoming (which CTEs or final SELECT read this CTE) ──

	private async _incomingForCte(
		item: DbtHierarchyItem,
		_token: vscode.CancellationToken,
	): Promise<vscode.CallHierarchyIncomingCall[]> {
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(item.uri);
		} catch {
			return [];
		}

		const model = await this.parseService.getDocumentModel(document);
		if (!model || !item.cteName) return [];

		const cteName = item.cteName;
		const targetCte = model.ctes.find(c => c.name === cteName);
		if (!targetCte) return [];
		const lastCteEnd = Math.max(...model.ctes.map(c => c.endLine));

		// Group table_ref tokens by the CTE they belong to (or "final SELECT")
		const calls: vscode.CallHierarchyIncomingCall[] = [];

		// Scan each other CTE's body for reference syms pointing at cteName (position-
		// matched via symMatchesCte, not name-matched — see its doc comment)
		for (const cte of model.ctes) {
			if (cte.name === cteName) continue;
			const refs = (model.symbols ?? []).filter(s =>
				isRelationSym(s) && s.modifiers.includes('reference') &&
				symMatchesCte(s, targetCte) &&
				(s.span.line - 1) >= cte.line && (s.span.line - 1) <= cte.endLine,
			);
			if (refs.length === 0) continue;

			const callerItem = this._prepareCteItem(document, cte);
			const fromRanges = refs.map(s => relationNameRangeOf(s));
			calls.push(new vscode.CallHierarchyIncomingCall(callerItem, fromRanges));
		}

		// Also scan the final SELECT (lines after all CTEs)
		const finalRefs = (model.symbols ?? []).filter(s =>
			isRelationSym(s) && s.modifiers.includes('reference') &&
			symMatchesCte(s, targetCte) &&
			(s.span.line - 1) > lastCteEnd,
		);
		if (finalRefs.length > 0) {
			const finalStart = lastCteEnd + 1;
			const lastLine = document.lineCount - 1;
			const selRange = new vscode.Range(finalStart, 0, finalStart, 0);
			const bodyRange = new vscode.Range(finalStart, 0, lastLine, 0);
			const finalItem = new DbtHierarchyItem(
				vscode.SymbolKind.Operator,
				'(final SELECT)',
				'',
				document.uri,
				bodyRange,
				selRange,
				'cte',
				undefined,
				'__final__',
			);
			calls.push(new vscode.CallHierarchyIncomingCall(
				finalItem,
				finalRefs.map(s => relationNameRangeOf(s)),
			));
		}

		this.logger.debug(`CallHierarchy: ${calls.length} incoming callers for CTE '${cteName}'`);
		return calls;
	}

	// ── CTE-level outgoing (which CTEs this CTE reads from) ──

	private async _outgoingForCte(
		item: DbtHierarchyItem,
		_token: vscode.CancellationToken,
	): Promise<vscode.CallHierarchyOutgoingCall[]> {
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(item.uri);
		} catch {
			return [];
		}

		const model = await this.parseService.getDocumentModel(document);
		if (!model || !item.cteName) return [];

		if (item.cteName === '__final__') {
			return this._outgoingForFinalSelect(document, model);
		}

		const cteDef = model.ctes.find(c => c.name === item.cteName);
		if (!cteDef) return [];

		const cteNames = new Set(model.ctes.map(c => c.name));
		const calls: vscode.CallHierarchyOutgoingCall[] = [];

		// reference syms inside this CTE's body that refer to another CTE
		const tableRefs = (model.symbols ?? []).filter(s =>
			isRelationSym(s) && s.modifiers.includes('reference') &&
			(s.span.line - 1) >= cteDef.line && (s.span.line - 1) <= cteDef.endLine &&
			cteNames.has(s.name),
		);

		// Deduplicate by name — one outgoing item per target CTE, multiple fromRanges
		const byName = new Map<string, vscode.Range[]>();
		for (const s of tableRefs) {
			const ranges = byName.get(s.name) ?? [];
			ranges.push(relationNameRangeOf(s));
			byName.set(s.name, ranges);
		}

		for (const [name, fromRanges] of byName) {
			const targetCte = model.ctes.find(c => c.name === name);
			if (!targetCte) continue;
			const targetItem = this._prepareCteItem(document, targetCte);
			calls.push(new vscode.CallHierarchyOutgoingCall(targetItem, fromRanges));
		}

		// Also emit ref() calls within the CTE body as model outgoing
		for (const ref of model.refs) {
			if (ref.line < cteDef.line || ref.line > cteDef.endLine) continue;
			const targetItem = this._modelItemForRef(ref);
			if (!targetItem) continue;
			const fromRange = new vscode.Range(
				ref.line, ref.jinjaCol ?? ref.col,
				ref.line, ref.jinjaEndCol ?? ref.col + ref.model.length,
			);
			calls.push(new vscode.CallHierarchyOutgoingCall(targetItem, [fromRange]));
		}

		this.logger.debug(`CallHierarchy: ${calls.length} outgoing calls for CTE '${item.cteName}'`);
		return calls;
	}

	private _outgoingForFinalSelect(
		document: vscode.TextDocument,
		model: DocumentModel,
	): vscode.CallHierarchyOutgoingCall[] {
		const lastCteEnd = Math.max(...model.ctes.map(c => c.endLine));
		const cteNames = new Set(model.ctes.map(c => c.name));
		const calls: vscode.CallHierarchyOutgoingCall[] = [];

		const byName = new Map<string, vscode.Range[]>();
		for (const s of model.symbols ?? []) {
			if (!isRelationSym(s) || !s.modifiers.includes('reference')) continue;
			if ((s.span.line - 1) <= lastCteEnd) continue;
			if (!cteNames.has(s.name)) continue;
			const ranges = byName.get(s.name) ?? [];
			ranges.push(relationNameRangeOf(s));
			byName.set(s.name, ranges);
		}

		for (const [name, fromRanges] of byName) {
			const targetCte = model.ctes.find(c => c.name === name);
			if (!targetCte) continue;
			calls.push(new vscode.CallHierarchyOutgoingCall(this._prepareCteItem(document, targetCte), fromRanges));
		}
		return calls;
	}

	// ── File scanning utility ──

	private async _findPatternInFile(
		fileUri: vscode.Uri,
		pattern: RegExp,
		_token: vscode.CancellationToken,
	): Promise<vscode.Location[]> {
		const locations: vscode.Location[] = [];
		try {
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const text = doc.getText();
			const commentRanges = computeCommentRanges(text);
			pattern.lastIndex = 0;
			let m: RegExpExecArray | null;
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
}

// ── Pure helpers ──

function _cteAtPosition(ctes: CteInfo[], line: number): CteInfo | undefined {
	return ctes.find(c => line >= c.line && line <= c.endLine);
}

function _modelNameFromPath(filePath: string): string {
	const parts = filePath.replace(/\\/g, '/').split('/');
	const last = parts[parts.length - 1] ?? '';
	return last.replace(/\.[^.]+$/, '');
}

function _escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
