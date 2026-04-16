// SQL linting diagnostics — dbt-specific semantic errors and Ninja style linting:
// 1. Real-time: unknown ref() / source() calls validated against the manifest index
// 2. Post-parse: compilation errors detected by `dbt parse`
// 3. Ninja: built-in style/layout linting (capitalisation, whitespace, jinja padding)

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DbtExecutionService } from '../dbt/execution-service';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { StatusBarManager } from '../views/status-bar';
import type { ILogger } from '../types/logger';
import { ParseService } from '../services/parse-service';
import type { SqlglotWarning, DocumentModel } from '../services/parse-service';
import { computeCommentRanges, isOffsetInComment } from './common/comment-utils';
import type { CommentRange } from './common/comment-utils';
import { runNinja } from '../ninja/engine';
import type { NinjaResult } from '../ninja/engine';
import { loadConfig } from '../ninja/config-loader';
import { tokenize } from '../dbt/jinja-tokenizer';

interface DbtErrorLocation {
	filePath: string;
	line: number;
	message: string;
}

export class DbtDiagnosticsProvider implements vscode.Disposable {
	private readonly _parseCollection: vscode.DiagnosticCollection;
	private readonly _refCollection: vscode.DiagnosticCollection;
	private readonly _columnCollection: vscode.DiagnosticCollection;
	/** Structural SQL warnings from sqlglot (e.g. Aliases node type from a dangling identifier). */
	private readonly _sqlglotCollection: vscode.DiagnosticCollection;
	/** Warning shown on dbt_project.yml when SQLFluff is active alongside dbt Studio. */
	private readonly _sqlfluffCollection: vscode.DiagnosticCollection;
	/** Warning shown on dbt_project.yml when auto-save is enabled (triggers frequent dbt parse). */
	private readonly _autoSaveCollection: vscode.DiagnosticCollection;
	/** Warning shown on dbt_project.yml when dbt Studio is not the default formatter for jinja-sql. */
	private readonly _formatterCollection: vscode.DiagnosticCollection;
	/** Ninja style-linting diagnostics (capitalisation, whitespace, jinja padding). */
	private readonly _ninjaCollection: vscode.DiagnosticCollection;
	/** Stores the last Ninja result per document URI for quick-fix code actions. */
	private readonly _ninjaResults = new Map<string, NinjaResult>();
	/** Blocks diagnostics until startup manifest/index initialization is complete. */
	private _startupReady: boolean;
	/** Visual-only dimming decoration applied from the syntax error token to end-of-file. */
	private readonly _syntaxErrorDim: vscode.TextEditorDecorationType;
	/** Tracks the dimmed range per document URI so it can be re-applied on tab switch. */
	private readonly _syntaxErrorDimRanges = new Map<string, vscode.Range>();
	private readonly _disposables: vscode.Disposable[] = [];
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	// Per-document maps so one file's validation never cancels another file's timer/request.
	private readonly _columnDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly _columnCtsSources = new Map<string, vscode.CancellationTokenSource>();

	constructor(
		service: DbtExecutionService,
		private readonly indexer: ManifestIndexer,
		private readonly statusBar: StatusBarManager,
		private readonly projectDir: string,
		private readonly logger: ILogger,
		private readonly parseService?: ParseService,
		onAliasesReady?: vscode.Event<vscode.Uri>,
		onIndexRebuild?: vscode.Event<ManifestIndexer>,
		onSqlglotWarnings?: vscode.Event<{ uri: vscode.Uri; warnings: SqlglotWarning[] }>,
		startupReady = true,
	) {
		this._startupReady = startupReady;
		this._parseCollection = vscode.languages.createDiagnosticCollection('dbt-studio');
		this._refCollection = vscode.languages.createDiagnosticCollection('dbt-studio-refs');
		this._columnCollection = vscode.languages.createDiagnosticCollection('dbt-studio-columns');
		this._sqlglotCollection = vscode.languages.createDiagnosticCollection('dbt-studio-sqlglot');
		this._sqlfluffCollection = vscode.languages.createDiagnosticCollection('dbt-studio-sqlfluff');
		this._autoSaveCollection = vscode.languages.createDiagnosticCollection('dbt-studio-autosave');
		this._formatterCollection = vscode.languages.createDiagnosticCollection('dbt-studio-formatter');
		this._ninjaCollection = vscode.languages.createDiagnosticCollection('dbt-studio-ninja');
		this._syntaxErrorDim = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
		this._disposables.push(this._syntaxErrorDim);

		// SQLFluff warning: shown on dbt_project.yml when SQLFluff extension is active.
		// Cleared when the user sets dbt-studio.notifications.suppressSqlFluffWarning in settings.
		this._updateSqlFluffDiagnostic();
		// Auto-save warning: shown on dbt_project.yml when auto-save is enabled.
		// Cleared when the user sets dbt-studio.notifications.suppressAutoSaveWarning in settings.
		this._updateAutoSaveDiagnostic();
		// Formatter warning: shown on dbt_project.yml when dbt Studio is not the default formatter.
		// Cleared when the user sets the formatter or sets dbt-studio.notifications.suppressFormatterWarning.
		this._updateFormatterDiagnostic();
		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('dbt-studio.notifications.suppressSqlFluffWarning')) {
					this._updateSqlFluffDiagnostic();
				}
				if (e.affectsConfiguration('dbt-studio.notifications.suppressAutoSaveWarning') || e.affectsConfiguration('files.autoSave')) {
					this._updateAutoSaveDiagnostic();
				}
				if (e.affectsConfiguration('dbt-studio.notifications.suppressFormatterWarning') || e.affectsConfiguration('editor.defaultFormatter')) {
					this._updateFormatterDiagnostic();
				}
			}),
			vscode.extensions.onDidChange(() => this._updateSqlFluffDiagnostic()),
		);

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
				this._runNinjaDirect(doc);
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) return;
				this._validateDocumentDebounced(e.document);
				this._runNinjaDebounced(e.document);
			}),
			// vscode.workspace.onDidCloseTextDocument((doc) => {
			// 	this._refCollection.delete(doc.uri);
			// 	this._columnCollection.delete(doc.uri);
			// 	this._sqlglotCollection.delete(doc.uri);
			// 	// Ninja diagnostics are intentionally kept after close — they represent
			// 	// workspace-wide lint results that should remain visible in the Problems panel.
			// 	this._ninjaResults.delete(doc.uri.toString());
			// 	this._syntaxErrorDimRanges.delete(doc.uri.toString());
			// 	this._updateStatusBar();
			// }),
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
				if (e.affectsConfiguration('dbt-studio.ninja')) {
					// Re-run ninja on all open SQL documents when ninja settings change
					for (const editor of vscode.window.visibleTextEditors) {
						if (editor.document.languageId === 'jinja-sql') {
							this._runNinjaDebounced(editor.document);
						}
					}
				}
			}),
		);

		// Re-validate column diagnostics when background enrichment completes.
		// Enrichment runs asynchronously after parse — without this, column
		// diagnostics stay stale until the user edits the file again.
		if (onAliasesReady && this.parseService) {
			this._disposables.push(
				onAliasesReady((uri) => {
					if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) return;
					const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
					if (doc) this._validateColumnsDebounced(doc);
				}),
			);
		}

		// Re-validate ref/source diagnostics when the manifest index is rebuilt.
		// Without this, stale "unknown ref/source" errors linger until the user edits the file.
		// NOTE: _columnCollection is intentionally NOT touched here — column diagnostics are
		// managed independently by the onAliasesReady path (fast SQL parse + enrichment).
		// Clearing columns here would wipe correctly-set diagnostics and the single debounce
		// timer means only the last document in the loop would ever get them restored.
		if (onIndexRebuild) {
			this._disposables.push(
				onIndexRebuild(() => {
					this.setStartupReady();
					if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) return;
					const openSqlDocs = vscode.workspace.textDocuments.filter(d => d.languageId === 'jinja-sql');
					this.logger.debug(`[diagnostics] onIndexRebuild: re-validating refs/sources for ${openSqlDocs.length} open jinja-sql docs`);
					// Snapshot URIs currently tracked so we can clean up closed-doc entries
					// without a global clear() that would flash open documents.
					const openUris = new Set(openSqlDocs.map(d => d.uri.toString()));
					const staleRefUris: vscode.Uri[] = [];
					this._refCollection.forEach((uri) => {
						if (!openUris.has(uri.toString())) staleRefUris.push(uri);
					});
					for (const uri of staleRefUris) this._refCollection.delete(uri);
					for (const doc of openSqlDocs) {
						this._validateRefsOnly(doc);					// Re-validate column diagnostics too — per-doc debounce ensures
						// each file gets its own timer, so no file cancels another.
						if (this.parseService) this._validateColumnsDebounced(doc);
					}
					this._updateStatusBar();
				}),
			);
		}

		// Surface sqlglot warnings as diagnostics. These fire on every parse — empty
		// list clears stale diagnostics, non-empty list replaces them.
		// syntax_error → Error (red squiggle, precise token range)
		// scope_warning → Warning (yellow squiggle, CTE line)
		if (onSqlglotWarnings) {
			this._disposables.push(
				onSqlglotWarnings(({ uri, warnings }) => {
					const diagnostics = warnings.map((w) => {
						const isSyntaxError = w.type === 'syntax_error';
						const line = w.line ?? 0;
						const startCol = w.col ?? 0;
						const endCol = w.endCol ?? Number.MAX_SAFE_INTEGER;
						const severity = isSyntaxError
							? vscode.DiagnosticSeverity.Error
							: vscode.DiagnosticSeverity.Warning;
						const prefix = isSyntaxError ? 'SQL syntax error' : 'SQL structure warning';
						const diag = new vscode.Diagnostic(
							new vscode.Range(line, startCol, line, endCol),
							`${prefix}: ${w.message}`,
							severity,
						);
						diag.source = 'dbt-studio (sqlglot)';
						diag.code = isSyntaxError ? 'sqlglot-syntax-error' : 'sqlglot-scope-warning';
						return diag;
					});
					this._sqlglotCollection.set(uri, diagnostics);
					this._updateSyntaxErrorDim(uri, warnings);
				}),
			);
		}

		// Clean up all diagnostics when a file is deleted so stale entries don't linger.
		this._disposables.push(
			vscode.workspace.onDidDeleteFiles((e) => {
				for (const uri of e.files) {
					this._parseCollection.delete(uri);
					this._refCollection.delete(uri);
					this._columnCollection.delete(uri);
					this._sqlglotCollection.delete(uri);
					this._ninjaCollection.delete(uri);
					this._ninjaResults.delete(uri.toString());
					this._syntaxErrorDimRanges.delete(uri.toString());
				}
			}),
		);

		// Re-apply dim decoration when the user switches to a tab that already has a syntax error.
		this._disposables.push(
			vscode.window.onDidChangeVisibleTextEditors((editors) => {
				for (const editor of editors) {
					const range = this._syntaxErrorDimRanges.get(editor.document.uri.toString());
					editor.setDecorations(this._syntaxErrorDim, range ? [range] : []);
				}
			}),
		);

		// Validate all currently open editors
		for (const editor of vscode.window.visibleTextEditors) {
			if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) break;
			this._validateDocument(editor.document);
		}
	}

	setStartupReady(): void {
		if (this._startupReady) return;
		this._startupReady = true;
		this.logger.debug('[diagnostics] startup initialization complete — enabling document diagnostics');

		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.diagnostics', true)) return;
		for (const editor of vscode.window.visibleTextEditors) {
			this._validateDocument(editor.document);
		}
	}

	// ---- Real-time ref/source validation ----

	private _validateDocumentDebounced(document: vscode.TextDocument): void {
		if (!this._startupReady) return;
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => this._validateDocument(document), 250);
	}

	private _validateDocument(document: vscode.TextDocument): void {
		if (!this._startupReady) return;
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
		if (this.parseService) {
			this._validateColumnsDebounced(document);
		}

	}

	/** Re-validate only ref/source diagnostics (no column validation). Used by onIndexRebuild. */
	private _validateRefsOnly(document: vscode.TextDocument): void {
		if (document.languageId !== 'jinja-sql') return;
		if (!this.indexer.index) return;

		const text = document.getText();
		const commentRanges = computeCommentRanges(text);
		const diagnostics: vscode.Diagnostic[] = [];

		this._validateRefs(document, text, commentRanges, diagnostics);
		this._validateSources(document, text, commentRanges, diagnostics);

		this._refCollection.set(document.uri, diagnostics);
		this.logger.debug(`[diagnostics] ref validation: ${diagnostics.length} issues in ${path.basename(document.fileName)}`);
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

	// ---- Ninja linting ----

	private readonly _ninjaDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	private _runNinjaDirect(document: vscode.TextDocument): void {
		if (!this._startupReady) return;
		if (document.languageId !== 'jinja-sql') return;
		this._runNinjaAsync(document).catch(err => {
			const stack = err instanceof Error ? err.stack ?? err.message : String(err);
			this.logger.debug(`Ninja lint error in ${document.fileName}:\n${stack}`);
		});
	}

	private _runNinjaDebounced(document: vscode.TextDocument): void {
		if (!this._startupReady) return;
		if (document.languageId !== 'jinja-sql') return;
		const key = document.uri.toString();
		const existing = this._ninjaDebounceTimers.get(key);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this._ninjaDebounceTimers.delete(key);
			this._runNinjaAsync(document).catch(err => {
				const stack = err instanceof Error ? err.stack ?? err.message : String(err);
				this.logger.debug(`Ninja lint error in ${document.fileName}:\n${stack}`);
			});
		}, 300);
		this._ninjaDebounceTimers.set(key, timer);
	}

	private async _runNinjaAsync(document: vscode.TextDocument): Promise<void> {
		if (!this._startupReady) return;
		const config = loadConfig();
		if (!config.enabled) {
			this._ninjaCollection.delete(document.uri);
			this._ninjaResults.delete(document.uri.toString());
			return;
		}

		const [model, dialectSymbols] = await Promise.all([
			this.parseService ? this.parseService.getDocumentModel(document) : Promise.resolve(null),
			this.parseService ? this.parseService.getDialectSymbols() : Promise.resolve(undefined),
		]);

		// If we can't get a parse result, run layout rules only (no token rules)
		const jinjaTokens = tokenize(document.getText());
		const emptyModel: DocumentModel = { ctes: [], refs: [], sources: [], tokens: [], finalColumns: [], timing: { parseMs: 0, totalMs: 0 } };
		const result = runNinja(document, model ?? emptyModel, jinjaTokens, config, dialectSymbols ?? undefined);

		this._ninjaResults.set(document.uri.toString(), result);

		const diagnostics: vscode.Diagnostic[] = [];
		for (const v of result.violations) {
			const sev = result.severityMap.get(v.rule) ?? vscode.DiagnosticSeverity.Warning;
			const diag = new vscode.Diagnostic(v.range, v.message, sev);
			diag.source = 'ninja';
			diag.code = v.rule;
			diagnostics.push(diag);
		}

		this._ninjaCollection.set(document.uri, diagnostics);
		this._updateStatusBar();
	}

	/** Get the last ninja result for a document (used by code action provider). */
	getNinjaResult(uri: vscode.Uri): NinjaResult | undefined {
		return this._ninjaResults.get(uri.toString());
	}

	// ---- Column validation (async) ----

	private _validateColumnsDebounced(document: vscode.TextDocument): void {
		if (!this._startupReady) return;
		const key = document.uri.toString();
		const existing = this._columnDebounceTimers.get(key);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this._columnDebounceTimers.delete(key);
			this._validateColumnsAsync(document).catch(err => {
				this.logger.debug(`Column validation error: ${err}`);
			});
		}, 500);
		this._columnDebounceTimers.set(key, timer);
	}

	private async _validateColumnsAsync(document: vscode.TextDocument): Promise<void> {
		if (!this._startupReady) return;
		if (!this.parseService) return;

		const key = document.uri.toString();
		this._columnCtsSources.get(key)?.cancel();
		const cts = new vscode.CancellationTokenSource();
		this._columnCtsSources.set(key, cts);
		const token = cts.token;

		const model = await this.parseService.getDocumentModel(document);
		const tokens = model?.tokens ?? [];
		if (token.isCancellationRequested) return;

		if (!model) {
			this._columnCollection.delete(document.uri);
			this._updateStatusBar();
			return;
		}

		const diagnostics: vscode.Diagnostic[] = [];
		let firstMiss: string | undefined;
		const docLines = document.getText().split('\n');

		for (const t of tokens) {
			if (t.type !== 'column_ref' || !t.table) continue;

			// Skip column_ref tokens that originated inside a Jinja {{ }} expression.
			// The blanker is length-preserving, so t.col maps to the same offset in
			// the original source. If the original character at that position is '{'
			// the identifier came from a macro call (e.g. {{ my_macro(...) }}) and
			// is not a real column reference.
			const origChar = (docLines[t.line] ?? '')[t.col];
			if (origChar === '{') continue;

			const cols = t.resolvedTableRef ? ParseService.columnsForRef(t.resolvedTableRef, model) : undefined;
			// Skip if: alias unknown, no columns resolved, or list contains '*'
			// (unresolved SELECT * — can't validate without knowing what * expands to)
			if (!cols || cols.length === 0 || cols.includes('*')) continue;

			if (!cols.some(c => c.toLowerCase() === t.name.toLowerCase())) {
				if (!firstMiss) firstMiss = `${t.table}.${t.name} (known: ${cols.slice(0, 3).join(', ')})`;
				const range = new vscode.Range(
					new vscode.Position(t.line, t.col),
					new vscode.Position(t.line, t.endCol),
				);
				const diag = new vscode.Diagnostic(
					range,
					`Column '${t.name}' not found in '${t.table}' (known columns: ${cols.slice(0, 5).join(', ')}${cols.length > 5 ? ', ...' : ''})`,
					vscode.DiagnosticSeverity.Error,
				);
				diag.source = 'dbt';
				diag.code = 'unknown-column';
				diagnostics.push(diag);
			}
		}

		this._columnCollection.set(document.uri, diagnostics);
		this.logger.trace(`[diagnostics] column validation: ${diagnostics.length} issues in ${path.basename(document.fileName)}`);
		this._updateStatusBar();
	}

	private _handleParseOutput(output: string, success: boolean): void {
		const errors = this._parseErrors(output);

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

		// Merge: delete URIs no longer in error, set/update the rest.
		// Avoids a global clear() that causes a visible flash before re-adding.
		const staleParseUris: vscode.Uri[] = [];
		this._parseCollection.forEach((uri) => {
			if (!byFile.has(uri.toString())) staleParseUris.push(uri);
		});
		for (const uri of staleParseUris) this._parseCollection.delete(uri);
		for (const [uriStr, diags] of byFile) {
			this._parseCollection.set(vscode.Uri.parse(uriStr), diags);
		}

		this._updateStatusBar();
		if (errors.length === 0) {
			this.logger.debug(success
				? 'Parse succeeded — no parse diagnostics'
				: 'Parse failed but no extractable diagnostics');
		} else {
			this.logger.info(`Parse failed — ${errors.length} diagnostic(s) created`);
		}
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
		let parseCount = 0, refCount = 0, colCount = 0, sqlglotCount = 0, ninjaCount = 0;
		this._parseCollection.forEach((_, diags) => { parseCount += diags.length; });
		this._refCollection.forEach((_, diags) => { refCount += diags.length; });
		this._columnCollection.forEach((_, diags) => { colCount += diags.length; });
		this._sqlglotCollection.forEach((_, diags) => { sqlglotCount += diags.length; });
		this._ninjaCollection.forEach((_, diags) => { ninjaCount += diags.length; });
		const total = parseCount + refCount + colCount + sqlglotCount + ninjaCount;
		this.logger.trace(`[diagnostics] counts — parse:${parseCount} refs:${refCount} columns:${colCount} sqlglot:${sqlglotCount} ninja:${ninjaCount} total:${total}`);
	}

	clearAll(): void {
		this._parseCollection.clear();
		this._refCollection.clear();
		this._columnCollection.clear();
		this._sqlglotCollection.clear();
		this._sqlfluffCollection.clear();
		this._autoSaveCollection.clear();
		this._formatterCollection.clear();
		this._ninjaCollection.clear();
		this._ninjaResults.clear();
		this._syntaxErrorDimRanges.clear();
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(this._syntaxErrorDim, []);
		}
	}

	dispose(): void {
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		for (const timer of this._columnDebounceTimers.values()) clearTimeout(timer);
		for (const timer of this._ninjaDebounceTimers.values()) clearTimeout(timer);
		for (const cts of this._columnCtsSources.values()) cts.cancel();
		for (const d of this._disposables) d.dispose();
		this._parseCollection.dispose();
		this._refCollection.dispose();
		this._columnCollection.dispose();
		this._sqlglotCollection.dispose();
		this._sqlfluffCollection.dispose();
		this._autoSaveCollection.dispose();
		this._formatterCollection.dispose();
		this._ninjaCollection.dispose();
	}

	private _updateAutoSaveDiagnostic(): void {
		const suppressed = vscode.workspace.getConfiguration('dbt-studio').get<boolean>('notifications.suppressAutoSaveWarning');
		const projectYml = vscode.Uri.file(`${this.projectDir}/dbt_project.yml`);
		const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
		if (suppressed || autoSave === 'off') {
			this._autoSaveCollection.delete(projectYml);
			return;
		}
		const diag = new vscode.Diagnostic(
			new vscode.Range(0, 0, 0, 0),
			'Auto-save is enabled. dbt Studio triggers a dbt parse on every save of a SQL or YAML file — with auto-save on, this can run very frequently and slow things down on larger projects.',
			vscode.DiagnosticSeverity.Warning,
		);
		diag.source = 'dbt-studio';
		diag.code = 'autosave-active';
		this._autoSaveCollection.set(projectYml, [diag]);
	}

	private _updateFormatterDiagnostic(): void {
		const suppressed = vscode.workspace.getConfiguration('dbt-studio').get<boolean>('notifications.suppressFormatterWarning');
		const projectYml = vscode.Uri.file(`${this.projectDir}/dbt_project.yml`);
		const defaultFormatter = vscode.workspace.getConfiguration('editor', { languageId: 'jinja-sql' }).get<string>('defaultFormatter');
		if (suppressed || defaultFormatter === 'nickeolofsson.dbt-studio-vscode') {
			this._formatterCollection.delete(projectYml);
			return;
		}
		const diag = new vscode.Diagnostic(
			new vscode.Range(0, 0, 0, 0),
			'dbt Studio is not set as the default formatter for SQL files. Auto-fix (format on save) will use a different formatter and ninja fixes won\'t be applied automatically.',
			vscode.DiagnosticSeverity.Warning,
		);
		diag.source = 'dbt-studio';
		diag.code = 'formatter-not-set';
		this._formatterCollection.set(projectYml, [diag]);
	}

	private _updateSqlFluffDiagnostic(): void {
		const suppressed = vscode.workspace.getConfiguration('dbt-studio').get<boolean>('notifications.suppressSqlFluffWarning');
		const projectYml = vscode.Uri.file(`${this.projectDir}/dbt_project.yml`);
		if (suppressed || !vscode.extensions.getExtension('dorzey.vscode-sqlfluff')) {
			this._sqlfluffCollection.delete(projectYml);
			return;
		}
		const diag = new vscode.Diagnostic(
			new vscode.Range(0, 0, 0, 0),
			'SQLFluff is active alongside dbt Studio. dbt Studio already provides SQL diagnostics for dbt models — SQLFluff may produce duplicate or conflicting warnings.',
			vscode.DiagnosticSeverity.Warning,
		);
		diag.source = 'dbt-studio';
		diag.code = 'sqlfluff-active';
		this._sqlfluffCollection.set(projectYml, [diag]);
	}

	private _updateSyntaxErrorDim(uri: vscode.Uri, warnings: SqlglotWarning[]): void {
		const syntaxErr = warnings.find(w => w.type === 'syntax_error');
		if (syntaxErr) {
			const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
			if (doc) {
				const errorStart = new vscode.Position(syntaxErr.line ?? 0, syntaxErr.endCol ?? syntaxErr.col ?? 0);
				const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
				this._syntaxErrorDimRanges.set(uri.toString(), new vscode.Range(errorStart, docEnd));
			}
		} else {
			this._syntaxErrorDimRanges.delete(uri.toString());
		}
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.uri.toString() === uri.toString()) {
				const range = this._syntaxErrorDimRanges.get(uri.toString());
				editor.setDecorations(this._syntaxErrorDim, range ? [range] : []);
			}
		}
	}
}


