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
import type { ParseWarning, DocumentModel } from '../services/parse-service';
import { computeCommentRanges, isOffsetInComment } from './common/comment-utils';
import type { CommentRange } from './common/comment-utils';
import { runNinja } from '../ninja/engine';
import type { NinjaResult } from '../ninja/engine';
import { loadConfig } from '../ninja/config-loader';
import { coarseJinjaTokens, coarseJinjaTokensFromText } from '../ftl/sqllens/extract/coarse-jinja';

interface DbtErrorLocation {
	filePath: string;
	line: number;
	message: string;
}

export class EditorDiagnosticsProvider implements vscode.Disposable {
	private readonly _parseCollection: vscode.DiagnosticCollection;
	private readonly _refCollection: vscode.DiagnosticCollection;
	/** Structural SQL warnings from parsing (e.g. Aliases node type from a dangling identifier). */
	private readonly _sqlWarningCollection: vscode.DiagnosticCollection;
	/** Warning shown on dbt_project.yml when SQLFluff is active alongside dbt Anvil. */
	private readonly _sqlfluffCollection: vscode.DiagnosticCollection;
	/** Warning shown on dbt_project.yml when auto-save is enabled (triggers frequent dbt parse). */
	private readonly _autoSaveCollection: vscode.DiagnosticCollection;
	/** Warning shown on dbt_project.yml when dbt Anvil is not the default formatter for jinja-sql. */
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

	constructor(
		service: DbtExecutionService,
		private readonly indexer: ManifestIndexer,
		private readonly statusBar: StatusBarManager,
		private readonly projectDir: string,
		private readonly logger: ILogger,
		private readonly parseService?: ParseService,
		onIndexRebuild?: vscode.Event<{ indexer: ManifestIndexer; pivots: vscode.Uri[] }>,
		onParseWarnings?: vscode.Event<{ uri: vscode.Uri; warnings: ParseWarning[] }>,
		startupReady = true,
	) {
		this._startupReady = startupReady;
		this._parseCollection = vscode.languages.createDiagnosticCollection('dbt-anvil');
		this._refCollection = vscode.languages.createDiagnosticCollection('dbt-anvil-refs');
		this._sqlWarningCollection = vscode.languages.createDiagnosticCollection('dbt-anvil-sql');
		this._sqlfluffCollection = vscode.languages.createDiagnosticCollection('dbt-anvil-sqlfluff');
		this._autoSaveCollection = vscode.languages.createDiagnosticCollection('dbt-anvil-autosave');
		this._formatterCollection = vscode.languages.createDiagnosticCollection('dbt-anvil-formatter');
		this._ninjaCollection = vscode.languages.createDiagnosticCollection('dbt-anvil-ninja');
		this._syntaxErrorDim = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
		this._disposables.push(this._syntaxErrorDim);

		// SQLFluff warning: shown on dbt_project.yml when SQLFluff extension is active.
		// Cleared when the user sets dbt-anvil.notifications.suppressSqlFluffWarning in settings.
		this._updateSqlFluffDiagnostic();
		// Auto-save warning: shown on dbt_project.yml when auto-save is enabled.
		// Cleared when the user sets dbt-anvil.notifications.suppressAutoSaveWarning in settings.
		this._updateAutoSaveDiagnostic();
		// Formatter warning: shown on dbt_project.yml when dbt Anvil is not the default formatter.
		// Cleared when the user sets the formatter or sets dbt-anvil.notifications.suppressFormatterWarning.
		this._updateFormatterDiagnostic();
		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('dbt-anvil.notifications.suppressSqlFluffWarning')) {
					this._updateSqlFluffDiagnostic();
				}
				if (e.affectsConfiguration('dbt-anvil.notifications.suppressAutoSaveWarning') || e.affectsConfiguration('files.autoSave')) {
					this._updateAutoSaveDiagnostic();
				}
				if (e.affectsConfiguration('dbt-anvil.notifications.suppressFormatterWarning') || e.affectsConfiguration('editor.defaultFormatter')) {
					this._updateFormatterDiagnostic();
				}
			}),
			vscode.extensions.onDidChange(() => this._updateSqlFluffDiagnostic()),
		);

		// Parse-based diagnostics
		this._disposables.push(
			service.onJobCompleted(({ job, result }) => {
				if (job.type === 'parse') {
					if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.diagnostics', true)) return;
					// Always scan stderr — dbt parse can return success=true
					// even when there are compilation/syntax errors in models.
					// Also scan stdout — dbt often writes error details there too.
					const combined = [result.stderr, result.stdout].filter(Boolean).join('\n');
					this._handleParseOutput(combined, result.success);
				}
			}),
			service.onJobFailed(({ job, error }) => {
				if (job.type === 'parse') {
					if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.diagnostics', true)) return;
					this._handleParseOutput(error.message, false);
				}
			}),
		);

		// Real-time ref/source validation
		this._disposables.push(
			vscode.workspace.onDidOpenTextDocument((doc) => {
				if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.diagnostics', true)) return;
				void this._validateDocument(doc);
				this._runNinjaDirect(doc);
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.diagnostics', true)) return;
				this._validateDocumentDebounced(e.document);
				this._runNinjaDebounced(e.document);
			}),
			// vscode.workspace.onDidCloseTextDocument((doc) => {
			// 	this._refCollection.delete(doc.uri);
			// 	this._columnCollection.delete(doc.uri);
			// 	this._sqlWarningCollection.delete(doc.uri);
			// 	// Ninja diagnostics are intentionally kept after close — they represent
			// 	// workspace-wide lint results that should remain visible in the Problems panel.
			// 	this._ninjaResults.delete(doc.uri.toString());
			// 	this._syntaxErrorDimRanges.delete(doc.uri.toString());
			// 	this._updateStatusBar();
			// }),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('dbt-anvil.providers.sql.diagnostics')) {
					const enabled = vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.diagnostics', true);
					if (!enabled) {
						this.clearAll();
					} else {
						for (const doc of vscode.workspace.textDocuments) {
							if (doc.languageId !== 'jinja-sql') continue;
							void this._validateDocument(doc);
							this._runNinjaDirect(doc);
						}
					}
				}
				if (e.affectsConfiguration('dbt-anvil.ninja')) {
					this._cachedNinjaConfig = undefined;
					// Re-run ninja on all open SQL documents when ninja settings change
					for (const doc of vscode.workspace.textDocuments) {
						if (doc.languageId !== 'jinja-sql') continue;
						this._runNinjaDebounced(doc);
					}
				}
			}),
		);

		// Re-validate ref/source diagnostics when the manifest index is rebuilt.
		// Without this, stale "unknown ref/source" errors linger until the user edits the file.
		if (onIndexRebuild) {
			this._disposables.push(
				onIndexRebuild(() => {
					this.setStartupReady();
					if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.diagnostics', true)) return;
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
						void this._validateRefsOnly(doc);
						// Re-parse so scope warnings (unknown-column etc.) refresh against the
						// new index — evicted cold entries get a fresh enriched parse, and the
						// onParseWarnings listener above renders whatever comes back.
						if (this.parseService) void this.parseService.getDocumentModel(doc);
					}
					this._updateStatusBar();
				}),
			);
		}

		// Surface parse warnings as diagnostics. These fire on every parse — empty
		// list clears stale diagnostics, non-empty list replaces them.
		// syntax_error → Error (red squiggle, precise token range)
		// scope_warning → Warning (yellow squiggle, CTE line)
		if (onParseWarnings) {
			this._disposables.push(
				onParseWarnings(({ uri, warnings }) => {
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
						diag.source = 'dbt-anvil (sql)';
						diag.code = isSyntaxError ? 'sql-syntax-error' : 'sql-scope-warning';
						return diag;
					});
					this._sqlWarningCollection.set(uri, diagnostics);
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
					this._sqlWarningCollection.delete(uri);
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
			if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.diagnostics', true)) break;
			void this._validateDocument(editor.document);
			this._runNinjaDirect(editor.document);
		}
	}

	setStartupReady(): void {
		if (this._startupReady) return;
		this._startupReady = true;
		this.logger.debug('[diagnostics] startup initialization complete — enabling document diagnostics');

		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.diagnostics', true)) return;
		for (const editor of vscode.window.visibleTextEditors) {
			void this._validateDocument(editor.document);
			this._runNinjaDirect(editor.document);
		}
	}

	// ---- Real-time ref/source validation ----

	private _validateDocumentDebounced(document: vscode.TextDocument): void {
		if (!this._startupReady) return;
		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => { void this._validateDocument(document); }, 250);
	}

	private async _validateDocument(document: vscode.TextDocument): Promise<void> {
		if (!this._startupReady) return;
		if (document.languageId !== 'jinja-sql') return;
		if (!this.indexer.index) return;

		const diagnostics = await this._buildRefSourceDiagnostics(document);
		if (diagnostics === undefined) return;
		this._refCollection.set(document.uri, diagnostics);
		this._updateStatusBar();

		// Kick a (version-cached, inflight-deduped) parse so the onParseWarnings
		// listener refreshes syntax errors AND qualify's scope warnings — the
		// unknown-column surface now comes from the parse itself.
		if (this.parseService) {
			void this.parseService.getDocumentModel(document);
		}
	}

	/** Re-validate only ref/source diagnostics (no column validation). Used by onIndexRebuild. */
	private async _validateRefsOnly(document: vscode.TextDocument): Promise<void> {
		if (document.languageId !== 'jinja-sql') return;
		if (!this.indexer.index) return;

		const diagnostics = await this._buildRefSourceDiagnostics(document);
		if (diagnostics === undefined) return;
		this._refCollection.set(document.uri, diagnostics);
		this.logger.debug(`[diagnostics] ref validation: ${diagnostics.length} issues in ${path.basename(document.fileName)}`);
	}

	/**
	 * Build the unknown-ref / unknown-source diagnostic list for a document.
	 * Returns undefined when no parse model is available (e.g. parseService not
	 * wired or the document failed to parse) — caller leaves the existing
	 * collection in place rather than wiping it with a regex fallback that
	 * couldn't keep up with multi-line tags or jinja conditionals anyway.
	 */
	private async _buildRefSourceDiagnostics(
		document: vscode.TextDocument,
	): Promise<vscode.Diagnostic[] | undefined> {
		if (!this.parseService) return undefined;
		const model = await this.parseService.getDocumentModel(document);
		if (!model) return undefined;

		const text = document.getText();
		const commentRanges = computeCommentRanges(text);
		const diagnostics: vscode.Diagnostic[] = [];
		this._validateRefs(document, model, commentRanges, diagnostics);
		this._validateSources(document, model, commentRanges, diagnostics);
		this._validateFunctions(document, model, commentRanges, diagnostics);
		return diagnostics;
	}

	private _validateFunctions(
		document: vscode.TextDocument,
		model: DocumentModel,
		commentRanges: CommentRange[],
		diagnostics: vscode.Diagnostic[],
	): void {
		for (const fn of model.functions ?? []) {
			const fnOffset = document.offsetAt(new vscode.Position(fn.line, fn.col));
			if (isOffsetInComment(fnOffset, commentRanges)) continue;
			if (this.indexer.findFunctionsByName(fn.name).length > 0) continue;
			const range = fn.nameCol !== undefined && fn.nameEndCol !== undefined
				? new vscode.Range(fn.line, fn.nameCol, fn.line, fn.nameEndCol)
				: new vscode.Range(fn.line, fn.col, fn.line, fn.col + 8);
			const diag = new vscode.Diagnostic(
				range,
				`Function '${fn.name}' not found in dbt manifest`,
				vscode.DiagnosticSeverity.Error,
			);
			diag.source = 'dbt';
			diag.code = 'unknown-function';
			diagnostics.push(diag);
		}
	}

	private _validateRefs(
		document: vscode.TextDocument,
		model: DocumentModel,
		commentRanges: CommentRange[],
		diagnostics: vscode.Diagnostic[],
	): void {
		for (const ref of model.refs) {
			const refOffset = document.offsetAt(new vscode.Position(ref.line, ref.col));
			if (isOffsetInComment(refOffset, commentRanges)) continue;
			const models = this.indexer.findModelsByName(ref.model);
			if (models.length > 0) continue;
			// Prefer the precise model-name span when the extractor recorded it;
			// fall back to the ref() identifier when not (older parses).
			const range = ref.modelCol !== undefined && ref.modelEndCol !== undefined
				? new vscode.Range(ref.line, ref.modelCol, ref.line, ref.modelEndCol)
				: new vscode.Range(ref.line, ref.col, ref.line, ref.col + 3);
			const diag = new vscode.Diagnostic(
				range,
				`Model '${ref.model}' not found in dbt manifest`,
				vscode.DiagnosticSeverity.Error,
			);
			diag.source = 'dbt';
			diag.code = 'unknown-ref';
			diagnostics.push(diag);
		}
	}

	private _validateSources(
		document: vscode.TextDocument,
		model: DocumentModel,
		commentRanges: CommentRange[],
		diagnostics: vscode.Diagnostic[],
	): void {
		const index = this.indexer.index;
		if (!index) return;

		for (const src of model.sources) {
			const srcOffset = document.offsetAt(new vscode.Position(src.line, src.col));
			if (isOffsetInComment(srcOffset, commentRanges)) continue;
			const sourceName = src.sourceName;
			const tableName = src.tableName;

			let found = false;
			for (const indexedSrc of index.sources.values()) {
				if (indexedSrc.sourceName === sourceName && indexedSrc.name === tableName) {
					found = true;
					break;
				}
			}
			if (found) continue;

			// Use the source-name span when recorded, else the source() identifier.
			const range = src.sourceNameCol !== undefined && src.tableNameEndCol !== undefined
				? new vscode.Range(src.line, src.sourceNameCol, src.line, src.tableNameEndCol)
				: new vscode.Range(src.line, src.col, src.line, src.col + 6);
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

	// ---- Ninja linting ----

	private readonly _ninjaDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private _cachedNinjaConfig: ReturnType<typeof loadConfig> | undefined;

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
		if (document.languageId !== 'jinja-sql') return;
		const config = this._cachedNinjaConfig ??= loadConfig();
		if (!config.enabled || !config.diagnostics.enabled) {
			// Either the master switch is off, or diagnostics specifically have
			// been silenced — clear the Problems panel either way. Formatting
			// and code actions remain wired (they consult `config.enabled`
			// independently).
			this._ninjaCollection.delete(document.uri);
			this._ninjaResults.delete(document.uri.toString());
			return;
		}

		const [model, dialectSymbols] = await Promise.all([
			this.parseService ? this.parseService.getDocumentModel(document) : Promise.resolve(null),
			this.parseService ? this.parseService.getDialectSymbols() : Promise.resolve(undefined),
		]);


		// If we can't get a parse result, run layout rules only (no token rules).
		// Coarse tokens group the model's sqllens-fed fine stream; only the
		// no-model path pays for its own templated front-end run.
		const jinjaTokens = model?.jinjaTokens
			? coarseJinjaTokens(model.jinjaTokens, document.getText())
			: coarseJinjaTokensFromText(document.getText());
		const emptyModel: DocumentModel = { ctes: [], refs: [], sources: [], finalColumns: [], timing: { parseMs: 0, totalMs: 0 } };
		const result = runNinja(document, model ?? emptyModel, jinjaTokens, config, dialectSymbols ?? undefined);

		this._ninjaResults.set(document.uri.toString(), result);

		const diagnostics: vscode.Diagnostic[] = [];
		for (const v of result.violations) {
			const sev = result.severityMap.get(v.rule);
			if (sev === undefined) continue; // fix-only: formatter uses it, Problems panel doesn't
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
		// let parseCount = 0, refCount = 0, warningCount = 0, ninjaCount = 0;
		// this._parseCollection.forEach((_, diags) => { parseCount += diags.length; });
		// this._refCollection.forEach((_, diags) => { refCount += diags.length; });
		// this._sqlWarningCollection.forEach((_, diags) => { warningCount += diags.length; });
		// this._ninjaCollection.forEach((_, diags) => { ninjaCount += diags.length; });
		// const total = parseCount + refCount + warningCount + ninjaCount;
		// this.logger.trace(`[diagnostics] counts — parse:${parseCount} refs:${refCount} warnings:${warningCount} ninja:${ninjaCount} total:${total}`);
	}

	clearAll(): void {
		this._parseCollection.clear();
		this._refCollection.clear();
		this._sqlWarningCollection.clear();
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
		for (const timer of this._ninjaDebounceTimers.values()) clearTimeout(timer);
		for (const d of this._disposables) d.dispose();
		this._parseCollection.dispose();
		this._refCollection.dispose();
		this._sqlWarningCollection.dispose();
		this._sqlfluffCollection.dispose();
		this._autoSaveCollection.dispose();
		this._formatterCollection.dispose();
		this._ninjaCollection.dispose();
	}

	private _updateAutoSaveDiagnostic(): void {
		const suppressed = vscode.workspace.getConfiguration('dbt-anvil').get<boolean>('notifications.suppressAutoSaveWarning');
		const projectYml = vscode.Uri.file(`${this.projectDir}/dbt_project.yml`);
		const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
		if (suppressed || autoSave === 'off') {
			this._autoSaveCollection.delete(projectYml);
			return;
		}
		const diag = new vscode.Diagnostic(
			new vscode.Range(0, 0, 0, 0),
			'Auto-save is enabled. dbt Anvil triggers a dbt parse on every save of a SQL or YAML file — with auto-save on, this can run very frequently and slow things down on larger projects.',
			vscode.DiagnosticSeverity.Warning,
		);
		diag.source = 'dbt-anvil';
		diag.code = 'autosave-active';
		this._autoSaveCollection.set(projectYml, [diag]);
	}

	private _updateFormatterDiagnostic(): void {
		const suppressed = vscode.workspace.getConfiguration('dbt-anvil').get<boolean>('notifications.suppressFormatterWarning');
		const projectYml = vscode.Uri.file(`${this.projectDir}/dbt_project.yml`);
		const defaultFormatter = vscode.workspace.getConfiguration('editor', { languageId: 'jinja-sql' }).get<string>('defaultFormatter');
		if (suppressed || defaultFormatter === 'nickeolofsson.dbt-anvil-vscode') {
			this._formatterCollection.delete(projectYml);
			return;
		}
		const diag = new vscode.Diagnostic(
			new vscode.Range(0, 0, 0, 0),
			'dbt Anvil is not set as the default formatter for SQL files. Auto-fix (format on save) will use a different formatter and ninja fixes won\'t be applied automatically.',
			vscode.DiagnosticSeverity.Warning,
		);
		diag.source = 'dbt-anvil';
		diag.code = 'formatter-not-set';
		this._formatterCollection.set(projectYml, [diag]);
	}

	private _updateSqlFluffDiagnostic(): void {
		const suppressed = vscode.workspace.getConfiguration('dbt-anvil').get<boolean>('notifications.suppressSqlFluffWarning');
		const projectYml = vscode.Uri.file(`${this.projectDir}/dbt_project.yml`);
		if (suppressed || !vscode.extensions.getExtension('dorzey.vscode-sqlfluff')) {
			this._sqlfluffCollection.delete(projectYml);
			return;
		}
		const diag = new vscode.Diagnostic(
			new vscode.Range(0, 0, 0, 0),
			'SQLFluff is active alongside dbt Anvil. dbt Anvil already provides SQL diagnostics for dbt models — SQLFluff may produce duplicate or conflicting warnings.',
			vscode.DiagnosticSeverity.Warning,
		);
		diag.source = 'dbt-anvil';
		diag.code = 'sqlfluff-active';
		this._sqlfluffCollection.set(projectYml, [diag]);
	}

	private _updateSyntaxErrorDim(uri: vscode.Uri, warnings: ParseWarning[]): void {
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


