// SQL linting diagnostics (style/syntax) are delegated to SQLFluff.
// This provider surfaces dbt-specific semantic errors:
// 1. Real-time: unknown ref() / source() calls validated against the manifest index
// 2. Post-parse: compilation errors detected by `dbt parse`

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DbtExecutionService } from '../dbt/execution-service';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { StatusBarManager } from '../views/status-bar';
import type { ILogger } from '../types/logger';
import type { ColumnResolver } from './column-resolver';
import { computeCommentRanges, isOffsetInComment } from './comment-utils';
import type { CommentRange } from './comment-utils';

interface DbtErrorLocation {
	filePath: string;
	line: number;
	message: string;
}

export class DbtDiagnosticsProvider implements vscode.Disposable {
	private readonly _parseCollection: vscode.DiagnosticCollection;
	private readonly _refCollection: vscode.DiagnosticCollection;
	private readonly _columnCollection: vscode.DiagnosticCollection;
	private readonly _disposables: vscode.Disposable[] = [];
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _columnDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _columnCts: vscode.CancellationTokenSource | undefined;

	constructor(
		service: DbtExecutionService,
		private readonly indexer: ManifestIndexer,
		private readonly statusBar: StatusBarManager,
		private readonly projectDir: string,
		private readonly logger: ILogger,
		private readonly columnResolver?: ColumnResolver,
		onEnrichmentComplete?: vscode.Event<vscode.Uri>,
	) {
		this._parseCollection = vscode.languages.createDiagnosticCollection('dbt-studio');
		this._refCollection = vscode.languages.createDiagnosticCollection('dbt-studio-refs');
		this._columnCollection = vscode.languages.createDiagnosticCollection('dbt-studio-columns');

		// Parse-based diagnostics
		this._disposables.push(
			service.onJobCompleted(({ job, result }) => {
				if (job.type === 'parse') {
					if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) return;
					// Always scan stderr — dbt parse can return success=true
					// even when there are compilation/syntax errors in models.
					// Also scan stdout — dbt often writes error details there too.
					const combined = [result.stderr, result.stdout].filter(Boolean).join('\n');
					this._handleParseOutput(combined, result.success);
				}
			}),
			service.onJobFailed(({ job, error }) => {
				if (job.type === 'parse') {
					if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) return;
					this._handleParseOutput(error.message, false);
				}
			}),
		);

		// Real-time ref/source validation
		this._disposables.push(
			vscode.workspace.onDidOpenTextDocument((doc) => {
				if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) return;
				this._validateDocument(doc);
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) return;
				this._validateDocumentDebounced(e.document);
			}),
			vscode.workspace.onDidCloseTextDocument((doc) => {
				this._refCollection.delete(doc.uri);
				this._columnCollection.delete(doc.uri);
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('dbt-studio.providers.sql.diagnostics')) {
					const enabled = vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true);
					if (!enabled) {
						this.clearAll();
					} else {
						for (const editor of vscode.window.visibleTextEditors) {
							this._validateDocument(editor.document);
						}
					}
				}
			}),
		);

		// Re-validate column diagnostics when background enrichment completes.
		// Enrichment runs asynchronously after parse — without this, column
		// diagnostics stay stale until the user edits the file again.
		if (onEnrichmentComplete && this.columnResolver) {
			this._disposables.push(
				onEnrichmentComplete((uri) => {
					if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) return;
					const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
					if (doc) this._validateColumnsDebounced(doc);
				}),
			);
		}

		// Validate all currently open editors
		for (const editor of vscode.window.visibleTextEditors) {
			if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) break;
			this._validateDocument(editor.document);
		}
	}

	// ---- Real-time ref/source validation ----

	private _validateDocumentDebounced(document: vscode.TextDocument): void {
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => this._validateDocument(document), 250);
	}

	private _validateDocument(document: vscode.TextDocument): void {
		if (document.languageId !== 'jinja-sql') return;
		if (!this.indexer.index) return;

		const text = document.getText();
		const commentRanges = computeCommentRanges(text);
		const diagnostics: vscode.Diagnostic[] = [];

		this._validateRefs(document, text, commentRanges, diagnostics);
		this._validateSources(document, text, commentRanges, diagnostics);

		this._refCollection.set(document.uri, diagnostics);
		this._updateStatusBar();

		// Async column validation (longer debounce, separate collection)
		if (this.columnResolver) {
			this._validateColumnsDebounced(document);
		}
	}

	private _validateRefs(
		document: vscode.TextDocument,
		text: string,
		commentRanges: CommentRange[],
		diagnostics: vscode.Diagnostic[],
	): void {
		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refRe.exec(text)) !== null) {
			if (isOffsetInComment(match.index, commentRanges)) continue;
			const modelName = match[1];
			const models = this.indexer.findModelsByName(modelName);
			if (models.length === 0) {
				const nameStart = match.index + match[0].indexOf(modelName);
				const range = new vscode.Range(
					document.positionAt(nameStart),
					document.positionAt(nameStart + modelName.length),
				);
				const diag = new vscode.Diagnostic(
					range,
					`Model '${modelName}' not found in dbt manifest`,
					vscode.DiagnosticSeverity.Error,
				);
				diag.source = 'dbt';
				diag.code = 'unknown-ref';
				diagnostics.push(diag);
			}
		}
	}

	private _validateSources(
		document: vscode.TextDocument,
		text: string,
		commentRanges: CommentRange[],
		diagnostics: vscode.Diagnostic[],
	): void {
		const index = this.indexer.index;
		if (!index) return;

		const sourceRe = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = sourceRe.exec(text)) !== null) {
			if (isOffsetInComment(match.index, commentRanges)) continue;
			const sourceName = match[1];
			const tableName = match[2];

			// Check all source entries for a match on sourceName + tableName
			let found = false;
			for (const src of index.sources.values()) {
				if (src.sourceName === sourceName && src.name === tableName) {
					found = true;
					break;
				}
			}

			if (!found) {
				const matchStart = match.index + match[0].indexOf(sourceName);
				const matchEnd = match.index + match[0].lastIndexOf(tableName) + tableName.length;
				const range = new vscode.Range(
					document.positionAt(matchStart),
					document.positionAt(matchEnd),
				);
				const diag = new vscode.Diagnostic(
					range,
					`Source '${sourceName}.${tableName}' not found in dbt manifest`,
					vscode.DiagnosticSeverity.Warning,
				);
				diag.source = 'dbt';
				diag.code = 'unknown-source';
				diagnostics.push(diag);
			}
		}
	}

	// ---- Column validation (async) ----

	private _validateColumnsDebounced(document: vscode.TextDocument): void {
		if (this._columnDebounceTimer) clearTimeout(this._columnDebounceTimer);
		this._columnCts?.cancel();
		this._columnDebounceTimer = setTimeout(() => {
			this._validateColumnsAsync(document).catch(err => {
				this.logger.debug(`Column validation error: ${err}`);
			});
		}, 500);
	}

	private async _validateColumnsAsync(document: vscode.TextDocument): Promise<void> {
		if (!this.columnResolver) return;

		this._columnCts?.cancel();
		this._columnCts = new vscode.CancellationTokenSource();
		const token = this._columnCts.token;

		const { tokens, aliases } = await this.columnResolver.getTokensAndAliases(document, token);
		if (token.isCancellationRequested) return;
		if (Object.keys(aliases).length === 0) {
			this._columnCollection.delete(document.uri);
			this._updateStatusBar();
			return;
		}

		const diagnostics: vscode.Diagnostic[] = [];

		for (const t of tokens) {
			if (t.type !== 'column_ref' || !t.table) continue;

			const cols = aliases[t.table] ?? aliases[t.table.toLowerCase()];
			if (!cols) continue; // alias not in scope map — unresolvable, skip

			if (!cols.some(c => c.toLowerCase() === t.name.toLowerCase())) {
				const range = new vscode.Range(
					new vscode.Position(t.line, t.col),
					new vscode.Position(t.line, t.endCol),
				);
				const diag = new vscode.Diagnostic(
					range,
					`Column '${t.name}' not found in '${t.table}' (known columns: ${cols.slice(0, 5).join(', ')}${cols.length > 5 ? ', ...' : ''})`,
					vscode.DiagnosticSeverity.Warning,
				);
				diag.source = 'dbt';
				diag.code = 'unknown-column';
				diagnostics.push(diag);
			}
		}

		this._columnCollection.set(document.uri, diagnostics);
		this._updateStatusBar();
	}

	// ---- Parse-based diagnostics ----

	private _handleParseOutput(output: string, success: boolean): void {
		this._parseCollection.clear();
		const errors = this._parseErrors(output);

		if (errors.length === 0) {
			this._updateStatusBar();
			this.logger.debug(success
				? 'Parse succeeded — no parse diagnostics'
				: 'Parse failed but no extractable diagnostics');
			return;
		}

		const byFile = new Map<string, vscode.Diagnostic[]>();
		for (const err of errors) {
			const filePath = path.isAbsolute(err.filePath)
				? err.filePath
				: path.join(this.projectDir, err.filePath);
			const uri = vscode.Uri.file(filePath);
			const key = uri.toString();
			if (!byFile.has(key)) byFile.set(key, []);
			const range = new vscode.Range(
				new vscode.Position(Math.max(0, err.line - 1), 0),
				new vscode.Position(Math.max(0, err.line - 1), Number.MAX_SAFE_INTEGER),
			);
			const diagnostic = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
			diagnostic.source = 'dbt';
			byFile.get(key)!.push(diagnostic);
		}

		for (const [uriStr, diags] of byFile) {
			this._parseCollection.set(vscode.Uri.parse(uriStr), diags);
		}

		this._updateStatusBar();
		this.logger.info(`Parse failed — ${errors.length} diagnostic(s) created`);
	}

	private _parseErrors(output: string): DbtErrorLocation[] {
		const errors: DbtErrorLocation[] = [];

		// dbt error patterns:
		// "Compilation Error in model X (models/path/file.sql)"
		// "YAML Parsing Error in file path/to/file.yml"
		// "Syntax Error in model X (models/path/file.sql)"
		const errorPattern = /(?:Compilation|Database|Parsing|Syntax|Runtime) Error.*?\(([^)]+\.(?:sql|yml|yaml))\)/g;
		let match;
		while ((match = errorPattern.exec(output)) !== null) {
			const filePath = match[1];
			const surroundingText = output.substring(match.index, match.index + 500);
			const lineMatch = /line (\d+)/i.exec(surroundingText);
			const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;

			const afterHeader = output.substring(match.index);
			const msgLines = afterHeader.split('\n').slice(1).map(l => l.trim()).filter(l => l);
			const message = msgLines[0] || match[0];

			errors.push({ filePath, line, message });
		}

		return errors;
	}

	private _updateStatusBar(): void {
		let count = 0;
		this._parseCollection.forEach((_, diags) => { count += diags.length; });
		this._refCollection.forEach((_, diags) => { count += diags.length; });
		this._columnCollection.forEach((_, diags) => { count += diags.length; });
		this.statusBar.setErrorCount(count);
	}

	clearAll(): void {
		this._parseCollection.clear();
		this._refCollection.clear();
		this._columnCollection.clear();
		this.statusBar.setErrorCount(0);
	}

	dispose(): void {
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		if (this._columnDebounceTimer) clearTimeout(this._columnDebounceTimer);
		this._columnCts?.cancel();
		for (const d of this._disposables) d.dispose();
		this._parseCollection.dispose();
		this._refCollection.dispose();
		this._columnCollection.dispose();
	}
}


