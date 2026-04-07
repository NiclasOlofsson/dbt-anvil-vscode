import * as vscode from 'vscode';
import type { QueryRunner } from './query-runner';
import type { DbtPathResolver } from './dbt-path-resolver';
import type { ILogger } from '../types/logger';
import type { DatabaseProvider, QueryResult } from '../providers/database/database-provider';
import type { BridgeRunner } from './bridge-runner';
import type { CompileCache } from './compile-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { Priority } from './execution-service';
import { splitStatements, findStatementAtOffset } from './statement-splitter';
import { emitDebugSymbols, parseSourceMap } from './debug-symbols';
import type { SourceMap } from './debug-symbols';

interface DapMessage {
	seq: number;
	type: string;
	command?: string;
	arguments?: Record<string, unknown>;
	request_seq?: number;
}

// ── Bridge response types ──

interface DecomposeFrame {
	name: string;
	type: 'cte' | 'select' | 'subquery';
	line: number;
	endLine: number;
}

interface DecomposeClause {
	stage: string;
	sql: string;
	line: number;
	order?: number;
}

interface DecomposeResult {
	success: boolean;
	error?: string;
	frames: DecomposeFrame[];
	clauses: Record<string, DecomposeClause[]>;
	refs: Record<string, string[]>;
}

// ── Cached step result ──

interface StepResult {
	rows: Record<string, unknown>[];
	columns: string[];
	columnTypes?: Record<string, string>;
	totalCount: number;
	executionTimeMs: number;
}

// ── Pipeline event (custom DAP event consumed by DataPipelineProvider) ──

export interface PipelineClauseStep {
	label: string;
	line: number;
	executed: boolean;
	rows: number | undefined;
	isCurrent: boolean;
	/** True when this clause produced more rows than the previous clause — likely a fan-out join. */
	fanOut: boolean;
}

export interface PipelineEventBody {
	frames: DecomposeFrame[];
	refs: Record<string, string[]>;
	currentFrameIndex: number;
	/** Per-frame execution info keyed by frame name. */
	executedFrames: Record<string, { rows: number; executionMs: number }>;
	/**
	 * Clause-level step progress for the current frame.
	 * Only populated when stepping at clause granularity (`line` mode).
	 */
	clauseSteps?: PipelineClauseStep[];
}

// ── Scope/variable reference encoding ──
// We pack frameIndex + scopeKind into a single variablesReference integer.
export const SCOPE_RESULT = 1;
export const SCOPE_IMPACT = 2;
export const SCOPE_QUERY = 3;

export function encodeRef(frameIndex: number, scope: number, _extra = 0): number {
	return ((frameIndex & 0xFFFF) << 16) | ((scope & 0xFF) << 8) | (_extra & 0xFF);
}
export function decodeRef(ref: number): { frameIndex: number; scope: number; extra: number } {
	return {
		frameIndex: (ref >> 16) & 0xFFFF,
		scope: (ref >> 8) & 0xFF,
		extra: ref & 0xFF,
	};
}

/**
 * Build the CTE preamble that defines `__debug_context__`, handling the case where
 * `sql` is itself a WITH query (hoists its CTEs to avoid illegal nested WITH).
 * Caller appends the final `SELECT` clause.
 */
export function buildEvalBaseSql(sql: string): string {
	const trimmed = sql.trimStart();
	if (/^(?:\/\*[^*]*\*\/\s*)*with\s/i.test(trimmed)) {
		const mainPos = findMainSelectPos(trimmed);
		if (mainPos >= 0) {
			const ctesPart = trimmed.slice(0, mainPos).trimEnd().replace(/,$/, '');
			const mainSelect = trimmed.slice(mainPos).trimStart();
			return `${ctesPart},\n__debug_context__ AS (\n${mainSelect}\n)\n`;
		}
	}
	return `WITH __debug_context__ AS (\n${sql}\n)\n`;
}

export function wrapWithDebugCount(sql: string, limit: number): string {
	return `${buildEvalBaseSql(sql)}SELECT *, COUNT(*) OVER () AS __debug_count__ FROM __debug_context__ LIMIT ${limit}`;
}

export function findMainSelectPos(sql: string): number {
	let depth = 0;
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === '(') { depth++; i++; continue; }
		if (ch === ')') { depth--; i++; continue; }
		// Skip string literals to avoid false matches inside quoted strings
		if (ch === '\'' || ch === '"') {
			const q = ch;
			i++;
			while (i < sql.length && sql[i] !== q) {
				if (sql[i] === '\\') i++;
				i++;
			}
			i++;
			continue;
		}
		if (depth === 0 && /^select\b/i.test(sql.slice(i))) {
			return i;
		}
		i++;
	}
	return -1;
}

export function buildScopedSql(expression: string, clauses: Array<{ sql: string }>): string {
	if (clauses.length === 0) return expression;

	const exprTrimmed = expression.trim().toUpperCase();
	if (exprTrimmed.startsWith('SELECT') || exprTrimmed.startsWith('WITH')) {
		return expression;
	}

	const frameSql = clauses[clauses.length - 1].sql;
	return `${buildEvalBaseSql(frameSql)}SELECT ${expression} FROM __debug_context__`;
}

/**
 * Full DAP adapter for SQL CTE debugging.
 *
 * - `noDebug: true` (Ctrl+F5) → fire-and-forget execution (legacy behaviour)
 * - `noDebug: false` (F5) → stepping debugger with CTE/clause frames
 */
export class SqlDebugAdapter implements vscode.DebugAdapter {
	private _seq = 1;
	private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage = this._onDidSendMessage.event;

	// ── Debug state ──
	private _frames: DecomposeFrame[] = [];
	private _clauses: Record<string, DecomposeClause[]> = {};
	private _refs: Record<string, string[]> = {};
	private _currentFrameIndex = 0;
	private _granularity: 'statement' | 'line' = 'statement';
	private _currentClauseIndex = 0;
	/** Navigation history. Every deliberate forward move (F10 advance, F11 enter-clause,
	 *  F11 jump-to-frame) pushes the current position before moving. Step-back pops one
	 *  entry; step-out pops entries until the frame index changes. Cleared on continue. */
	private _navigationHistory: Array<{ frameIndex: number; clauseIndex: number; granularity: 'statement' | 'line' }> = [];
	private _resultCache = new Map<string, StepResult>();
	private _breakpoints: Array<{ line: number; id: number; frameName?: string; clauseIndex?: number }> = [];
	private _nextBpId = 1;
	private _exceptionFilters: Set<string> = new Set();
	private _compiledSql = '';
	private _sourceUri = '';
	private _limit = 50;
	private _scope: 'cursor' | 'all' = 'cursor';
	private _resultLocation: string | undefined;
	private _lineOffset = 0;
	private _paused = true;
	private _noDebug = false;
	private _abortController: AbortController | undefined;
	private _sourceMap: SourceMap | undefined;

	constructor(
		private readonly _queryRunner: QueryRunner,
		private readonly _pathResolver: DbtPathResolver,
		private readonly _logger: ILogger,
		private readonly _databaseProvider: DatabaseProvider,
		private readonly _bridgeRunner: BridgeRunner,
		private readonly _compileCache: CompileCache,
		private readonly _manifestIndexer: ManifestIndexer,
	) {
	}

	handleMessage(message: vscode.DebugProtocolMessage): void {
		const msg = message as unknown as DapMessage;
		this._logger.debug(`DAP ← ${msg.command ?? msg.type} seq=${msg.seq}`);
		this._logger.trace(`DAP ← payload: ${JSON.stringify(msg.arguments ?? '')}`);
		switch (msg.command) {
			case 'initialize': this._handleInitialize(msg); break;
			case 'configurationDone': this._handleConfigurationDone(msg); break;
			case 'launch': this._handleLaunch(msg); break;
			case 'setBreakpoints': this._handleSetBreakpoints(msg); break;
			case 'setFunctionBreakpoints': this._handleSetFunctionBreakpoints(msg); break;
			case 'threads': this._handleThreads(msg); break;
			case 'stackTrace': this._handleStackTrace(msg); break;
			case 'scopes': this._handleScopes(msg); break;
			case 'variables': this._handleVariables(msg); break;
			case 'next': this._handleNext(msg); break;
			case 'stepIn': this._handleStepIn(msg); break;
			case 'stepOut': this._handleStepOut(msg); break;
			case 'stepBack': this._handleStepBack(msg); break;
			case 'continue': this._handleContinue(msg); break;
			case 'restartFrame': void this._handleRestartFrame(msg); break;
			case 'evaluate': void this._handleEvaluate(msg); break;
			case 'completions': void this._handleCompletions(msg); break;
			case 'breakpointLocations': this._handleBreakpointLocations(msg); break;
			case 'stepInTargets': this._handleStepInTargets(msg); break;
			case 'reverseContinue': this._handleReverseContinue(msg); break;
			case 'setExceptionBreakpoints': this._handleSetExceptionBreakpoints(msg); break;
			case 'gotoTargets': this._handleGotoTargets(msg); break;
			case 'goto': void this._handleGoto(msg); break;
			case 'disconnect':
			case 'terminate':
				this._handleTerminate(msg);
				break;
			default:
				this._respond(msg, false, `Unsupported request: ${msg.command}`);
		}
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: initialize
	// ──────────────────────────────────────────────────────────────

	private _handleInitialize(msg: DapMessage): void {
		this._send({
			type: 'response',
			command: 'initialize',
			request_seq: msg.seq,
			success: true,
			body: {
				supportsConfigurationDoneRequest: true,
				supportsTerminateRequest: true,
				supportsBreakpointLocationsRequest: true,
				supportsStepBack: true,
				supportsStepInTargetsRequest: true,
				supportsFunctionBreakpoints: true,
				supportsEvaluateForHovers: true,
				supportsCompletionsRequest: true,
				supportsRestartFrame: true,
				supportsReverseContinue: true,
				supportsGotoTargetsRequest: true,
				supportsExceptionOptions: false,
				exceptionBreakpointFilters: [
					{ filter: 'emptyResult', label: 'Break on empty result', default: false },
					{ filter: 'fanOut', label: 'Break on fan-out', default: false },
				],
			},
		});
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: configurationDone
	// ──────────────────────────────────────────────────────────────

	private _handleConfigurationDone(msg: DapMessage): void {
		this._respond(msg, true);
		if (this._noDebug) return;

		// Start at _main_ (last frame) — the DAG root for stepping.
		// The user will F11 from here; history builds naturally as they step.
		this._currentFrameIndex = this._frames.length - 1;
		this._enterClauseLevel();

		if (this._breakpoints.length > 0) {
			void this._runToContinue();
		} else {
			void this._onLanded('entry');
		}
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: launch
	// ──────────────────────────────────────────────────────────────

	private _handleLaunch(msg: DapMessage): void {
		void this._handleLaunchAsync(msg);
	}

	private async _handleLaunchAsync(msg: DapMessage): Promise<void> {
		const args = msg.arguments ?? {};
		this._noDebug = args.noDebug === true;

		if (this._noDebug) {
			this._respond(msg, true);
			void this._executeLegacyLaunch(args);
		} else {
			try {
				await this._executeDebugSetup(args);
				this._respond(msg, true);
			} catch (err) {
				this._logger.error(`Launch setup failed: ${err}`);
				this._respond(msg, false, String(err));
			}
		}
	}

	private async _executeLegacyLaunch(args: Record<string, unknown>): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'jinja-sql') {
			this._output('No active dbt SQL file.\n');
			this._terminate();
			return;
		}

		this._sourceUri = editor.document.uri.toString();
		const defaultLimit = vscode.workspace.getConfiguration('dbt-studio').get<number>('queryEditor.defaultLimit', 500);
		this._limit = typeof args.limit === 'number' ? args.limit : defaultLimit;
		this._scope = args.scope === 'all' ? 'all' : 'cursor';
		this._resultLocation = typeof args.resultLocation === 'string' ? args.resultLocation : undefined;
		this._lineOffset = typeof args.lineOffset === 'number' ? args.lineOffset : 0;

		this._send({ type: 'event', event: 'thread', body: { threadId: 1, reason: 'started' } });
		await this._runFinalQuery();
		this._terminate();
	}

	private async _executeDebugSetup(args: Record<string, unknown>): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'jinja-sql') {
			this._logger.warn('Debug adapter: no active jinja-sql editor');
			this._output('No active dbt SQL file.\n');
			this._terminate();
			return;
		}

		this._sourceUri = editor.document.uri.toString();
		const defaultLimit = vscode.workspace.getConfiguration('dbt-studio').get<number>('queryEditor.defaultLimit', 500);
		this._limit = typeof args.limit === 'number' ? args.limit : defaultLimit;
		this._scope = args.scope === 'all' ? 'all' : 'cursor';
		this._resultLocation = typeof args.resultLocation === 'string' ? args.resultLocation : undefined;
		this._lineOffset = typeof args.lineOffset === 'number' ? args.lineOffset : 0;

		const fileName = editor.document.fileName;
		const category = this._pathResolver.classifyFile(fileName);
		let sql: string;

		// If the launch config already contains a pre-split SQL string (fired from
		// executeAll with multiple statements), use it directly.
		if (typeof args.sql === 'string') {
			sql = args.sql;
		} else if (category === 'model' || category === 'analysis' || category === 'snapshot') {
			const sourceText = editor.document.getText();
			const symbolResult = await this._compileWithSymbols(sourceText, this._manifestIndexer.index?.adapterType ?? 'duckdb');
			if (!symbolResult) {
				this._logger.warn('Debug adapter: compile failed');
				this._output('Failed to compile. Check dbt output.\n');
				this._terminate();
				return;
			}
			sql = symbolResult.compiledSql;
			this._sourceMap = symbolResult.sourceMap;
		} else {
			// For ad-hoc files, respect scope: debug only the statement under the cursor
			// (same statement Ctrl+F5 would execute), not the whole buffer.
			if (this._scope === 'all') {
				sql = editor.document.getText();
			} else {
				const fullText = editor.document.getText();
				const offset = editor.document.offsetAt(editor.selection.active);
				const stmts = splitStatements(fullText);
				const stmt = findStatementAtOffset(stmts, offset);
				if (!stmt) {
					this._output('No SQL statement found at cursor.\n');
					this._terminate();
					return;
				}
				sql = stmt.sql;
			}
		}

		this._compiledSql = sql;

		const adapterType = this._manifestIndexer.index?.adapterType;
		if (!adapterType) {
			this._logger.warn('Debug adapter: no manifest index — cannot determine adapter type');
			this._output('No dbt manifest found. Run dbt compile first.\n');
			this._terminate();
			return;
		}

		this._output('Decomposing query structure…\n');
		const decomposed = await this._decompose(sql, adapterType);

		if (!decomposed) {
			this._logger.warn('Debug adapter: decompose failed — running query without stepping');
			this._output('Could not parse query structure — running without debugger.\n');
			await this._runFinalQuery();
			this._terminate();
			return;
		}

		this._frames = decomposed.frames;
		this._clauses = decomposed.clauses;
		this._refs = decomposed.refs;

		// Remap frame/clause positions from compiled→source using the source map.
		if (this._sourceMap) {
			this._remapPositions();
		}

		// Shift all line numbers by the statement's offset in the original document.
		if (this._lineOffset > 0) {
			for (const frame of this._frames) {
				frame.line += this._lineOffset;
				frame.endLine += this._lineOffset;
			}
			for (const clauses of Object.values(this._clauses)) {
				for (const clause of clauses) {
					clause.line += this._lineOffset;
				}
			}
		}

		if (this._frames.length === 0) {
			this._logger.warn('Debug adapter: no frames in decomposed query');
			this._output('No frames found in query.\n');
			this._terminate();
			return;
		}

		this._logger.info(`Debug adapter: decomposed into ${this._frames.length} frames`);
		this._output(`Debug: ${this._frames.length} frame(s) — ${this._frames.map(f => f.name).join(', ')}\n`);
		const previewLines = sql.split('\n').slice(0, 5);
		const truncated = sql.split('\n').length > 5;
		this._output(`SQL:\n${previewLines.join('\n')}${truncated ? '\n  …' : ''}\n`);
		this._send({ type: 'event', event: 'initialized' });
		this._send({ type: 'event', event: 'thread', body: { threadId: 1, reason: 'started' } });
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: setBreakpoints
	// ──────────────────────────────────────────────────────────────

	private _handleSetBreakpoints(msg: DapMessage): void {
		const args = msg.arguments ?? {};
		const sourceBreakpoints = (args.breakpoints as Array<{ line: number }>) ?? [];

		this._breakpoints = this._breakpoints.filter(bp => bp.frameName !== undefined);

		const verified: Array<{ id: number; verified: boolean; line: number; message?: string }> = [];

		for (const sbp of sourceBreakpoints) {
			const line = sbp.line - 1;
			const id = this._nextBpId++;
			const matchedFrame = this._frames.find(f => line >= f.line && line <= f.endLine);

			this._breakpoints.push({ line, id });
			verified.push({
				id,
				verified: matchedFrame !== undefined,
				line: sbp.line,
				message: matchedFrame ? `Frame: ${matchedFrame.name}` : 'No matching CTE frame — run dbt compile first',
			});
		}

		this._send({
			type: 'response',
			command: 'setBreakpoints',
			request_seq: msg.seq,
			success: true,
			body: { breakpoints: verified },
		});
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: setFunctionBreakpoints
	// ──────────────────────────────────────────────────────────────

	private _handleSetFunctionBreakpoints(msg: DapMessage): void {
		const args = msg.arguments ?? {};
		const fbps = (args.breakpoints as Array<{ name: string }>) ?? [];

		this._breakpoints = this._breakpoints.filter(bp => bp.frameName === undefined);

		const verified: Array<{ id: number; verified: boolean; message?: string }> = [];

		for (const fbp of fbps) {
			const id = this._nextBpId++;
			const matchedFrame = this._frames.find(f => f.name === fbp.name);

			this._breakpoints.push({ line: matchedFrame?.line ?? -1, id, frameName: fbp.name });
			verified.push({
				id,
				verified: matchedFrame !== undefined,
				message: matchedFrame ? undefined : `CTE "${fbp.name}" not found`,
			});
		}

		this._send({
			type: 'response',
			command: 'setFunctionBreakpoints',
			request_seq: msg.seq,
			success: true,
			body: { breakpoints: verified },
		});
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: breakpointLocations
	// ──────────────────────────────────────────────────────────────

	private _handleBreakpointLocations(msg: DapMessage): void {
		const args = msg.arguments ?? {};
		const startLine = (args.line as number) ?? 1;
		const endLine = (args.endLine as number) ?? startLine;

		const locations: Array<{ line: number }> = [];
		for (const frame of this._frames) {
			const frameLine = frame.line + 1;
			if (frameLine >= startLine && frameLine <= endLine) {
				locations.push({ line: frameLine });
			}
		}

		this._send({
			type: 'response',
			command: 'breakpointLocations',
			request_seq: msg.seq,
			success: true,
			body: { breakpoints: locations },
		});
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: threads
	// ──────────────────────────────────────────────────────────────

	private _handleThreads(msg: DapMessage): void {
		this._send({
			type: 'response',
			command: 'threads',
			request_seq: msg.seq,
			success: true,
			body: { threads: [{ id: 1, name: 'SQL' }] },
		});
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: stackTrace
	// ──────────────────────────────────────────────────────────────

	private _handleStackTrace(msg: DapMessage): void {
		const source = this._sourceUri ? { path: vscode.Uri.parse(this._sourceUri).fsPath } : undefined;

		if (this._granularity === 'line') {
			const frame = this._frames[this._currentFrameIndex];
			const clauses = this._clauses[frame.name] ?? [];
			// VS Code positions the cursor at stackFrames[0]. Clauses are ordered by
			// SQL execution order (FROM→WHERE→GROUP→HAVING→SELECT). Show the current
			// clause at top, then already-executed clauses in reverse execution order
			// (most recent first) — exactly like a real call stack. Future clauses
			// are omitted because they haven't run yet.
			const currentIdx = this._currentClauseIndex ?? 0;
			const ordered = [
				currentIdx,
				...Array.from({ length: currentIdx }, (_, i) => currentIdx - 1 - i),
			];
			const stackFrames: Array<{
				id: number; name: string; source: typeof source;
				line: number; column: number; presentationHint: 'normal' | 'subtle';
			}> = ordered.map(i => ({
				id: encodeRef(this._currentFrameIndex, SCOPE_RESULT, i),
				name: `${frame.name} → ${this._clauseLabel(frame.name, i, clauses)}`,
				source,
				line: clauses[i].line + 1,
				column: 1,
				presentationHint: i === this._currentClauseIndex ? 'normal' as const : 'subtle' as const,
			}));

			// Append actually-executed frames below the clause entries (dimmed).
			for (let i = this._currentFrameIndex - 1; i >= 0; i--) {
				if (!this._resultCache.has(`${this._frames[i].name}:frame`)) continue;
				const prevFrame = this._frames[i];
				const prevClauses = this._clauses[prevFrame.name] ?? [];
				const displayLine = prevClauses.length > 0
					? prevClauses[0].line + 1
					: prevFrame.line + 1;
				stackFrames.push({
					id: encodeRef(i, 0, 0),
					name: prevFrame.name,
					source,
					line: displayLine,
					column: 1,
					presentationHint: 'subtle' as const,
				});
			}

			this._send({
				type: 'response',
				command: 'stackTrace',
				request_seq: msg.seq,
				success: true,
				body: { stackFrames, totalFrames: stackFrames.length },
			});
		} else {
			// Statement-level overview (reached via Step Out). Show current frame
			// first, then actually-executed frames in reverse order.
			const stackFrames: Array<{
				id: number; name: string; source: typeof source;
				line: number; column: number; presentationHint: 'normal' | 'subtle';
			}> = [];

			for (let i = this._currentFrameIndex; i >= 0; i--) {
				if (i !== this._currentFrameIndex && !this._resultCache.has(`${this._frames[i].name}:frame`)) continue;
				const frame = this._frames[i];
				const clauses = this._clauses[frame.name] ?? [];
				const displayLine = clauses.length > 0
					? clauses[0].line + 1
					: frame.line + 1;
				stackFrames.push({
					id: encodeRef(i, 0, 0),
					name: frame.name,
					source,
					line: displayLine,
					column: 1,
					presentationHint: i === this._currentFrameIndex ? 'normal' as const : 'subtle' as const,
				});
			}

			this._send({
				type: 'response',
				command: 'stackTrace',
				request_seq: msg.seq,
				success: true,
				body: { stackFrames, totalFrames: stackFrames.length },
			});
		}
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: scopes
	// ──────────────────────────────────────────────────────────────

	private _handleScopes(msg: DapMessage): void {
		const args = msg.arguments ?? {};
		const rawFrameId = (args.frameId as number) ?? 0;

		// Stack frame IDs are encoded via encodeRef(). Decode to extract the
		// real frame index. For clause entries the scope component is non-zero;
		// for plain frame entries scope === 0 — either way frameIndex is correct.
		const frameIndex = decodeRef(rawFrameId).frameIndex;

		const scopes = [
			{
				name: 'Result',
				variablesReference: encodeRef(frameIndex, SCOPE_RESULT),
				expensive: false,
				presentationHint: 'locals',
			},
			{
				name: 'Impact',
				variablesReference: encodeRef(frameIndex, SCOPE_IMPACT),
				expensive: false,
			},
			{
				name: 'Query',
				variablesReference: encodeRef(frameIndex, SCOPE_QUERY),
				expensive: false,
			},
		];

		this._send({
			type: 'response',
			command: 'scopes',
			request_seq: msg.seq,
			success: true,
			body: { scopes },
		});
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: variables
	// ──────────────────────────────────────────────────────────────

	private _handleVariables(msg: DapMessage): void {
		const args = msg.arguments ?? {};
		const ref = (args.variablesReference as number) ?? 0;
		const { frameIndex, scope } = decodeRef(ref);
		const frame = this._frames[frameIndex];

		if (!frame) {
			this._send({
				type: 'response',
				command: 'variables',
				request_seq: msg.seq,
				success: true,
				body: { variables: [] },
			});
			return;
		}

		const cacheKey = this._cacheKey(frameIndex);
		const cached = this._resultCache.get(cacheKey);

		if (scope === SCOPE_RESULT) {
			if (!cached) {
				this._send({
					type: 'response',
					command: 'variables',
					request_seq: msg.seq,
					success: true,
					body: { variables: [{ name: 'status', value: 'Not yet executed', variablesReference: 0 }] },
				});
				return;
			}

			const variables = cached.columns
				.filter(c => c !== '__debug_count__')
				.map(col => {
					const values = cached.rows.map(r => r[col]);
					const preview = values.slice(0, 5).map(v => v === null ? 'NULL' : String(v)).join(', ');
					const suffix = cached.rows.length > 5 ? ', …' : '';
					return {
						name: col,
						value: `[${preview}${suffix}]`,
						type: cached.columnTypes?.[col] ?? 'unknown',
						variablesReference: 0,
					};
				});

			this._send({
				type: 'response',
				command: 'variables',
				request_seq: msg.seq,
				success: true,
				body: { variables },
			});
		} else if (scope === SCOPE_IMPACT) {
			const variables: Array<{ name: string; value: string; variablesReference: number }> = [];

			if (cached) {
				variables.push({ name: 'rows', value: String(cached.totalCount), variablesReference: 0 });
				variables.push({ name: 'preview_rows', value: String(cached.rows.length), variablesReference: 0 });
				variables.push({ name: 'columns', value: String(cached.columns.filter(c => c !== '__debug_count__').length), variablesReference: 0 });
				variables.push({ name: 'execution_ms', value: String(cached.executionTimeMs), variablesReference: 0 });

				const prevKey = this._cacheKey(frameIndex - 1);
				const prevCached = this._resultCache.get(prevKey);
				if (prevCached) {
					const delta = cached.totalCount - prevCached.totalCount;
					variables.push({ name: 'row_delta', value: `${delta >= 0 ? '+' : ''}${delta}`, variablesReference: 0 });
					if (cached.totalCount > prevCached.totalCount) {
						variables.push({ name: 'fan_out', value: '⚠ true', variablesReference: 0 });
					}
				}
			} else {
				variables.push({ name: 'status', value: 'Not yet executed', variablesReference: 0 });
			}

			this._send({
				type: 'response',
				command: 'variables',
				request_seq: msg.seq,
				success: true,
				body: { variables },
			});
		} else if (scope === SCOPE_QUERY) {
			const sql = this._getStepSql(frameIndex);
			const variables = [
				{ name: 'frame', value: frame.name, variablesReference: 0 },
				{ name: 'type', value: frame.type, variablesReference: 0 },
				{ name: 'sql', value: sql, variablesReference: 0 },
			];

			this._send({
				type: 'response',
				command: 'variables',
				request_seq: msg.seq,
				success: true,
				body: { variables },
			});
		} else {
			this._send({
				type: 'response',
				command: 'variables',
				request_seq: msg.seq,
				success: true,
				body: { variables: [] },
			});
		}
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: stepping
	// ──────────────────────────────────────────────────────────────

	private _enterClauseLevel(): void {
		this._granularity = 'line';
		this._currentClauseIndex = 0;
	}

	private _pushHistory(): void {
		this._navigationHistory.push({
			frameIndex: this._currentFrameIndex,
			clauseIndex: this._currentClauseIndex,
			granularity: this._granularity,
		});
	}

	private _isBreakpointAtCurrentPosition(): boolean {
		const frame = this._frames[this._currentFrameIndex];
		if (!frame) return false;
		for (const bp of this._breakpoints) {
			const inFrame = bp.frameName
				? bp.frameName === frame.name
				: bp.line >= frame.line && bp.line <= frame.endLine;
			if (!inFrame) continue;
			if (this._granularity === 'line') {
				if (bp.frameName) {
					if (this._currentClauseIndex === 0) return true;
				} else {
					const ci = this._resolveClauseIndex(frame.name, bp.line);
					if (ci === this._currentClauseIndex) return true;
				}
			} else {
				return true;
			}
		}
		return false;
	}

	private async _onLanded(reason: string): Promise<boolean> {
		if (this._isBreakpointAtCurrentPosition()) {
			this._paused = true;
			reason = 'breakpoint';
		}
		if (!this._paused) return false;

		const halted = await this._executeCurrentStep();
		if (!halted) this._sendStopped(reason);
		return true;
	}


	private _handleNext(msg: DapMessage): void {
		this._respond(msg, true);

		if (this._stepOver()) {
			void this._onLanded('step');
		} else {
			this._terminate();
		}
	}

	// Core F11 logic: advance one position using step-in semantics.
	// If a FROM/JOIN clause references a local CTE, pushes history and jumps into it.
	// Otherwise advances to the next clause (F10). At the last clause, steps out to
	// the caller and advances past the call site. Returns false when there is nowhere
	// left to go (all frames visited). Does NOT call _onLanded — caller decides.
	private _stepIn(): boolean {
		if (this._granularity === 'statement') {
			const frame = this._frames[this._currentFrameIndex];
			const clauses = this._clauses[frame.name];
			if (clauses && clauses.length > 1) {
				this._pushHistory();
				this._granularity = 'line';
				this._currentClauseIndex = 0;
				return true;
			}
			return this._stepOver();
		}

		// Clause-level: try to step INTO the local CTE referenced by FROM/JOIN.
		const target = this._resolveClauseStepInTarget();
		if (target) {
			const frameIdx = this._frames.findIndex(f => f.name === target);
			if (frameIdx >= 0) {
				this._pushHistory();
				this._currentFrameIndex = frameIdx;
				this._enterClauseLevel();
				return true;
			}
		}

		// Non-steppable clause or external ref — advance like F10.
		return this._stepOver();
	}

	// Advance one position using F10 (step-over) semantics. Within a frame: move to
	// the next clause. At the last clause: step out to the caller's call site and
	// advance past it. Returns false when there is nowhere left to go.
	private _stepOver(): boolean {
		const frame = this._frames[this._currentFrameIndex];
		const clauses = this._clauses[frame.name] ?? [];

		if (this._granularity === 'line' && this._currentClauseIndex < clauses.length - 1) {
			this._pushHistory();
			this._currentClauseIndex++;
			return true;
		}

		// Last clause (or statement level) — step out to caller.
		return this._stepOutAndAdvance();
	}

	// Step out of the current frame and advance one position past the call site
	// in the caller frame. Returns false when there is nowhere left to go.
	private _stepOutAndAdvance(): boolean {
		const currentFrame = this._currentFrameIndex;

		// Find the call site: most recent history entry from a different frame.
		let callerIdx = this._navigationHistory.length - 1;
		while (callerIdx >= 0 && this._navigationHistory[callerIdx].frameIndex === currentFrame) {
			callerIdx--;
		}

		if (callerIdx >= 0) {
			const caller = this._navigationHistory[callerIdx];
			this._navigationHistory.length = callerIdx;
			this._currentFrameIndex = caller.frameIndex;
			this._granularity = caller.granularity;
			this._currentClauseIndex = caller.clauseIndex;

			const callerFrame = this._frames[this._currentFrameIndex];
			const callerClauses = this._clauses[callerFrame.name] ?? [];
			if (this._granularity === 'line' && this._currentClauseIndex < callerClauses.length - 1) {
				this._pushHistory();
				this._currentClauseIndex++;
				return true;
			}
			if (this._currentFrameIndex < this._frames.length - 1) {
				this._pushHistory();
				this._currentFrameIndex++;
				this._enterClauseLevel();
				return true;
			}
			return false;
		}

		// No call site in history — advance sequentially.
		if (this._currentFrameIndex < this._frames.length - 1) {
			this._pushHistory();
			this._currentFrameIndex++;
			this._enterClauseLevel();
			return true;
		}
		return false;
	}

	private _handleStepIn(msg: DapMessage): void {
		this._respond(msg, true);
		const args = msg.arguments ?? {};
		const targetId = args.targetId as number | undefined;

		// Explicit target (from StepInTargets) — jump directly.
		if (targetId !== undefined) {
			const targetName = this._resolveStepInTarget(targetId);
			if (targetName) {
				const frameIdx = this._frames.findIndex(f => f.name === targetName);
				if (frameIdx >= 0) {
					this._pushHistory();
					this._currentFrameIndex = frameIdx;
					this._granularity = 'statement';
					this._currentClauseIndex = 0;
					void this._onLanded('step');
					return;
				}
				void this._tryCrossModelStepIn(targetName);
				return;
			}
		}

		// Try local stepIn. If it can't go deeper (external ref), try cross-model.
		if (this._granularity === 'line') {
			const target = this._resolveClauseStepInTarget();
			if (target && !this._frames.some(f => f.name === target)) {
				void this._tryCrossModelStepIn(target);
				return;
			}
		}

		if (this._stepIn()) {
			void this._onLanded('step');
		} else {
			this._terminate();
		}
	}

	private _handleStepOut(msg: DapMessage): void {
		this._respond(msg, true);

		// Pop history entries while they belong to the current frame — the first entry
		// from a different frame is the call site we jumped from.
		const currentFrame = this._currentFrameIndex;
		while (this._navigationHistory.length > 0 && this._navigationHistory[this._navigationHistory.length - 1].frameIndex === currentFrame) {
			this._navigationHistory.pop();
		}
		if (this._navigationHistory.length > 0) {
			const caller = this._navigationHistory.pop()!;
			this._currentFrameIndex = caller.frameIndex;
			this._granularity = caller.granularity;
			this._currentClauseIndex = caller.clauseIndex;

			// Advance past the call site — the CTE we just left is already executed.
			const callerFrame = this._frames[this._currentFrameIndex];
			const callerClauses = this._clauses[callerFrame.name] ?? [];
			if (this._granularity === 'line' && this._currentClauseIndex < callerClauses.length - 1) {
				this._currentClauseIndex++;
			}

			void this._onLanded('step');
			return;
		}

		// No history — fall back to dropping granularity or terminating.
		if (this._granularity === 'line') {
			this._granularity = 'statement';
			this._currentClauseIndex = 0;
			void this._onLanded('step');
		} else {
			this._terminate();
		}
	}

	private _handleStepBack(msg: DapMessage): void {
		this._respond(msg, true);

		// If there is navigation history, pop one entry and restore that exact position.
		if (this._navigationHistory.length > 0) {
			const prev = this._navigationHistory.pop()!;
			this._currentFrameIndex = prev.frameIndex;
			this._granularity = prev.granularity;
			this._currentClauseIndex = prev.clauseIndex;
			this._sendStopped('step');
			return;
		}

		// No history — sequential backward crawl as fallback.
		if (this._granularity === 'line') {
			if (this._currentClauseIndex > 0) {
				this._currentClauseIndex--;
				this._sendStopped('step');
			} else if (this._currentFrameIndex > 0) {
				// Step back to previous frame's last clause.
				this._currentFrameIndex--;
				const prevFrame = this._frames[this._currentFrameIndex];
				const prevClauses = this._clauses[prevFrame.name] ?? [];
				this._currentClauseIndex = Math.max(0, prevClauses.length - 1);
				this._sendStopped('step');
			} else {
				this._sendStopped('step');
			}
		} else {
			if (this._currentFrameIndex > 0) {
				this._currentFrameIndex--;
				this._sendStopped('step');
			} else {
				this._sendStopped('step');
			}
		}
	}

	private _handleContinue(msg: DapMessage): void {
		this._respond(msg, true);
		void this._runToContinue();
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: restartFrame  (Edit and Continue)
	// ──────────────────────────────────────────────────────────────

	private async _handleRestartFrame(msg: DapMessage): Promise<void> {
		const args = msg.arguments ?? {};
		// frameId is encoded via encodeRef() — decode to get the real frame index.
		const rawFrameId = typeof args.frameId === 'number' ? args.frameId : this._currentFrameIndex;
		const frameIndex = rawFrameId < this._frames.length ? rawFrameId : decodeRef(rawFrameId).frameIndex;
		const restartIndex = Math.max(0, Math.min(frameIndex, this._frames.length - 1));

		this._respond(msg, true);
		this._output(`Restarting from frame "${this._frames[restartIndex]?.name ?? restartIndex}"…\n`);

		// 1. Recompile the full model — dbt always compiles per-model, not per-CTE.
		const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === this._sourceUri)
			?? vscode.window.activeTextEditor;
		if (!editor) {
			this._output('restartFrame: source editor not found.\n');
			this._sendStopped('step');
			return;
		}

		const adapterType = this._manifestIndexer.index?.adapterType ?? 'duckdb';
		const sourceText = editor.document.getText();
		const compileResult = await this._compileWithSymbols(sourceText, adapterType);
		if (!compileResult) {
			this._output('restartFrame: recompile failed — keeping current session.\n');
			this._sendStopped('step');
			return;
		}

		// 2. Re-decompose the fresh compiled SQL.
		const decomposed = await this._decompose(compileResult.compiledSql, adapterType);
		if (!decomposed) {
			this._output('restartFrame: re-decompose failed — keeping current session.\n');
			this._sendStopped('step');
			return;
		}

		// 3. CTE structure check: if frame names or count differ, wipe the entire
		//    cache — downstream cached results are no longer valid.
		const oldNames = this._frames.map(f => f.name);
		const newNames = decomposed.frames.map(f => f.name);
		const structureChanged =
			newNames.length !== oldNames.length ||
			newNames.some((n, i) => n !== oldNames[i]);

		if (structureChanged) {
			this._output('  CTE structure changed — invalidating all cached results.\n');
			this._resultCache.clear();
		} else {
			// 4. Targeted invalidation: evict the restarted frame and all downstream.
			for (let i = restartIndex; i < this._frames.length; i++) {
				const name = this._frames[i].name;
				for (const key of [...this._resultCache.keys()]) {
					if (key.startsWith(`${name}:`)) this._resultCache.delete(key);
				}
			}
		}

		// 5. Adopt the new decomposition and remap positions.
		this._compiledSql = compileResult.compiledSql;
		this._sourceMap = compileResult.sourceMap;
		this._frames = decomposed.frames;
		this._clauses = decomposed.clauses;
		this._refs = decomposed.refs;

		if (this._sourceMap) {
			this._remapPositions();
		}

		if (this._lineOffset > 0) {
			for (const frame of this._frames) {
				frame.line += this._lineOffset;
				frame.endLine += this._lineOffset;
			}
			for (const clauses of Object.values(this._clauses)) {
				for (const clause of clauses) {
					clause.line += this._lineOffset;
				}
			}
		}

		// 6. Re-execute from the restarted frame forward.
		// Clamp restartIndex in case structure changed and the frame count shrank.
		this._currentFrameIndex = Math.min(restartIndex, this._frames.length - 1);
		this._enterClauseLevel();
		await this._onLanded('restart');
	}

	private async _runToContinue(): Promise<void> {
		this._paused = false;
		this._navigationHistory = [];

		// Check the current position first (handles configurationDone starting at frame 0).
		if (await this._onLanded('breakpoint')) return;

		// Walk the DAG using F11 (step-in) semantics — follows refs into local CTEs,
		// building _navigationHistory naturally. This gives a proper call stack.
		while (this._stepIn()) {
			if (await this._onLanded('breakpoint')) return;
		}

		// Walked past the last frame — run final query and terminate.
		await this._runFinalQuery();
		this._terminate();
	}

	private async _runFinalQuery(): Promise<void> {
		const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === this._sourceUri)
			?? vscode.window.activeTextEditor;
		if (!editor) return;
		try {
			// If we already have the compiled/resolved SQL (from debug setup or pre-split launch),
			// run it directly so we don't re-derive or re-compile.
			if (this._compiledSql) {
				await this._queryRunner.executeSql(this._compiledSql, this._limit);
				return;
			}
			const category = this._pathResolver.classifyFile(editor.document.fileName);
			if (category === 'model' || category === 'analysis' || category === 'snapshot') {
				const sql = await this._compileModel(editor.document.fileName);
				if (!sql) return;
				await this._queryRunner.executeSql(sql, this._limit);
			} else {
				await this._queryRunner.executeWithConfig(editor, {
					limit: this._limit,
					scope: this._scope,
					resultLocation: this._resultLocation,
				});
			}
		} catch (err) {
			this._output(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: stepInTargets
	// ──────────────────────────────────────────────────────────────

	private _handleStepInTargets(msg: DapMessage): void {
		const frame = this._frames[this._currentFrameIndex];
		const frameRefs = this._refs[frame.name] ?? [];

		const targets = frameRefs.map((ref, i) => {
			const isLocalCte = this._frames.some(f => f.name === ref);
			return {
				id: i,
				label: isLocalCte ? `CTE: ${ref}` : `ref: ${ref}`,
			};
		});

		this._send({
			type: 'response',
			command: 'stepInTargets',
			request_seq: msg.seq,
			success: true,
			body: { targets },
		});
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: evaluate
	// ──────────────────────────────────────────────────────────────

	private async _handleEvaluate(msg: DapMessage): Promise<void> {
		const args = msg.arguments ?? {};
		const expression = (args.expression as string) ?? '';
		const context = (args.context as string) ?? 'repl';

		// Only execute SQL when the user types into the debug console (repl).
		// Other contexts ('variables', 'hover', 'clipboard', 'watch') are triggered
		// by VS Code internally (e.g. Copy Value, hover tooltips) — for those we
		// just echo the expression back as a plain string so the raw value is returned.
		if (context === 'hover') {
			// Return the current value of the hovered column from the active frame's result.
			const cacheKey = this._cacheKey(this._currentFrameIndex);
			const cached = this._resultCache.get(cacheKey);
			if (cached && cached.columns.includes(expression) && cached.rows.length > 0) {
				const values = cached.rows.map(r => r[expression]);
				const preview = values.slice(0, 5).map(v => v === null ? 'NULL' : String(v)).join(', ');
				const suffix = cached.rows.length > 5 ? ', …' : '';
				const display = `[${preview}${suffix}]`;
				const type = cached.columnTypes?.[expression] ?? 'unknown';
				this._send({
					type: 'response',
					command: 'evaluate',
					request_seq: msg.seq,
					success: true,
					body: { result: display, type, variablesReference: 0 },
				});
				return;
			}
			// Column not in current result — fail gracefully so VS Code shows no tooltip.
			this._respond(msg, false, 'Not available');
			return;
		}

		if (context !== 'repl') {
			this._send({
				type: 'response',
				command: 'evaluate',
				request_seq: msg.seq,
				success: true,
				body: { result: expression, variablesReference: 0 },
			});
			return;
		}

		if (!expression.trim()) {
			this._respond(msg, false, 'Empty expression');
			return;
		}

		const exprTrimmed = expression.trim().toUpperCase();
		if (exprTrimmed.startsWith('SELECT') || exprTrimmed.startsWith('WITH')
			|| exprTrimmed.startsWith('FROM') || exprTrimmed.startsWith('JOIN')
			|| exprTrimmed.startsWith('WHERE') || exprTrimmed.startsWith('GROUP')
			|| exprTrimmed.startsWith('ORDER') || exprTrimmed.startsWith('HAVING')) {
			this._respond(msg, false, 'Not an expression (SQL clause selected)');
			return;
		}

		// Use the frameId from the request to evaluate in the correct CTE context,
		// not necessarily the currently paused frame.
		const frameIndex = typeof args.frameId === 'number'
			? Math.max(0, Math.min(decodeRef(args.frameId).frameIndex, this._frames.length - 1))
			: this._currentFrameIndex;
		const sql = `${buildEvalBaseSql(this._getStepSql(frameIndex))}SELECT ${expression} FROM __debug_context__`;

		try {
			// Pass limit=-1: evalBaseSql embeds no LIMIT so DuckdbProvider would
			// wrap it in a subquery — which breaks WITH queries on DuckDB.
			// Use -1 and rely on the provider to return all rows (capped by its own guard).
			const result = await this._databaseProvider.query(sql, -1, this._abortController?.signal, Priority.User);
			const preview = result.rows.length > 0
				? result.columns.map(c => `${c}: ${result.rows[0][c]}`).join(', ')
				: '(empty)';

			this._send({
				type: 'response',
				command: 'evaluate',
				request_seq: msg.seq,
				success: true,
				body: { result: `${result.rowCount} row(s): ${preview}`, variablesReference: 0 },
			});
		} catch (err) {
			this._send({
				type: 'response',
				command: 'evaluate',
				request_seq: msg.seq,
				success: true,
				body: { result: `Error: ${err instanceof Error ? err.message : String(err)}`, variablesReference: 0 },
			});
		}
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: completions
	// ──────────────────────────────────────────────────────────────

	private async _handleCompletions(msg: DapMessage): Promise<void> {
		const frame = this._frames[this._currentFrameIndex];
		const cacheKey = this._cacheKey(this._currentFrameIndex);
		const cached = this._resultCache.get(cacheKey);

		const targets: Array<{ label: string; type: string }> = [];

		if (cached) {
			for (const col of cached.columns.filter(c => c !== '__debug_count__')) {
				targets.push({ label: col, type: 'field' });
			}
		}

		// Also offer other CTE names as completion targets.
		for (const f of this._frames) {
			if (f !== frame) {
				targets.push({ label: f.name, type: 'function' });
			}
		}

		this._send({
			type: 'response',
			command: 'completions',
			request_seq: msg.seq,
			success: true,
			body: { targets },
		});
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: reverseContinue
	// ──────────────────────────────────────────────────────────────

	private _handleReverseContinue(msg: DapMessage): void {
		this._respond(msg, true);

		if (this._navigationHistory.length === 0) {
			// Already at start — stay put.
			this._sendStopped('step');
			return;
		}

		// Step backwards until we hit a breakpoint or run out of history.
		while (this._navigationHistory.length > 0) {
			const prev = this._navigationHistory[this._navigationHistory.length - 1];
			const prevFrame = this._frames[prev.frameIndex];
			const hitBp = prevFrame && this._breakpoints.some(bp => {
				if (bp.frameName) return bp.frameName === prevFrame.name;
				return bp.line >= prevFrame.line && bp.line <= prevFrame.endLine;
			});

			if (hitBp) {
				const entry = this._navigationHistory.pop()!;
				this._currentFrameIndex = entry.frameIndex;
				this._granularity = entry.granularity;
				this._currentClauseIndex = entry.clauseIndex;
				this._sendStopped('breakpoint');
				return;
			}

			const entry = this._navigationHistory.pop()!;
			this._currentFrameIndex = entry.frameIndex;
			this._granularity = entry.granularity;
			this._currentClauseIndex = entry.clauseIndex;
		}

		// No breakpoint found — stopped at beginning of history.
		this._sendStopped('step');
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: setExceptionBreakpoints
	// ──────────────────────────────────────────────────────────────

	private _handleSetExceptionBreakpoints(msg: DapMessage): void {
		const args = msg.arguments ?? {};
		const filters = (args.filters as string[]) ?? [];
		this._exceptionFilters = new Set(filters);
		this._respond(msg, true);
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: gotoTargets
	// ──────────────────────────────────────────────────────────────

	private _handleGotoTargets(msg: DapMessage): void {
		const source = this._sourceUri ? { path: vscode.Uri.parse(this._sourceUri).fsPath } : undefined;
		const targets = this._frames.map((frame, i) => ({
			id: i,
			label: frame.name,
			line: frame.line + 1,
			endLine: frame.endLine + 1,
			instructionPointerReference: undefined,
			column: 1,
			endColumn: undefined,
			// Include source so VS Code can display context.
			...(source ? { hint: frame.type } : {}),
		}));

		this._send({
			type: 'response',
			command: 'gotoTargets',
			request_seq: msg.seq,
			success: true,
			body: { targets },
		});
	}

	private async _handleGoto(msg: DapMessage): Promise<void> {
		const args = msg.arguments ?? {};
		const targetId = (args.targetId as number) ?? 0;
		const targetIndex = Math.max(0, Math.min(targetId, this._frames.length - 1));

		this._respond(msg, true);

		// Execute any uncached frames between current position and target.
		const from = Math.min(this._currentFrameIndex, targetIndex);
		const to = targetIndex;

		for (let i = from; i <= to; i++) {
			const cacheKey = `${this._frames[i].name}:frame`;
			if (!this._resultCache.has(cacheKey)) {
				const prevGranularity = this._granularity;
				const prevClause = this._currentClauseIndex;
				const prevFrame = this._currentFrameIndex;

				this._currentFrameIndex = i;
				this._granularity = 'statement';
				this._currentClauseIndex = 0;
				if (await this._executeCurrentStep()) return;

				// Restore if we haven't reached target yet.
				if (i < to) {
					this._currentFrameIndex = prevFrame;
					this._granularity = prevGranularity;
					this._currentClauseIndex = prevClause;
				}
			}
		}

		this._currentFrameIndex = targetIndex;
		this._enterClauseLevel();
		void this._onLanded('goto');
	}

	// ──────────────────────────────────────────────────────────────
	// DAP: disconnect / terminate
	// ──────────────────────────────────────────────────────────────

	private _handleTerminate(msg: DapMessage): void {
		this._abortController?.abort();
		this._queryRunner.cancel();
		this._respond(msg, true);
		this._terminate();
	}

	// ──────────────────────────────────────────────────────────────
	// Query execution
	// ──────────────────────────────────────────────────────────────

	private _cacheKey(frameIndex: number): string {
		const frame = this._frames[frameIndex];
		const id = frame ? frame.name : String(frameIndex);
		if (this._granularity === 'line' && frameIndex === this._currentFrameIndex) {
			return `${id}:clause:${this._currentClauseIndex}`;
		}
		return `${id}:frame`;
	}

	private _getStepSql(frameIndex: number): string {
		const frame = this._frames[frameIndex];

		if (this._granularity === 'line' && frameIndex === this._currentFrameIndex) {
			const clauses = this._clauses[frame.name] ?? [];
			const clause = clauses[this._currentClauseIndex];
			if (clause) return clause.sql;
		}

		const clauses = this._clauses[frame.name] ?? [];
		if (clauses.length > 0) {
			return clauses[clauses.length - 1].sql;
		}

		return this._compiledSql;
	}

	/** Execute the current step. Returns `true` if an exception stop was sent (caller must not send another stopped event). */
	private async _executeCurrentStep(): Promise<boolean> {
		const cacheKey = this._cacheKey(this._currentFrameIndex);
		if (this._resultCache.has(cacheKey)) return false;

		const sql = this._getStepSql(this._currentFrameIndex);
		const frame = this._frames[this._currentFrameIndex];
		const debugSql = this._wrapWithDebugCount(sql);

		this._output(`Executing: ${frame.name}${this._granularity === 'line' ? ` → ${this._currentClauseName()}` : ''}…\n`);

		try {
			this._abortController = new AbortController();
			// Pass limit=-1: _wrapWithDebugCount already embeds the LIMIT, so the
			// provider must not add a second wrapping subquery around our SQL.
			const result = await this._databaseProvider.query(debugSql, -1, this._abortController.signal, Priority.User);

			let totalCount = result.rowCount;
			if (result.rows.length > 0 && '__debug_count__' in result.rows[0]) {
				const countVal = result.rows[0].__debug_count__;
				if (typeof countVal === 'number') totalCount = countVal;
				else if (typeof countVal === 'string') totalCount = parseInt(countVal, 10) || result.rowCount;
			}

			const stepResult: StepResult = {
				rows: result.rows,
				columns: result.columns,
				columnTypes: result.columnTypes,
				totalCount,
				executionTimeMs: result.executionTimeMs,
			};

			this._resultCache.set(cacheKey, stepResult);

			const displayCols = result.columns.filter(c => c !== '__debug_count__').length;
			this._output(`  → ${totalCount} total rows, ${displayCols} columns (${result.executionTimeMs}ms)\n`);

			this._sendResultToPanel(frame.name, result);

			// Exception filter checks.
			if (this._exceptionFilters.has('emptyResult') && totalCount === 0) {
				this._output(`  ⚠ Exception: "${frame.name}" returned 0 rows.\n`);
				this._sendStoppedException(`"${frame.name}" returned 0 rows`);
				return true;
			}
			if (this._granularity === 'statement' && this._exceptionFilters.has('fanOut')) {
				const prevFrameKey = this._currentFrameIndex > 0
					? `${this._frames[this._currentFrameIndex - 1].name}:frame`
					: undefined;
				const prev = prevFrameKey ? this._resultCache.get(prevFrameKey) : undefined;
				if (prev && totalCount > prev.totalCount) {
					this._output(`  ⚠ Exception: fan-out in "${frame.name}" (${prev.totalCount} → ${totalCount} rows).\n`);
					this._sendStoppedException(`Fan-out in "${frame.name}": ${prev.totalCount} → ${totalCount} rows`);
					return true;
				}
			}
		} catch (err) {
			this._output(`  Error: ${err instanceof Error ? err.message : String(err)}\n`);
		}
		return false;
	}

	private _wrapWithDebugCount(sql: string): string {
		return wrapWithDebugCount(sql, this._limit);
	}

	private _currentClauseName(): string {
		const frame = this._frames[this._currentFrameIndex];
		const clauses = this._clauses[frame.name] ?? [];
		return clauses[this._currentClauseIndex]?.stage ?? 'unknown';
	}

	// ──────────────────────────────────────────────────────────────
	// Model compilation
	// ──────────────────────────────────────────────────────────────

	private async _compileModel(filePath: string): Promise<string | undefined> {
		const uniqueId = this._manifestIndexer.findModelByFilePath(filePath);
		if (!uniqueId) {
			this._output('Model not found in manifest. Run dbt parse first.\n');
			return undefined;
		}

		const model = this._manifestIndexer.index?.models.get(uniqueId);
		if (!model) return undefined;

		const projectDir = this._manifestIndexer.projectDir;
		const rawNode = this._manifestIndexer.getRawNode(uniqueId) as { original_file_path: string } | undefined;
		if (!rawNode) return undefined;

		this._output(`Compiling ${model.name}…\n`);
		return this._compileCache.ensureCompiled(uniqueId, model.name, projectDir, rawNode.original_file_path);
	}

	// ──────────────────────────────────────────────────────────────
	// Bridge communication
	// ──────────────────────────────────────────────────────────────

	private async _decompose(sql: string, dialect: string): Promise<DecomposeResult | undefined> {
		try {
			const result = await this._bridgeRunner.invokeRaw({
				decompose_query: true,
				compiled_sql: sql,
				dialect,
			});

			if (result.data && result.data.success) {
				return result.data as unknown as DecomposeResult;
			}

			if (result.data?.error) {
				this._output(`Decompose error: ${result.data.error}\n`);
			}
			return undefined;
		} catch (err) {
			this._logger.error(`Bridge decompose_query failed: ${err}`);
			return undefined;
		}
	}

	// ──────────────────────────────────────────────────────────────
	// Source-map compilation
	// ──────────────────────────────────────────────────────────────

	private async _compileWithSymbols(
		sourceText: string,
		dialect: string,
	): Promise<{ compiledSql: string; sourceMap: SourceMap | undefined } | undefined> {
		try {
			const emitResult = await emitDebugSymbols(
				sourceText,
				dialect,
				(req) => this._bridgeRunner.invokeRaw(req),
			);

			if (!emitResult) {
				this._logger.info('Debug adapter: no debug symbols emitted — falling back to plain compile');
				const compiled = await this._bridgeRunner.compileInlineSql(sourceText);
				return { compiledSql: compiled, sourceMap: undefined };
			}

			this._output('Compiling with debug symbols…\n');
			const compiledSql = await this._bridgeRunner.compileInlineSql(emitResult.annotatedSource);
			const sourceMap = parseSourceMap(compiledSql);

			this._logger.info(`Debug adapter: source map has ${sourceMap.mappings.length} mappings`);
			return { compiledSql, sourceMap };
		} catch (err) {
			this._logger.warn(`Debug adapter: compile with symbols failed: ${err}`);
			return undefined;
		}
	}

	private _remapPositions(): void {
		const sm = this._sourceMap;
		if (!sm) return;
		const originalFrameRanges = this._frames.map(f => ({
			name: f.name,
			start: f.line,
			end: f.endLine,
			type: f.type,
		}));

		// First remap clause lines. Clauses are anchored to SQL keywords/tokens that
		// usually carry debug markers, so this is the most reliable source position.
		// If a clause line falls inside a macro span, use the macro's sourceLine.
		for (const clauses of Object.values(this._clauses)) {
			for (const clause of clauses) {
				const macroSpan = sm.isInsideMacro(clause.line);
				if (macroSpan) {
					clause.line = macroSpan.sourceLine;
					continue;
				}
				const sourceLine = sm.compiledLineToSourceLine(clause.line);
				if (sourceLine !== undefined) {
					clause.line = sourceLine;
				}
			}
		}

		// Then remap frame ranges.
		// Primary path: use ALL source-map entries overlapping each frame's compiled
		// range, so frame bounds are derived from real mapped symbols in that frame.
		// This avoids relying on exact boundary-line hits.
		for (const frame of this._frames) {
			const compiledRange = originalFrameRanges.find(r => r.name === frame.name);
			if (compiledRange) {
				const overlaps = sm.mappings.filter(m =>
					m.compiledLine <= compiledRange.end && m.compiledEndLine >= compiledRange.start,
				);
				if (overlaps.length > 0) {
					const minSource = Math.min(...overlaps.map(m => m.sourceLine));
					const maxSource = Math.max(...overlaps.map(m => m.sourceLine));
					frame.line = minSource;
					frame.endLine = Math.max(frame.line, maxSource);
					continue;
				}
			}

			// Fallback: derive from remapped clause lines if available.
			const clauses = this._clauses[frame.name] ?? [];
			if (clauses.length > 0) {
				const clauseLines = clauses.map(c => c.line);
				const minClause = Math.min(...clauseLines);
				const maxClause = Math.max(...clauseLines);

				if (frame.type === 'cte') {
					// Include CTE header and trailing close line around the clause body.
					frame.line = Math.max(0, minClause - 1);
					frame.endLine = Math.max(frame.line, maxClause + 1);
				} else {
					frame.line = minClause;
					frame.endLine = Math.max(frame.line, maxClause);
				}
				continue;
			}

			const start = sm.compiledLineToSourceLine(frame.line);
			const end = sm.compiledLineToSourceLine(frame.endLine);
			if (start !== undefined) frame.line = start;
			if (end !== undefined) frame.endLine = Math.max(frame.line, end);
		}

		// Ensure ordered non-overlapping frame ranges after remap.
		for (let i = 0; i < this._frames.length - 1; i++) {
			const current = this._frames[i];
			const next = this._frames[i + 1];
			if (current.endLine >= next.line) {
				current.endLine = Math.max(current.line, next.line - 1);
			}
		}
	}

	// ──────────────────────────────────────────────────────────────
	// Cross-model stepping
	// ──────────────────────────────────────────────────────────────

	private async _tryCrossModelStepIn(refName: string): Promise<void> {
		const models = this._manifestIndexer.findModelsByName(refName);
		if (models.length === 0) {
			this._output(`Model "${refName}" not found in manifest.\n`);
			this._sendStopped('step');
			return;
		}

		const model = models[0];
		this._output(`Stepping into ref('${refName}') → ${model.path}\n`);

		this._send({
			type: 'request',
			command: 'startDebugging',
			arguments: {
				request: 'launch',
				configuration: {
					type: 'dbt-sql',
					name: `Debug: ${refName}`,
					request: 'launch',
					file: model.path,
					limit: this._limit,
				},
			},
		});
	}

	// ──────────────────────────────────────────────────────────────
	// Breakpoint matching
	// ──────────────────────────────────────────────────────────────

	private _findFirstBreakpointFrame(): number | undefined {
		if (this._breakpoints.length === 0) return undefined;

		for (let i = 0; i < this._frames.length; i++) {
			const frame = this._frames[i];
			const hit = this._breakpoints.find(bp => {
				if (bp.frameName) return bp.frameName === frame.name;
				return bp.line >= frame.line && bp.line <= frame.endLine;
			});
			if (hit) return i;
		}
		return undefined;
	}

	/** Resolve which clause index a breakpoint line maps to within a frame.
	 * Called at hit-time (not at setBreakpoints time) so _clauses is populated. */
	private _resolveClauseIndex(frameName: string, bpLine: number): number | undefined {
		const clauses = this._clauses[frameName] ?? [];
		let bestLine = -1;
		let clauseIndex: number | undefined;
		for (let ci = 0; ci < clauses.length; ci++) {
			if (clauses[ci].line <= bpLine && clauses[ci].line > bestLine) {
				bestLine = clauses[ci].line;
				clauseIndex = ci;
			}
		}
		return clauseIndex;
	}

	/** Display label for a single clause in the call stack.
	 *  FROM/JOIN clauses include the target table name for clarity. */
	private _clauseLabel(
		frameName: string,
		clauseIndex: number,
		clauses: Array<{ stage: string }>,
	): string {
		const clause = clauses[clauseIndex];
		if (!clause) return '';
		if (clause.stage !== 'from' && clause.stage !== 'join') return clause.stage;
		const refs = this._refs[frameName] ?? [];
		const refIndex = clauses
			.slice(0, clauseIndex + 1)
			.filter(c => c.stage === 'from' || c.stage === 'join')
			.length - 1;
		const target = refs[refIndex];
		return target ? `${clause.stage} ${target}` : clause.stage;
	}

	/** Return the table/CTE name targeted by the current FROM or JOIN clause.
	 *  Uses the structured refs list (already extracted by sqlglot) — no regex. */
	private _resolveClauseStepInTarget(): string | undefined {
		const frame = this._frames[this._currentFrameIndex];
		const clauses = this._clauses[frame.name] ?? [];
		const clause = clauses[this._currentClauseIndex];
		if (!clause || (clause.stage !== 'from' && clause.stage !== 'join')) return undefined;

		// _refs lists all FROM/JOIN targets in declaration order (from sqlglot AST).
		// The ref index is the position of this clause among the from/join clauses.
		const refs = this._refs[frame.name] ?? [];
		const refIndex = clauses
			.slice(0, this._currentClauseIndex + 1)
			.filter(c => c.stage === 'from' || c.stage === 'join')
			.length - 1;
		return refs[refIndex];
	}

	private _resolveStepInTarget(targetId: number): string | undefined {
		const frame = this._frames[this._currentFrameIndex];
		const frameRefs = this._refs[frame.name] ?? [];
		return frameRefs[targetId];
	}

	// ──────────────────────────────────────────────────────────────
	// Result panel integration
	// ──────────────────────────────────────────────────────────────

	private _sendResultToPanel(frameName: string, result: QueryResult): void {
		this._send({
			type: 'event',
			event: 'output',
			body: {
				category: 'telemetry',
				output: 'debugStepResult',
				data: {
					frameName,
					columns: result.columns.filter(c => c !== '__debug_count__'),
					rows: result.rows.map(r => {
						const cleaned = { ...r };
						delete cleaned.__debug_count__;
						return cleaned;
					}),
					rowCount: result.rowCount,
					executionTimeMs: result.executionTimeMs,
				},
			},
		});
	}

	// ──────────────────────────────────────────────────────────────
	// Protocol helpers
	// ──────────────────────────────────────────────────────────────

	private _output(text: string): void {
		this._send({ type: 'event', event: 'output', body: { category: 'console', output: text } });
	}

	private _terminate(): void {
		this._send({ type: 'event', event: 'terminated' });
	}

	private _sendStopped(reason: string): void {
		this._send({
			type: 'event',
			event: 'stopped',
			body: { reason, threadId: 1, allThreadsStopped: true },
		});
		this._sendPipelineEvent();
	}

	private _sendStoppedException(description: string): void {
		this._send({
			type: 'event',
			event: 'stopped',
			body: { reason: 'exception', description, threadId: 1, allThreadsStopped: true },
		});
		this._sendPipelineEvent();
	}

	private _sendPipelineEvent(): void {
		// Frames that should appear as "executed" (green) are those whose frame index
		// is the current position OR appears in the navigation history.  Once you step
		// back past a frame it is no longer in the visible forward path.
		const visibleFrameIndices = new Set([
			this._currentFrameIndex,
			...this._navigationHistory.map(h => h.frameIndex),
		]);

		const executedFrames: Record<string, { rows: number; executionMs: number }> = {};
		for (const [key, result] of this._resultCache) {
			// Only include frame-level entries (not clause-level) to avoid noise.
			if (key.includes(':clause:')) continue;
			// Key format is "frameName:frame" — extract the frame name.
			const frameName = key.replace(/:frame$/, '');
			const frameIdx = this._frames.findIndex(f => f.name === frameName);
			if (!visibleFrameIndices.has(frameIdx)) continue;
			executedFrames[frameName] = { rows: result.totalCount, executionMs: result.executionTimeMs };
		}

		// Build clause-step progress for the current frame when stepping at clause granularity.
		let clauseSteps: PipelineClauseStep[] | undefined;
		if (this._granularity === 'line') {
			const frame = this._frames[this._currentFrameIndex];
			if (frame) {
				const frameClauses = this._clauses[frame.name] ?? [];
				clauseSteps = frameClauses.map((clause, idx) => {
					const key = `${frame.name}:clause:${idx}`;
					const result = this._resultCache.get(key);
					const prevResult = idx > 0 ? this._resultCache.get(`${frame.name}:clause:${idx - 1}`) : undefined;
					// A clause is "executed" (green) when the cursor is strictly past it —
					// regardless of whether its result is cached. "Continue" jumps directly
					// to a breakpointed clause without caching the preceding ones, but they
					// are still logically behind us. Row count is shown only when available.
					const executed = idx < this._currentClauseIndex;
					const fanOut = executed
						&& result !== undefined
						&& prevResult !== undefined
						&& result.totalCount > prevResult.totalCount;
					return {
						label: this._clauseLabel(frame.name, idx, frameClauses),
						line: clause.line,
						executed,
						rows: result?.totalCount,
						isCurrent: idx === this._currentClauseIndex,
						fanOut,
					};
				});
			}
		}

		this._send({
			type: 'event',
			event: 'dbt-sql:pipeline',
			body: {
				frames: this._frames,
				refs: this._refs,
				currentFrameIndex: this._currentFrameIndex,
				executedFrames,
				clauseSteps,
			} satisfies PipelineEventBody,
		});
	}

	private _respond(msg: DapMessage, success: boolean, message?: string): void {
		this._send({
			type: 'response',
			command: msg.command ?? 'unknown',
			request_seq: msg.seq,
			success,
			...(message ? { message } : {}),
		});
	}

	private _send(msg: Record<string, unknown>): void {
		msg.seq = this._seq++;
		this._logger.debug(`DAP → ${String(msg.event ?? msg.command ?? msg.type)} seq=${msg.seq}`);
		this._logger.trace(`DAP → payload: ${JSON.stringify(msg.body ?? '')}`);
		this._onDidSendMessage.fire(msg as unknown as vscode.DebugProtocolMessage);
	}

	dispose(): void {
		this._abortController?.abort();
		this._onDidSendMessage.dispose();
	}
}
