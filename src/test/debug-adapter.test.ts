import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	SqlDebugAdapter,
	encodeRef,
	decodeRef,
	wrapWithDebugCount,
	findMainSelectPos,
	buildScopedSql,
	SCOPE_RESULT,
	SCOPE_IMPACT,
	SCOPE_QUERY,
} from '../dbt/debug-adapter';
import type { QueryRunner } from '../dbt/query-runner';
import type { DbtPathResolver } from '../dbt/dbt-path-resolver';
import type { ILogger } from '../types/logger';
import type { DatabaseProvider, QueryResult } from '../providers/database/database-provider';
import type { BridgeRunner, DbtCommandResult } from '../dbt/bridge-runner';
import type { CompileCache } from '../dbt/compile-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';

// ── Helpers ──

interface DapMsg {
	seq: number;
	type: string;
	command?: string;
	event?: string;
	request_seq?: number;
	success?: boolean;
	message?: string;
	body?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
}

// ── Mock factories ──

function mockLogger(): ILogger {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as ILogger;
}

function mockQueryRunner(): QueryRunner {
	return {
		executeSql: vi.fn().mockResolvedValue(undefined),
		executeWithConfig: vi.fn().mockResolvedValue(undefined),
		cancel: vi.fn(),
		runningUri: undefined,
		runningLine: undefined,
	} as unknown as QueryRunner;
}

function mockPathResolver(category = 'other'): DbtPathResolver {
	return {
		classifyFile: vi.fn().mockReturnValue(category),
	} as unknown as DbtPathResolver;
}

const DECOMPOSE_SIMPLE: DbtCommandResult = {
	success: true,
	stdout: '',
	stderr: '',
	data: {
		success: true,
		frames: [
			{ name: 'base', type: 'cte', line: 0, endLine: 3 },
			{ name: '_main_', type: 'select', line: 5, endLine: 8 },
		],
		clauses: {
			base: [
				{ stage: 'from', sql: 'SELECT * FROM raw_orders', line: 1 },
				{ stage: 'select', sql: 'WITH base AS (SELECT id, status FROM raw_orders) SELECT * FROM base', line: 3 },
			],
			_main_: [
				{ stage: 'from', sql: 'SELECT * FROM base', line: 6 },
				{ stage: 'select', sql: 'WITH base AS (...) SELECT * FROM base', line: 8 },
			],
		},
		refs: {
			base: ['raw_orders'],
			_main_: ['base'],
		},
	},
};

function mockBridgeRunner(decomposeResult?: DbtCommandResult): BridgeRunner {
	return {
		invokeRaw: vi.fn().mockImplementation((req: Record<string, unknown>) => {
			if (req.decompose_query) {
				return Promise.resolve(decomposeResult ?? DECOMPOSE_SIMPLE);
			}
			if (req.emit_debug_symbols) {
				return Promise.resolve({
					success: true,
					stdout: '',
					stderr: '',
					data: {
						success: true,
						symbols: [
							{ line: 0, col: 0, endCol: 6, role: 'select' },
							{ line: 0, col: 7, endCol: 9, role: 'ident' },
						],
					},
				});
			}
			return Promise.resolve({ success: true, stdout: '', stderr: '', data: {} });
		}),
		compileInlineSql: vi.fn().mockResolvedValue('SELECT id FROM orders'),
	} as unknown as BridgeRunner;
}

function mockDatabaseProvider(): DatabaseProvider {
	const result: QueryResult = {
		columns: ['id', 'status', '__debug_count__'],
		rows: [
			{ id: 1, status: 'active', __debug_count__: 42 },
			{ id: 2, status: 'inactive', __debug_count__: 42 },
		],
		rowCount: 2,
		executionTimeMs: 15,
	};
	return {
		adapterType: 'duckdb',
		query: vi.fn().mockResolvedValue(result),
	} as unknown as DatabaseProvider;
}

function mockCompileCache(): CompileCache {
	return {
		ensureCompiled: vi.fn().mockResolvedValue('SELECT id, status FROM raw_orders'),
	} as unknown as CompileCache;
}

function mockManifestIndexer(): ManifestIndexer {
	return {
		index: {
			adapterType: 'duckdb',
			models: new Map([['model.jaffle.orders', { name: 'orders', path: '/models/orders.sql' }]]),
		},
		projectDir: '/project',
		findModelByFilePath: vi.fn().mockReturnValue('model.jaffle.orders'),
		findModelsByName: vi.fn().mockReturnValue([{ name: 'orders', path: '/models/orders.sql' }]),
		getRawNode: vi.fn().mockReturnValue({ original_file_path: 'models/orders.sql' }),
	} as unknown as ManifestIndexer;
}

// ── DapHarness ──

class DapHarness {
	readonly adapter: SqlDebugAdapter;
	readonly messages: DapMsg[] = [];
	private _seq = 1;

	constructor(opts?: {
		queryRunner?: QueryRunner;
		pathResolver?: DbtPathResolver;
		logger?: ILogger;
		databaseProvider?: DatabaseProvider;
		bridgeRunner?: BridgeRunner;
		compileCache?: CompileCache;
		manifestIndexer?: ManifestIndexer;
	}) {
		this.adapter = new SqlDebugAdapter(
			opts?.queryRunner ?? mockQueryRunner(),
			opts?.pathResolver ?? mockPathResolver(),
			opts?.logger ?? mockLogger(),
			opts?.databaseProvider ?? mockDatabaseProvider(),
			opts?.bridgeRunner ?? mockBridgeRunner(),
			opts?.compileCache ?? mockCompileCache(),
			opts?.manifestIndexer ?? mockManifestIndexer(),
		);
		this.adapter.onDidSendMessage((msg) => {
			this.messages.push(msg as unknown as DapMsg);
		});
	}

	send(command: string, args?: Record<string, unknown>): void {
		const msg = {
			seq: this._seq++,
			type: 'request',
			command,
			arguments: args,
		};
		this.adapter.handleMessage(msg as unknown as vscode.DebugProtocolMessage);
	}

	responses(command?: string): DapMsg[] {
		const resp = this.messages.filter(m => m.type === 'response');
		return command ? resp.filter(m => m.command === command) : resp;
	}

	events(name?: string): DapMsg[] {
		const evts = this.messages.filter(m => m.type === 'event');
		return name ? evts.filter(m => m.event === name) : evts;
	}

	lastResponse(command: string): DapMsg {
		const r = this.responses(command);
		return r[r.length - 1];
	}

	clear(): void {
		this.messages.length = 0;
	}

	dispose(): void {
		this.adapter.dispose();
	}
}

// ── Fake editor helper ──

function setActiveEditor(text: string, fileName = '/models/orders.sql', languageId = 'jinja-sql'): void {
	const uri = vscode.Uri.file(fileName);
	const lines = text.split('\n');
	(vscode.window as Record<string, unknown>).activeTextEditor = {
		document: {
			uri,
			fileName,
			languageId,
			getText: () => text,
			lineAt: (line: number) => ({ text: lines[line] ?? '' }),
			offsetAt: () => 0,
		},
		selection: {
			active: new vscode.Position(0, 0),
			anchor: new vscode.Position(0, 0),
			start: new vscode.Position(0, 0),
			end: new vscode.Position(0, 0),
			isEmpty: true,
			isReversed: false,
			isSingleLine: true,
		},
	} as unknown as vscode.TextEditor;
}

function clearActiveEditor(): void {
	(vscode.window as Record<string, unknown>).activeTextEditor = undefined;
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

describe('standalone utilities', () => {
	describe('encodeRef / decodeRef', () => {
		it('roundtrips frame index and scope', () => {
			const ref = encodeRef(5, SCOPE_RESULT);
			const { frameIndex, scope, extra } = decodeRef(ref);
			expect(frameIndex).toBe(5);
			expect(scope).toBe(SCOPE_RESULT);
			expect(extra).toBe(0);
		});

		it('roundtrips with extra', () => {
			const ref = encodeRef(2, SCOPE_IMPACT, 7);
			const d = decodeRef(ref);
			expect(d.frameIndex).toBe(2);
			expect(d.scope).toBe(SCOPE_IMPACT);
			expect(d.extra).toBe(7);
		});

		it('handles zero values', () => {
			const ref = encodeRef(0, 0, 0);
			const d = decodeRef(ref);
			expect(d.frameIndex).toBe(0);
			expect(d.scope).toBe(0);
			expect(d.extra).toBe(0);
		});

		it('handles max frame index', () => {
			const ref = encodeRef(0xFFFF, SCOPE_QUERY, 0xFF);
			const d = decodeRef(ref);
			expect(d.frameIndex).toBe(0xFFFF);
			expect(d.scope).toBe(SCOPE_QUERY);
			expect(d.extra).toBe(0xFF);
		});
	});

	describe('findMainSelectPos', () => {
		it('finds top-level SELECT in WITH query', () => {
			const sql = 'WITH a AS (SELECT 1) SELECT * FROM a';
			expect(findMainSelectPos(sql)).toBe(21);
		});

		it('returns -1 for plain SELECT', () => {
			expect(findMainSelectPos('SELECT 1')).toBe(0);
		});

		it('skips SELECT inside parentheses', () => {
			const sql = 'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a';
			const pos = findMainSelectPos(sql);
			expect(sql.slice(pos)).toMatch(/^SELECT \* FROM a$/);
		});

		it('skips SELECT inside string literals', () => {
			const sql = 'WITH a AS (SELECT \'SELECT\') SELECT * FROM a';
			const pos = findMainSelectPos(sql);
			expect(sql.slice(pos)).toMatch(/^SELECT \* FROM a$/);
		});
	});

	describe('wrapWithDebugCount', () => {
		it('wraps plain SELECT as subquery', () => {
			const result = wrapWithDebugCount('SELECT 1', 100);
			expect(result).toContain('__debug_wrapper__');
			expect(result).toContain('LIMIT 100');
			expect(result).toContain('__debug_count__');
		});

		it('wraps CTE query using extra CTE', () => {
			const result = wrapWithDebugCount('WITH a AS (SELECT 1) SELECT * FROM a', 50);
			expect(result).toContain('__debug_inner__');
			expect(result).not.toContain('__debug_wrapper__');
			expect(result).toContain('LIMIT 50');
		});
	});

	describe('buildScopedSql', () => {
		it('returns expression unchanged when no clauses', () => {
			expect(buildScopedSql('count(*)', [])).toBe('count(*)');
		});

		it('wraps expression with debug context CTE', () => {
			const result = buildScopedSql('count(*)', [{ sql: 'SELECT 1 AS x' }]);
			expect(result).toContain('__debug_context__');
			expect(result).toContain('count(*)');
		});

		it('returns full SELECT unchanged', () => {
			const result = buildScopedSql('SELECT 1', [{ sql: 'SELECT 1 AS x' }]);
			expect(result).toBe('SELECT 1');
		});

		it('returns full WITH query unchanged', () => {
			const result = buildScopedSql('WITH a AS (SELECT 1) SELECT * FROM a', [{ sql: 'SELECT 1' }]);
			expect(result).toBe('WITH a AS (SELECT 1) SELECT * FROM a');
		});
	});
});

describe('SqlDebugAdapter', () => {
	let harness: DapHarness;

	afterEach(() => {
		harness?.dispose();
		clearActiveEditor();
	});

	// ──────────────────────────────────────────────────────────────
	// Initialize + capabilities
	// ──────────────────────────────────────────────────────────────

	describe('initialize', () => {
		it('responds with capabilities and fires initialized event after setup', async () => {
			setActiveEditor('SELECT 1');
			harness = new DapHarness();
			harness.send('initialize');

			const resp = harness.lastResponse('initialize');
			expect(resp.success).toBe(true);
			expect(resp.body).toMatchObject({
				supportsConfigurationDoneRequest: true,
				supportsStepBack: true,
				supportsFunctionBreakpoints: true,
				supportsBreakpointLocationsRequest: true,
				supportsStepInTargetsRequest: true,
				supportsTerminateRequest: true,
			});

			// initialized event fires after setup completes (triggered by launch)
			harness.send('launch', { noDebug: false, sql: 'SELECT 1' });
			await vi.waitFor(() => {
				expect(harness.events('initialized')).toHaveLength(1);
			});
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Launch
	// ──────────────────────────────────────────────────────────────

	describe('launch', () => {
		it('responds successfully for debug mode', async () => {
			setActiveEditor('SELECT 1 FROM t');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'SELECT 1 FROM t' });

			await vi.waitFor(() => {
				const resp = harness.lastResponse('launch');
				expect(resp).toBeDefined();
				expect(resp.success).toBe(true);
			});
		});

		it('terminates when no active editor', async () => {
			clearActiveEditor();
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false });

			// Wait for async setup to complete
			await vi.waitFor(() => {
				expect(harness.events('terminated')).toHaveLength(1);
			});
		});

		it('terminates when editor is not jinja-sql', async () => {
			setActiveEditor('SELECT 1', '/file.sql', 'sql');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false });

			await vi.waitFor(() => {
				expect(harness.events('terminated')).toHaveLength(1);
			});
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Debug setup with ad-hoc SQL
	// ──────────────────────────────────────────────────────────────

	describe('debug setup (ad-hoc SQL via args.sql)', () => {
		beforeEach(() => {
			setActiveEditor('SELECT id, status FROM orders');
			harness = new DapHarness();
			harness.send('initialize');
			harness.clear();
		});

		it('decomposes SQL and reports frames', async () => {
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			const threadEvt = harness.events('thread')[0];
			expect(threadEvt.body).toMatchObject({ threadId: 1, reason: 'started' });
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Breakpoints
	// ──────────────────────────────────────────────────────────────

	describe('setBreakpoints', () => {
		beforeEach(async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});
			harness.clear();
		});

		it('verifies breakpoints inside frame ranges', async () => {
			harness.send('setBreakpoints', {
				source: { path: '/models/orders.sql' },
				breakpoints: [{ line: 1 }], // 0-based line 0 is inside base frame (line 0..3)
			});

			await vi.waitFor(() => {
				const resp = harness.lastResponse('setBreakpoints');
				expect(resp).toBeDefined();
				expect(resp.success).toBe(true);
				const bps = (resp.body as Record<string, unknown>).breakpoints as Array<{ verified: boolean }>;
				expect(bps[0].verified).toBe(true);
			});
		});

		it('marks breakpoints outside frames as unverified', async () => {
			harness.send('setBreakpoints', {
				source: { path: '/models/orders.sql' },
				breakpoints: [{ line: 100 }], // way outside frame ranges
			});

			await vi.waitFor(() => {
				const resp = harness.lastResponse('setBreakpoints');
				expect(resp).toBeDefined();
				const bps = (resp.body as Record<string, unknown>).breakpoints as Array<{ verified: boolean }>;
				expect(bps[0].verified).toBe(false);
			});
		});
	});

	describe('setFunctionBreakpoints', () => {
		beforeEach(async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});
			harness.clear();
		});

		it('verifies function breakpoints matching CTE names', async () => {
			harness.send('setFunctionBreakpoints', {
				breakpoints: [{ name: 'base' }],
			});

			await vi.waitFor(() => {
				const resp = harness.lastResponse('setFunctionBreakpoints');
				expect(resp).toBeDefined();
				expect(resp.success).toBe(true);
				const bps = (resp.body as Record<string, unknown>).breakpoints as Array<{ verified: boolean }>;
				expect(bps[0].verified).toBe(true);
			});
		});

		it('marks unknown CTE names as unverified', async () => {
			harness.send('setFunctionBreakpoints', {
				breakpoints: [{ name: 'nonexistent' }],
			});

			await vi.waitFor(() => {
				const resp = harness.lastResponse('setFunctionBreakpoints');
				expect(resp).toBeDefined();
				const bps = (resp.body as Record<string, unknown>).breakpoints as Array<{ verified: boolean }>;
				expect(bps[0].verified).toBe(false);
			});
		});
	});

	describe('breakpointLocations', () => {
		beforeEach(async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});
			harness.clear();
		});

		it('returns frame start lines as breakpoint locations', async () => {
			harness.send('breakpointLocations', { line: 1, endLine: 10 });

			await vi.waitFor(() => {
				const resp = harness.lastResponse('breakpointLocations');
				expect(resp).toBeDefined();
				expect(resp.success).toBe(true);
				const locations = (resp.body as Record<string, unknown>).breakpoints as Array<{ line: number }>;
				expect(locations.length).toBeGreaterThan(0);
			});
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Threading
	// ──────────────────────────────────────────────────────────────

	describe('threads', () => {
		it('returns single SQL thread', () => {
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('threads');

			const resp = harness.lastResponse('threads');
			expect(resp.success).toBe(true);
			const threads = (resp.body as Record<string, unknown>).threads as Array<{ id: number; name: string }>;
			expect(threads).toEqual([{ id: 1, name: 'SQL' }]);
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Stack trace
	// ──────────────────────────────────────────────────────────────

	describe('stackTrace', () => {
		beforeEach(async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});
			harness.clear();
		});

		it('returns stack frames with clause-level detail (current clause first, backwards)', async () => {
			// configurationDone triggers execution and stopped event
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });

			const resp = harness.lastResponse('stackTrace');
			expect(resp.success).toBe(true);
			const frames = (resp.body as Record<string, unknown>).stackFrames as Array<{ name: string; presentationHint: string }>;
			// Entry auto-enters clause-level for _main_ — first clause shown
			expect(frames[0].name).toContain('_main_ \u2192');
			expect(frames[0].presentationHint).toBe('normal');
			// base was never executed (just F5, no stepping) — must NOT appear as dimmed
			const dimmedFrame = frames.find(f => f.name === 'base');
			expect(dimmedFrame).toBeUndefined();
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Scopes
	// ──────────────────────────────────────────────────────────────

	describe('scopes', () => {
		it('returns three scopes', async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('scopes', { frameId: 1 });

			const resp = harness.lastResponse('scopes');
			expect(resp.success).toBe(true);
			const scopes = (resp.body as Record<string, unknown>).scopes as Array<{ name: string }>;
			expect(scopes.map(s => s.name)).toEqual(['Result', 'Impact', 'Query']);
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Variables
	// ──────────────────────────────────────────────────────────────

	describe('variables', () => {
		let dbProvider: DatabaseProvider;

		beforeEach(async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			dbProvider = mockDatabaseProvider();
			harness = new DapHarness({ databaseProvider: dbProvider });
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});
		});

		it('returns "Not yet executed" for uncached frame', () => {
			// Frame 0 not executed yet — request variables for it
			const ref = encodeRef(0, SCOPE_RESULT);
			harness.send('variables', { variablesReference: ref });

			const resp = harness.lastResponse('variables');
			const vars = (resp.body as Record<string, unknown>).variables as Array<{ name: string; value: string }>;
			expect(vars).toEqual([{ name: 'status', value: 'Not yet executed', variablesReference: 0 }]);
		});

		it('returns column previews after execution', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// The current frame should be cached now — request Result scope
			const ref = encodeRef(1, SCOPE_RESULT);
			harness.send('variables', { variablesReference: ref });

			const resp = harness.lastResponse('variables');
			const vars = (resp.body as Record<string, unknown>).variables as Array<{ name: string; value: string }>;
			const colNames = vars.map(v => v.name);
			expect(colNames).toContain('id');
			expect(colNames).toContain('status');
			expect(colNames).not.toContain('__debug_count__');
		});

		it('returns impact variables with row count', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			const ref = encodeRef(1, SCOPE_IMPACT);
			harness.send('variables', { variablesReference: ref });

			const resp = harness.lastResponse('variables');
			const vars = (resp.body as Record<string, unknown>).variables as Array<{ name: string; value: string }>;
			const rowVar = vars.find(v => v.name === 'rows');
			expect(rowVar).toBeDefined();
			expect(rowVar!.value).toBe('42');
		});

		it('returns query variables with frame info', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			const ref = encodeRef(1, SCOPE_QUERY);
			harness.send('variables', { variablesReference: ref });

			const resp = harness.lastResponse('variables');
			const vars = (resp.body as Record<string, unknown>).variables as Array<{ name: string; value: string }>;
			expect(vars.find(v => v.name === 'frame')?.value).toBe('_main_');
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Stepping (statement granularity)
	// ──────────────────────────────────────────────────────────────

	describe('stepping (statement)', () => {
		beforeEach(async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});
		});

		it('configurationDone stops at last frame when no breakpoints', async () => {
			harness.send('configurationDone');

			await vi.waitFor(() => {
				const stopped = harness.events('stopped');
				expect(stopped).toHaveLength(1);
				expect(stopped[0].body?.reason).toBe('entry');
			});
		});

		it('next past last clause of last frame terminates', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Entry is at clause 0 of _main_. Advance through all remaining clauses.
			const clauseCount = (harness.adapter as unknown as { _clauses: Record<string, unknown[]> })._clauses._main_.length;
			for (let i = 1; i < clauseCount; i++) {
				harness.clear();
				harness.send('next', { threadId: 1 });
				await vi.waitFor(() => {
					expect(harness.events('stopped')).toHaveLength(1);
				});
			}

			// One more next should terminate (past last clause of last frame)
			harness.clear();
			harness.send('next', { threadId: 1 });

			await vi.waitFor(() => {
				expect(harness.events('terminated')).toHaveLength(1);
			});
		});

		it('stepBack goes to previous frame last clause', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// We're at clause 0 of _main_. Step back should go to base's last clause.
			harness.clear();
			harness.send('stepBack', { threadId: 1 });

			await vi.waitFor(() => {
				const stopped = harness.events('stopped');
				expect(stopped).toHaveLength(1);
				expect(stopped[0].body?.reason).toBe('step');
			});

			// Verify stack trace now shows base's last clause
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const resp = harness.lastResponse('stackTrace');
			const frames = (resp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(frames[0].name).toContain('base \u2192');
		});

		it('stepOut from clause-level returns to statement, then stepOut terminates', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Entry is at clause-level. StepOut returns to statement-level.
			harness.clear();
			harness.send('stepOut', { threadId: 1 });

			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Now at statement-level for _main_. StepOut should terminate.
			harness.clear();
			harness.send('stepOut', { threadId: 1 });

			await vi.waitFor(() => {
				expect(harness.events('terminated')).toHaveLength(1);
			});
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Stepping (line/clause granularity)
	// ──────────────────────────────────────────────────────────────

	describe('stepping (line/clause)', () => {
		beforeEach(async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});
		});

		it('stepIn switches to line granularity and starts at clause 0', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Step back to get to a frame with multiple clauses (frame 0 = base has 2 clauses)
			harness.clear();
			harness.send('stepBack', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// stepIn should enter clause-level granularity
			harness.clear();
			harness.send('stepIn', { threadId: 1 });

			await vi.waitFor(() => {
				const stopped = harness.events('stopped');
				expect(stopped).toHaveLength(1);
			});

			// Stack trace should show clause-level frames
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const resp = harness.lastResponse('stackTrace');
			const frames = (resp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(frames[0].name).toContain('→');
		});

		it('stepIn on FROM clause jumps to the referenced CTE frame', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Entry lands at _main_ → from (clause 0). F11 should jump into `base`.
			harness.clear();
			harness.send('stepIn', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const resp = harness.lastResponse('stackTrace');
			const frames = (resp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			// Should now be inside the `base` CTE frame at clause-level
			expect(frames[0].name).toContain('base \u2192');
		});

		it('stepOut after stepIn returns to the caller frame and clause', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Entry is at _main_ → from base (clause 0). Confirm the clause label.
			harness.send('stackTrace', { threadId: 1 });
			const entryFrames = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(entryFrames[0].name).toContain('from base');

			// F11 into `base`.
			harness.clear();
			harness.send('stepIn', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Confirm we're inside base.
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const inBase = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(inBase[0].name).toContain('base \u2192');

			// stepOut should return to _main_ at the SAME clause we came from (from base).
			harness.clear();
			harness.send('stepOut', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const backInMain = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			// Must be back on the exact same clause — "from base", not clause 0 by accident
			expect(backInMain[0].name).toContain('_main_ \u2192');
			expect(backInMain[0].name).toContain('from base');
		});

		it('stepOut from line granularity returns to statement when no history', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => { expect(harness.events('stopped')).toHaveLength(1); });

			// configurationDone puts us at _main_, line granularity, history empty.
			// stepOut with no history → drops to statement granularity.
			harness.clear();
			harness.send('stepOut', { threadId: 1 });

			await vi.waitFor(() => {
				const stopped = harness.events('stopped');
				expect(stopped).toHaveLength(1);
			});

			// Stack trace should show frame names without arrow (statement granularity).
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const resp = harness.lastResponse('stackTrace');
			const frames = (resp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(frames[0].name).not.toContain('→');
		});

		it('stepBack after stepIn returns to the pre-stepIn position via history', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => { expect(harness.events('stopped')).toHaveLength(1); });

			// Entry: _main_, line, clause 0 (from base). F11 → pushes history, jumps to base.
			harness.clear();
			harness.send('stepIn', { threadId: 1 });
			await vi.waitFor(() => { expect(harness.events('stopped')).toHaveLength(1); });

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const inBase = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(inBase[0].name).toContain('base \u2192');

			// Step-back pops the history entry → restores _main_, line, clause 0 (from base).
			harness.clear();
			harness.send('stepBack', { threadId: 1 });
			await vi.waitFor(() => { expect(harness.events('stopped')).toHaveLength(1); });

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const afterBack = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(afterBack[0].name).toContain('_main_ \u2192');
			expect(afterBack[0].name).toContain('from base');

			// History is now empty. stepOut falls back to: drop line → statement.
			harness.clear();
			harness.send('stepOut', { threadId: 1 });
			await vi.waitFor(() => { expect(harness.events('stopped')).toHaveLength(1); });

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const afterOut = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(afterOut[0].name).not.toContain('\u2192');
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Continue + breakpoint hit
	// ──────────────────────────────────────────────────────────────

	describe('continue', () => {
		it('runs to breakpoint and stops', async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			// Set a breakpoint in the _main_ frame (line 6, 1-based = 7)
			harness.send('setBreakpoints', {
				source: { path: '/models/orders.sql' },
				breakpoints: [{ line: 7 }],
			});
			await vi.waitFor(() => {
				expect(harness.responses('setBreakpoints')).toHaveLength(1);
			});

			// configurationDone should run to the breakpoint
			harness.clear();
			harness.send('configurationDone');

			await vi.waitFor(() => {
				const stopped = harness.events('stopped');
				expect(stopped.length).toBeGreaterThan(0);
				expect(stopped[0].body?.reason).toBe('breakpoint');
			});
		});

		it('terminates when no breakpoints ahead', async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// continue from last frame with no breakpoints
			harness.clear();
			harness.send('continue', { threadId: 1 });

			await vi.waitFor(() => {
				expect(harness.events('terminated')).toHaveLength(1);
			});
		});
	});

	// ──────────────────────────────────────────────────────────────
	// restartFrame (Edit and Continue)
	// ──────────────────────────────────────────────────────────────

	describe('restartFrame', () => {
		beforeEach(async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});
		});

		it('responds with success', async () => {
			harness.clear();
			harness.send('restartFrame', { frameId: 0 });

			await vi.waitFor(() => {
				const resp = harness.responses('restartFrame');
				expect(resp).toHaveLength(1);
				expect(resp[0].success).toBe(true);
			});
		});

		it('emits stopped after restart', async () => {
			harness.clear();
			harness.send('restartFrame', { frameId: 0 });

			await vi.waitFor(() => {
				const stopped = harness.events('stopped');
				expect(stopped.length).toBeGreaterThan(0);
				expect(stopped[stopped.length - 1].body?.reason).toBe('restart');
			});
		});

		it('sets currentFrameIndex to the restarted frame', async () => {
			harness.clear();
			// Restart from frame 0 (base)
			harness.send('restartFrame', { frameId: 0 });

			await vi.waitFor(() => {
				expect(harness.events('stopped').length).toBeGreaterThan(0);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const resp = harness.lastResponse('stackTrace');
			const frames = (resp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			// Restart enters clause-level for the restarted frame
			expect(frames[0].name).toContain('base \u2192');
		});

		it('evicts restarted frame and downstream from cache', async () => {
			// Prime the cache by reaching last frame
			const db = harness.adapter['_databaseProvider'] as unknown as { query: ReturnType<typeof vi.fn> };
			const callsBefore = db.query.mock.calls.length;

			harness.clear();
			harness.send('restartFrame', { frameId: 0 });

			await vi.waitFor(() => {
				expect(harness.events('stopped').length).toBeGreaterThan(0);
			});

			// At least one db query should have run after the restart (cache was evicted)
			expect(db.query.mock.calls.length).toBeGreaterThan(callsBefore);
		});

		it('clears entire cache when CTE structure changes', async () => {
			// Second decompose returns different frame names
			const newDecompose: DbtCommandResult = {
				success: true, stdout: '', stderr: '',
				data: {
					success: true,
					frames: [
						{ name: 'renamed_base', type: 'cte', line: 0, endLine: 3 },
						{ name: '_main_', type: 'select', line: 5, endLine: 8 },
					],
					clauses: {
						renamed_base: [{ stage: 'select', sql: 'SELECT id FROM raw', line: 1 }],
						_main_: [{ stage: 'select', sql: 'SELECT * FROM renamed_base', line: 6 }],
					},
					refs: {},
				},
			};

			// Replace the bridge runner so the second decompose call returns renamed frames
			let callCount = 0;
			const bridge = harness.adapter['_bridgeRunner'] as unknown as { invokeRaw: ReturnType<typeof vi.fn> };
			bridge.invokeRaw.mockImplementation((req: Record<string, unknown>) => {
				if (req.decompose_query) {
					callCount++;
					if (callCount >= 1) return Promise.resolve(newDecompose);
					return Promise.resolve(DECOMPOSE_SIMPLE);
				}
				if (req.emit_debug_symbols) {
					return Promise.resolve({ success: true, stdout: '', stderr: '', data: { success: true, symbols: [] } });
				}
				return Promise.resolve({ success: true, stdout: '', stderr: '', data: {} });
			});

			harness.clear();
			harness.send('restartFrame', { frameId: 0 });

			await vi.waitFor(() => {
				expect(harness.events('stopped').length).toBeGreaterThan(0);
			});

			// Stack trace should now show the renamed frame with clause detail
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const resp = harness.lastResponse('stackTrace');
			const frames = (resp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(frames[0].name).toContain('renamed_base \u2192');
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Evaluate
	// ──────────────────────────────────────────────────────────────

	describe('evaluate', () => {
		beforeEach(async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});
			harness.clear();
		});

		it('executes SQL in repl context', async () => {
			harness.send('evaluate', { expression: 'SELECT 1', context: 'repl' });

			await vi.waitFor(() => {
				const resp = harness.lastResponse('evaluate');
				expect(resp).toBeDefined();
				expect(resp.success).toBe(true);
				expect((resp.body as Record<string, unknown>).result).toContain('row(s)');
			});
		});

		it('echoes expression in non-repl context', () => {
			harness.send('evaluate', { expression: 'some_value', context: 'watch' });

			const resp = harness.lastResponse('evaluate');
			expect(resp.success).toBe(true);
			expect((resp.body as Record<string, unknown>).result).toBe('some_value');
		});

		it('rejects empty expression in repl', () => {
			harness.send('evaluate', { expression: '  ', context: 'repl' });

			const resp = harness.lastResponse('evaluate');
			expect(resp.success).toBe(false);
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Terminate / Disconnect
	// ──────────────────────────────────────────────────────────────

	describe('terminate', () => {
		it('fires terminated event', () => {
			setActiveEditor('SELECT 1');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('terminate');

			const terminated = harness.events('terminated');
			expect(terminated).toHaveLength(1);
		});

		it('cancels query runner on disconnect', () => {
			const qr = mockQueryRunner();
			harness = new DapHarness({ queryRunner: qr });
			harness.send('initialize');
			harness.send('disconnect');

			expect(qr.cancel).toHaveBeenCalled();
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Step in targets
	// ──────────────────────────────────────────────────────────────

	describe('stepInTargets', () => {
		it('returns CTE and ref targets', async () => {
			setActiveEditor('WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH base AS (SELECT id FROM raw_orders) SELECT * FROM base' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stepInTargets', { frameId: 1 });

			const resp = harness.lastResponse('stepInTargets');
			expect(resp.success).toBe(true);
			const targets = (resp.body as Record<string, unknown>).targets as Array<{ label: string }>;
			expect(targets.length).toBeGreaterThan(0);
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Source map integration
	// ──────────────────────────────────────────────────────────────

	describe('source map integration', () => {
		it('uses compileWithSymbols for model files', async () => {
			setActiveEditor('SELECT {{ ref(\'orders\') }}');
			const bridge = mockBridgeRunner();
			harness = new DapHarness({
				bridgeRunner: bridge,
				pathResolver: mockPathResolver('model'),
			});
			harness.send('initialize');
			harness.send('launch', { noDebug: false });

			await vi.waitFor(() => {
				// Either thread started or terminated (if decompose fails on mocked compiled SQL)
				const threadOrTerm = [...harness.events('thread'), ...harness.events('terminated')];
				expect(threadOrTerm.length).toBeGreaterThan(0);
			});

			// Bridge should have been called with emit_debug_symbols
			expect(bridge.invokeRaw).toHaveBeenCalledWith(
				expect.objectContaining({ emit_debug_symbols: true }),
			);
			// And compileInlineSql should have been called with annotated source
			expect(bridge.compileInlineSql).toHaveBeenCalled();
		});

		it('verifies breakpoint using remapped frame range when frame boundary has no exact mapping', async () => {
			setActiveEditor('-- model text that will be compiled', '/models/reg_season_actuals_enriched.sql');

			const compiledSql = [
				'with',
				'cte_home_losses as (',
				'  /* @dbg:L70:C2:select */ select /* /@dbg */ lr.home_team, count(*) as losses',
				'  /* @dbg:L71:C2:from */ from /* /@dbg */ nba_latest_results lr',
				'  /* @dbg:L72:C2:where */ where /* /@dbg */ lr.home_team = lr.losing_team',
				'  group by all',
				')',
				// _main_ has a marker so it remaps into source space (required after removing interpolation)
				'/* @dbg:L76:C0:select */ select /* /@dbg */ * from cte_home_losses',
			].join('\n');

			const bridge = {
				invokeRaw: vi.fn().mockImplementation((req: Record<string, unknown>) => {
					if (req.emit_debug_symbols) {
						return Promise.resolve({
							success: true,
							stdout: '',
							stderr: '',
							data: {
								success: true,
								symbols: [
									{ line: 70, col: 2, endCol: 8, role: 'select' },
									{ line: 71, col: 2, endCol: 6, role: 'from' },
									{ line: 72, col: 2, endCol: 7, role: 'where' },
								],
							},
						});
					}

					if (req.decompose_query) {
						return Promise.resolve({
							success: true,
							stdout: '',
							stderr: '',
							data: {
								success: true,
								frames: [
									// Boundary lines intentionally have no exact debug markers.
									{ name: 'cte_home_losses', type: 'cte', line: 1, endLine: 6 },
									{ name: '_main_', type: 'select', line: 7, endLine: 7 },
								],
								clauses: {
									cte_home_losses: [
										{ stage: 'select', sql: 'select lr.home_team, count(*) as losses', line: 2 },
										{ stage: 'from', sql: 'from nba_latest_results lr', line: 3 },
										{ stage: 'where', sql: 'where lr.home_team = lr.losing_team', line: 4 },
									],
									_main_: [{ stage: 'select', sql: 'select * from cte_home_losses', line: 7 }],
								},
								refs: {
									cte_home_losses: ['nba_latest_results'],
									_main_: ['cte_home_losses'],
								},
							},
						});
					}

					return Promise.resolve({ success: true, stdout: '', stderr: '', data: {} });
				}),
				compileInlineSql: vi.fn().mockResolvedValue(compiledSql),
			} as unknown as BridgeRunner;

			harness = new DapHarness({
				bridgeRunner: bridge,
				pathResolver: mockPathResolver('model'),
			});
			harness.send('initialize');
			harness.send('launch', { noDebug: false });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('setBreakpoints', {
				source: { path: '/models/reg_season_actuals_enriched.sql' },
				breakpoints: [{ line: 72 }],
			});

			const resp = harness.lastResponse('setBreakpoints');
			const bps = (resp.body as Record<string, unknown>).breakpoints as Array<{
				verified: boolean;
				message?: string;
			}>;

			// This would be false if frame range stayed in compiled-space due to missing
			// exact mapping on frame boundary lines.
			expect(bps[0].verified).toBe(true);
			expect(bps[0].message).toContain('cte_home_losses');
		});

		it('verifies breakpoint from frame-range overlap mappings even when frame has no clauses', async () => {
			setActiveEditor('-- model text that will be compiled', '/models/overlap_mapping.sql');

			const compiledSql = [
				'with',
				'cte_sparse as (',
				'  /* @dbg:L40:C2:select */ select /* /@dbg */ 1 as id',
				'  /* @dbg:L41:C2:from */ from /* /@dbg */ some_table',
				')',
				'select * from cte_sparse',
			].join('\n');

			const bridge = {
				invokeRaw: vi.fn().mockImplementation((req: Record<string, unknown>) => {
					if (req.emit_debug_symbols) {
						return Promise.resolve({
							success: true,
							stdout: '',
							stderr: '',
							data: {
								success: true,
								symbols: [
									{ line: 40, col: 2, endCol: 8, role: 'select' },
									{ line: 41, col: 2, endCol: 6, role: 'from' },
								],
							},
						});
					}

					if (req.decompose_query) {
						return Promise.resolve({
							success: true,
							stdout: '',
							stderr: '',
							data: {
								success: true,
								frames: [
									{ name: 'cte_sparse', type: 'cte', line: 1, endLine: 4 },
									{ name: '_main_', type: 'select', line: 5, endLine: 5 },
								],
								clauses: {
									// Intentionally empty for cte_sparse to force frame-range overlap path.
									cte_sparse: [],
									_main_: [{ stage: 'select', sql: 'select * from cte_sparse', line: 5 }],
								},
								refs: {
									cte_sparse: ['some_table'],
									_main_: ['cte_sparse'],
								},
							},
						});
					}

					return Promise.resolve({ success: true, stdout: '', stderr: '', data: {} });
				}),
				compileInlineSql: vi.fn().mockResolvedValue(compiledSql),
			} as unknown as BridgeRunner;

			harness = new DapHarness({
				bridgeRunner: bridge,
				pathResolver: mockPathResolver('model'),
			});
			harness.send('initialize');
			harness.send('launch', { noDebug: false });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('setBreakpoints', {
				source: { path: '/models/overlap_mapping.sql' },
				breakpoints: [{ line: 41 }],
			});

			const resp = harness.lastResponse('setBreakpoints');
			const bps = (resp.body as Record<string, unknown>).breakpoints as Array<{
				verified: boolean;
				message?: string;
			}>;

			expect(bps[0].verified).toBe(true);
			expect(bps[0].message).toContain('cte_sparse');
		});
	});

	// ──────────────────────────────────────────────────────────────
	// noDebug / legacy launch
	// ──────────────────────────────────────────────────────────────

	describe('noDebug (legacy launch)', () => {
		it('executes query and terminates without stepping', async () => {
			const qr = mockQueryRunner();
			setActiveEditor('SELECT 1 FROM t');
			harness = new DapHarness({ queryRunner: qr });
			harness.send('initialize');
			harness.send('launch', { noDebug: true });

			await vi.waitFor(() => {
				expect(harness.events('terminated')).toHaveLength(1);
			});
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Multi-CTE breakpoint targeting (nba model scenario)
	// ──────────────────────────────────────────────────────────────

	describe('multi-CTE breakpoint targeting', () => {
		// Mirrors the real nba-monte-carlo reg_season_actuals_enriched model:
		// 8 CTEs then a final SELECT.  Breakpoint on line 72 (1-based)
		// should hit cte_home_losses, NOT _main_.

		const DECOMPOSE_NBA: DbtCommandResult = {
			success: true,
			stdout: '',
			stderr: '',
			data: {
				success: true,
				frames: [
					{ name: 'cte_wins', type: 'cte', line: 3, endLine: 7 },
					{ name: 'cte_losses', type: 'cte', line: 9, endLine: 13 },
					{ name: 'cte_favored_wins', type: 'cte', line: 15, endLine: 23 },
					{ name: 'cte_favored_losses', type: 'cte', line: 25, endLine: 33 },
					{ name: 'cte_avg_opponent_wins', type: 'cte', line: 35, endLine: 47 },
					{ name: 'cte_avg_opponent_losses', type: 'cte', line: 49, endLine: 61 },
					{ name: 'cte_home_wins', type: 'cte', line: 63, endLine: 67 },
					{ name: 'cte_home_losses', type: 'cte', line: 69, endLine: 73 },
					{ name: '_main_', type: 'select', line: 75, endLine: 103 },
				],
				clauses: {
					cte_wins: [
						{ stage: 'from', sql: 'SELECT * FROM nba_latest_results', line: 5 },
						{ stage: 'select', sql: 'SELECT winning_team, count(*) as wins FROM nba_latest_results GROUP BY ALL', line: 4 },
					],
					cte_home_losses: [
						{ stage: 'from', sql: 'SELECT * FROM nba_latest_results', line: 71 },
						{ stage: 'select', sql: 'SELECT lr.home_team, count(*) as losses FROM nba_latest_results lr WHERE lr.home_team = lr.losing_team GROUP BY ALL', line: 70 },
					],
					_main_: [
						{ stage: 'from', sql: 'SELECT * FROM nba_teams', line: 92 },
						{ stage: 'select', sql: 'SELECT t.team, ... FROM nba_teams t LEFT JOIN ...', line: 76 },
					],
				},
				refs: {
					cte_wins: ['nba_latest_results'],
					cte_home_losses: ['nba_latest_results'],
					_main_: ['nba_teams', 'cte_wins', 'cte_losses', 'cte_favored_wins', 'cte_favored_losses', 'cte_avg_opponent_wins', 'cte_avg_opponent_losses', 'cte_home_wins', 'cte_home_losses'],
				},
			},
		};

		it('breakpoint in FIRST CTE (frame[0]) is not skipped', async () => {
			setActiveEditor('-- multi-CTE model\n'.repeat(104), '/models/reg_season.sql');
			harness = new DapHarness({
				bridgeRunner: mockBridgeRunner(DECOMPOSE_NBA),
			});
			harness.send('initialize');
			harness.send('launch', {
				noDebug: false,
				sql: '-- 8 CTE model placeholder',
			});

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			// Breakpoint on line 5 (1-based) → 0-based line 4 — falls in cte_wins (3..7)
			harness.send('setBreakpoints', {
				source: { path: '/models/reg_season.sql' },
				breakpoints: [{ line: 5 }],
			});

			await vi.waitFor(() => {
				expect(harness.lastResponse('setBreakpoints')).toBeDefined();
			});

			harness.clear();
			harness.send('configurationDone');

			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			const stopped = harness.events('stopped')[0];
			expect(stopped.body).toMatchObject({ reason: 'breakpoint' });

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });

			const stResp = harness.lastResponse('stackTrace');
			const stackFrames = (stResp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			// Must stop on the FIRST CTE, not skip it and fall through to a later frame
			expect(stackFrames[0].name).toContain('cte_wins');
		});

		it('setBreakpoints after launch resolves with verified frames', async () => {
			setActiveEditor('-- multi-CTE model\n'.repeat(104), '/models/reg_season.sql');
			harness = new DapHarness({
				bridgeRunner: mockBridgeRunner(DECOMPOSE_NBA),
			});
			harness.send('initialize');
			harness.send('launch', {
				noDebug: false,
				sql: '-- 8 CTE model placeholder',
			});

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			// Send setBreakpoints AFTER launch — frames are already populated
			harness.send('setBreakpoints', {
				source: { path: '/models/reg_season.sql' },
				breakpoints: [{ line: 72 }],
			});

			const resp = harness.lastResponse('setBreakpoints');
			const bps = (resp.body as Record<string, unknown>).breakpoints as Array<{
				verified: boolean; message?: string;
			}>;
			// Breakpoint at line 72 should be verified against the real frames
			expect(bps[0].verified).toBe(true);
			expect(bps[0].message).toContain('cte_home_losses');

			harness.send('configurationDone');

			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const stResp = harness.lastResponse('stackTrace');
			const stackFrames = (stResp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(stackFrames[0].name).toContain('cte_home_losses');
		});

		it('breakpoint on cte_home_losses (line 72) stops on that CTE, not _main_', async () => {
			setActiveEditor('-- multi-CTE model\n'.repeat(104), '/models/reg_season.sql');
			harness = new DapHarness({
				bridgeRunner: mockBridgeRunner(DECOMPOSE_NBA),
			});
			harness.send('initialize');
			harness.send('launch', {
				noDebug: false,
				sql: '-- 8 CTE model placeholder',
			});

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			// Set breakpoint on line 72 (1-based) → 0-based line 71
			// This falls inside cte_home_losses (line 69..73)
			harness.send('setBreakpoints', {
				source: { path: '/models/reg_season.sql' },
				breakpoints: [{ line: 72 }],
			});

			await vi.waitFor(() => {
				const resp = harness.lastResponse('setBreakpoints');
				expect(resp).toBeDefined();
				expect(resp.success).toBe(true);
				const bps = (resp.body as Record<string, unknown>).breakpoints as Array<{
					verified: boolean;
					message?: string;
				}>;
				expect(bps[0].verified).toBe(true);
				expect(bps[0].message).toContain('cte_home_losses');
			});

			harness.clear();
			harness.send('configurationDone');

			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Verify the stopped event is a breakpoint hit
			const stopped = harness.events('stopped')[0];
			expect(stopped.body).toMatchObject({ reason: 'breakpoint' });

			// Now check which frame the debugger stopped on
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });

			const stResp = harness.lastResponse('stackTrace');
			expect(stResp.success).toBe(true);
			const stackFrames = (stResp.body as Record<string, unknown>).stackFrames as Array<{
				name: string;
				line: number;
			}>;
			// The topmost frame should be cte_home_losses, not _main_
			expect(stackFrames[0].name).toContain('cte_home_losses');
			expect(stackFrames[0].name).not.toContain('_main_');
		});
	});

	describe('completions', () => {
		let harness: DapHarness;

		beforeEach(async () => {
			setActiveEditor('-- orders model\n'.repeat(10), '/models/orders.sql');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: '-- placeholder' });
			await vi.waitFor(() => expect(harness.events('thread')).toHaveLength(1));
			harness.send('configurationDone');
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));
		});

		afterEach(() => { harness.dispose(); clearActiveEditor(); });

		it('returns column names from active frame result', () => {
			harness.clear();
			harness.send('completions', { text: '', column: 0, frameId: 0 });
			const resp = harness.lastResponse('completions');
			expect(resp.success).toBe(true);
			const targets = (resp.body as Record<string, unknown>).targets as Array<{ label: string; type: string }>;
			// id and status are in the mock result (excluding __debug_count__)
			expect(targets.some(t => t.label === 'id')).toBe(true);
			expect(targets.some(t => t.label === 'status')).toBe(true);
			expect(targets.some(t => t.label === '__debug_count__')).toBe(false);
		});

		it('includes CTE names as function targets', () => {
			harness.clear();
			harness.send('completions', { text: '', column: 0, frameId: 0 });
			const resp = harness.lastResponse('completions');
			const targets = (resp.body as Record<string, unknown>).targets as Array<{ label: string; type: string }>;
			// Current frame is _main_ (last frame, where configurationDone stops without breakpoints).
			// 'base' is the other frame and should appear as a function target.
			expect(targets.some(t => t.label === 'base' && t.type === 'function')).toBe(true);
			// Current frame itself should NOT appear.
			expect(targets.some(t => t.label === '_main_' && t.type === 'function')).toBe(false);
		});
	});

	describe('reverseContinue', () => {
		let harness: DapHarness;

		beforeEach(async () => {
			setActiveEditor('-- orders model\n'.repeat(10), '/models/orders.sql');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: '-- placeholder' });
			await vi.waitFor(() => expect(harness.events('thread')).toHaveLength(1));
			harness.send('configurationDone');
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));
		});

		afterEach(() => { harness.dispose(); clearActiveEditor(); });

		it('stops at beginning when no history and no breakpoints', () => {
			harness.clear();
			harness.send('reverseContinue', { threadId: 1 });
			const stopped = harness.events('stopped');
			expect(stopped).toHaveLength(1);
			expect(stopped[0].body).toMatchObject({ reason: 'step' });
		});

		it('stops at breakpointed frame when stepping back through history', async () => {
			// Re-launch with a breakpoint on 'base' so the session starts at frame 0 ('base').
			harness.dispose();
			setActiveEditor('-- orders model\n'.repeat(10), '/models/orders.sql');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: '-- placeholder' });
			await vi.waitFor(() => expect(harness.events('thread')).toHaveLength(1));
			// Set function breakpoint on 'base' BEFORE configurationDone so it stops there.
			harness.send('setFunctionBreakpoints', { breakpoints: [{ name: 'base' }] });
			harness.send('configurationDone');
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));
			// Verify we stopped at 'base'.
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const st = harness.lastResponse('stackTrace');
			const frames = (st.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(frames[0].name).toContain('base');

			// Now step forward to _main_ — this pushes 'base' position into history.
			harness.clear();
			harness.send('next', { threadId: 1 });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));

			// reverseContinue: should walk history backwards and find 'base' has a breakpoint.
			harness.clear();
			harness.send('reverseContinue', { threadId: 1 });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));
			const stopped = harness.events('stopped')[0];
			expect(stopped.body).toMatchObject({ reason: 'breakpoint' });
		});
	});

	describe('evaluateForHovers', () => {
		let harness: DapHarness;

		beforeEach(async () => {
			setActiveEditor('-- orders model\n'.repeat(10), '/models/orders.sql');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: '-- placeholder' });
			await vi.waitFor(() => expect(harness.events('thread')).toHaveLength(1));
			harness.send('configurationDone');
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));
		});

		afterEach(() => { harness.dispose(); clearActiveEditor(); });

		it('returns first-row value for a known column', () => {
			harness.clear();
			harness.send('evaluate', { expression: 'id', context: 'hover', frameId: 0 });
			const resp = harness.lastResponse('evaluate');
			expect(resp.success).toBe(true);
			expect((resp.body as Record<string, unknown>).result).toBe('1');
		});

		it('fails gracefully for unknown column', () => {
			harness.clear();
			harness.send('evaluate', { expression: 'nonexistent_col', context: 'hover', frameId: 0 });
			const resp = harness.lastResponse('evaluate');
			expect(resp.success).toBe(false);
		});
	});

	describe('setExceptionBreakpoints', () => {
		let harness: DapHarness;

		afterEach(() => { harness?.dispose(); clearActiveEditor(); });

		it('responds with success', async () => {
			setActiveEditor('-- orders\n'.repeat(5), '/models/orders.sql');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('setExceptionBreakpoints', { filters: ['emptyResult'] });
			const resp = harness.lastResponse('setExceptionBreakpoints');
			expect(resp.success).toBe(true);
		});

		it('breaks on emptyResult when filter active', async () => {
			setActiveEditor('-- orders\n'.repeat(5), '/models/orders.sql');
			const emptyDb: DatabaseProvider = {
				adapterType: 'duckdb',
				query: vi.fn().mockResolvedValue({
					columns: ['id', '__debug_count__'],
					rows: [{ id: 1, __debug_count__: 0 }],
					rowCount: 1,
					executionTimeMs: 5,
				}),
			} as unknown as DatabaseProvider;
			harness = new DapHarness({ databaseProvider: emptyDb });
			harness.send('initialize');
			harness.send('setExceptionBreakpoints', { filters: ['emptyResult'] });
			harness.send('launch', { noDebug: false, sql: '-- placeholder' });
			await vi.waitFor(() => expect(harness.events('thread')).toHaveLength(1));
			harness.send('configurationDone');
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));
			const stopped = harness.events('stopped')[0];
			expect(stopped.body).toMatchObject({ reason: 'exception' });
		});
	});

	describe('gotoTargets and goto', () => {
		let harness: DapHarness;

		beforeEach(async () => {
			setActiveEditor('-- orders model\n'.repeat(10), '/models/orders.sql');
			harness = new DapHarness();
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: '-- placeholder' });
			await vi.waitFor(() => expect(harness.events('thread')).toHaveLength(1));
			harness.send('configurationDone');
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));
		});

		afterEach(() => { harness.dispose(); clearActiveEditor(); });

		it('gotoTargets returns all frame names', () => {
			harness.clear();
			harness.send('gotoTargets', { source: {}, line: 1 });
			const resp = harness.lastResponse('gotoTargets');
			expect(resp.success).toBe(true);
			const targets = (resp.body as Record<string, unknown>).targets as Array<{ id: number; label: string }>;
			expect(targets.map(t => t.label)).toContain('base');
			expect(targets.map(t => t.label)).toContain('_main_');
		});

		it('goto jumps to target frame and emits stopped', async () => {
			harness.clear();
			// Jump to frame index 0 (base)
			harness.send('goto', { threadId: 1, targetId: 0 });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));
			const stopped = harness.events('stopped')[0];
			expect(stopped.body).toMatchObject({ reason: 'goto' });
		});
	});
});
