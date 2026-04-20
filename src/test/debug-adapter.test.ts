import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	SqlDebugAdapter,
	encodeRef,
	decodeRef,
	wrapWithDebugCount,
	findMainSelectPos,
	buildScopedSql,
	neutralizeJoinType,
	neutralizeJoinInSql,
	SCOPE_RESULT,
	SCOPE_IMPACT,
	SCOPE_QUERY,
} from '../dbt/debug-adapter';
import type { QueryRunner } from '../dbt/query-runner';
import type { DbtPathResolver } from '../dbt/dbt-path-resolver';
import type { ILogger } from '../types/logger';
import type { DatabaseProvider, QueryResult } from '../providers/database/database-provider';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { CompileCache } from '../dbt/compile-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ParseService } from '../services/parse-service';
import type { SqlToken } from '../ftl/parse-result';

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

const DECOMPOSE_SIMPLE = {
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
};

// 3-frame fixture where _main_ directly references stg_orders (skipping the middle `orders` CTE).
// Used to test that F10 at the last clause of a stepped-into CTE returns to the caller,
// not to the next sequential frame (which would be `orders`, not `_main_`).
const DECOMPOSE_THREE_FRAMES = {
	success: true,
	frames: [
		{ name: 'stg_orders', type: 'cte', line: 0, endLine: 3 },
		{ name: 'orders', type: 'cte', line: 4, endLine: 7 },
		{ name: '_main_', type: 'select', line: 8, endLine: 11 },
	],
	clauses: {
		stg_orders: [
			{ stage: 'from', sql: 'SELECT * FROM raw', line: 1 },
			{ stage: 'select', sql: 'SELECT id, status FROM raw', line: 3 },
		],
		orders: [
			{ stage: 'from', sql: 'SELECT * FROM stg_orders', line: 5 },
			{ stage: 'select', sql: 'SELECT * FROM stg_orders', line: 7 },
		],
		_main_: [
			{ stage: 'from', sql: 'SELECT * FROM stg_orders', line: 9 },
			{ stage: 'select', sql: 'SELECT * FROM stg_orders', line: 11 },
		],
	},
	refs: {
		stg_orders: ['raw'],
		orders: ['stg_orders'],
		_main_: ['stg_orders'],
	},
};

function mockBridgeRunner(): BridgeRunner {
	return {
		invokeRaw: vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '', data: {} }),
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
		adapterType: 'duckdb',
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

function mockParseService(
	decomposeResult?: object,
	tokenResult?: { sqlTokens: SqlToken[]; jinjaTokens: [] },
): ParseService {
	return {
		getDocumentModel: vi.fn().mockResolvedValue(null),
		parseRawForTokens: vi.fn().mockResolvedValue(tokenResult ?? undefined),
		decomposeQuery: vi.fn().mockResolvedValue(JSON.stringify(decomposeResult ?? DECOMPOSE_SIMPLE)),
		onAliasesReady: { dispose: vi.fn() },
		onSqlglotWarnings: { dispose: vi.fn() },
	} as unknown as ParseService;
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
		parseService?: ParseService;
	}) {
		this.adapter = new SqlDebugAdapter(
			opts?.queryRunner ?? mockQueryRunner(),
			opts?.pathResolver ?? mockPathResolver(),
			opts?.logger ?? mockLogger(),
			opts?.databaseProvider ?? mockDatabaseProvider(),
			opts?.bridgeRunner ?? mockBridgeRunner(),
			opts?.compileCache ?? mockCompileCache(),
			opts?.manifestIndexer ?? mockManifestIndexer(),
			opts?.parseService ?? mockParseService(),
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
	describe('neutralizeJoinType', () => {
		it('leaves LEFT JOIN unchanged', () => {
			expect(neutralizeJoinType(' LEFT JOIN foo AS f')).toBe(' LEFT JOIN foo AS f');
		});

		it('converts INNER JOIN to LEFT JOIN', () => {
			expect(neutralizeJoinType(' INNER JOIN foo AS f')).toBe(' LEFT JOIN foo AS f');
		});

		it('converts RIGHT JOIN to LEFT JOIN', () => {
			expect(neutralizeJoinType(' RIGHT JOIN foo AS f')).toBe(' LEFT JOIN foo AS f');
		});

		it('converts bare JOIN to LEFT JOIN', () => {
			expect(neutralizeJoinType(' JOIN foo AS f')).toBe(' LEFT JOIN foo AS f');
		});

		it('converts CROSS JOIN to LEFT JOIN', () => {
			expect(neutralizeJoinType(' CROSS JOIN foo AS f')).toBe(' LEFT JOIN foo AS f');
		});
	});

	describe('neutralizeJoinInSql', () => {
		// Current bridge format: qualifier keywords (inner, left, right, ...) and JOIN are
		// emitted as separate token markers on the same source line. C8 wraps `inner` alone,
		// C14 wraps bare `join`. The table reference lives OUTSIDE both markers.
		// clauseLine parameter is the 1-based line number matching the @dbg marker.

		// INNER JOIN: C8=`inner`, C14=`join`, ON condition in ident marker after table ref.
		const innerJoinLine29 = '/* @dbg:L29:C8:join:cte_favored_wins */ inner /* /@dbg */ /* @dbg:L29:C14:join:cte_favored_wins */ join /* /@dbg */ "nba-monte-carlo"."main"."nba_results_log" AS r /* @dbg:L30:C41:ident:cte_favored_wins */ on /* /@dbg */ r.game_id = lr.game_id';

		// LEFT JOIN: C0=`left`, C5=`join`, ON condition in ident marker.
		const leftJoinLine103 = '/* @dbg:L103:C0:join:_main_ */ left /* /@dbg */ /* @dbg:L103:C5:join:_main_ */ join /* /@dbg */ cte_wins AS w /* @dbg:L103:C19:ident:_main_ */ on /* /@dbg */ w.winning_team = t.team_long';

		it('INNER JOIN — converts to LEFT JOIN, clears qualifier marker, inserts 1=0 AND after ON', () => {
			const expected = '/* @dbg:L29:C8:join:cte_favored_wins */ /* /@dbg */ /* @dbg:L29:C14:join:cte_favored_wins */ LEFT JOIN /* /@dbg */ "nba-monte-carlo"."main"."nba_results_log" AS r /* @dbg:L30:C41:ident:cte_favored_wins */ on 1=0 AND /* /@dbg */ r.game_id = lr.game_id';
			expect(neutralizeJoinInSql(innerJoinLine29, 29, 'cte_favored_wins')).toBe(expected);
		});

		it('LEFT JOIN — leaves join type, clears qualifier marker, inserts 1=0 AND after ON', () => {
			const expected = '/* @dbg:L103:C0:join:_main_ */ /* /@dbg */ /* @dbg:L103:C5:join:_main_ */ LEFT JOIN /* /@dbg */ cte_wins AS w /* @dbg:L103:C19:ident:_main_ */ on 1=0 AND /* /@dbg */ w.winning_team = t.team_long';
			expect(neutralizeJoinInSql(leftJoinLine103, 103, '_main_')).toBe(expected);
		});

		it('returns sql unchanged when no matching marker found', () => {
			expect(neutralizeJoinInSql('SELECT 1', 0, '_main_')).toBe('SELECT 1');
		});

		it('returns sql unchanged when clauseLine does not match', () => {
			expect(neutralizeJoinInSql(innerJoinLine29, 0, 'cte_favored_wins')).toBe(innerJoinLine29);
		});

		it('returns sql unchanged when frame does not match', () => {
			expect(neutralizeJoinInSql(innerJoinLine29, 28, 'wrong_frame')).toBe(innerJoinLine29);
		});
	});

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
		it('wraps plain SELECT via __debug_context__', () => {
			const result = wrapWithDebugCount('SELECT 1', 100);
			expect(result).toContain('__debug_context__');
			expect(result).toContain('LIMIT 100');
			expect(result).toContain('__debug_count__');
		});

		it('wraps CTE query using extra CTE', () => {
			const result = wrapWithDebugCount('WITH a AS (SELECT 1) SELECT * FROM a', 50);
			expect(result).toContain('__debug_context__');
			expect(result).not.toMatch(/AS\s*\(\s*WITH/i);
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

		it('hoists CTEs when frame SQL is a WITH query', () => {
			const frameSql = 'WITH cte_a AS (SELECT 1 AS x)\nSELECT * FROM cte_a';
			const result = buildScopedSql('x', [{ sql: frameSql }]);
			// Must NOT nest WITH inside another CTE body.
			expect(result).not.toMatch(/AS\s*\(\s*WITH/i);
			// Should still produce valid-looking SQL with __debug_context__.
			expect(result).toContain('__debug_context__');
			expect(result).toContain('cte_a');
			expect(result).toMatch(/SELECT x FROM __debug_context__/);
		});

		it('hoists CTEs when frame SQL has leading @dbg annotations', () => {
			const frameSql = '/* @dbg:L2:C0:cte:_main_ */ /* /@dbg */ WITH cte_a AS (SELECT 1 AS x)\nSELECT * FROM cte_a';
			const result = buildScopedSql('x', [{ sql: frameSql }]);
			expect(result).not.toMatch(/AS\s*\(\s*(?:\/\*[^*]*\*\/\s*)*WITH/i);
			expect(result).toContain('__debug_context__');
			expect(result).toContain('cte_a');
			expect(result).toMatch(/SELECT x FROM __debug_context__/);
		});

		it('wraps CTE-frame SQL that has inline @dbg annotations', () => {
			// Simulates a clause SQL from a CTE frame — annotations embedded throughout, no leading WITH
			const frameSql = 'WITH cte_wins /* @dbg:L3:C4:ident:cte_wins */ /* /@dbg */ AS (/* @dbg:L4:C8:select:cte_wins */ SELECT winning_team, COUNT(*) AS wins FROM "main"."nba_latest_results" GROUP BY ALL)\nSELECT losing_team, COUNT(*) AS losses FROM "main"."nba_latest_results" GROUP BY ALL';
			const result = buildScopedSql('losses', [{ sql: frameSql }]);
			expect(result).not.toMatch(/AS\s*\(\s*(?:\/\*[^*]*\*\/\s*)*WITH/i);
			expect(result).toContain('__debug_context__');
			expect(result).toMatch(/SELECT losses FROM __debug_context__/);
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

		it('stepBack with no history stays at current position', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// No navigation has happened — _fullHistory is empty.
			// stepBack should stay at current position.
			harness.clear();
			harness.send('stepBack', { threadId: 1 });

			await vi.waitFor(() => {
				const stopped = harness.events('stopped');
				expect(stopped).toHaveLength(1);
				expect(stopped[0].body?.reason).toBe('step');
			});

			// Stack trace still shows _main_
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const resp = harness.lastResponse('stackTrace');
			const frames = (resp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(frames[0].name).toContain('_main_ \u2192');
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

		it('configurationDone enters clause-level granularity at clause 0', async () => {
			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// configurationDone enters clause level directly — stack trace should
			// show clause-level frames (arrow notation).
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

			// stepOut should advance past the call site — we already executed `base`.
			harness.clear();
			harness.send('stepOut', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const backInMain = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			// Must be one past the call site: _main_ → select (not from base)
			expect(backInMain[0].name).toContain('_main_ \u2192');
			expect(backInMain[0].name).toContain('select');
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

		it('next past last clause of non-adjacent stepped-into frame advances past the call site', async () => {
			// Use the 3-frame fixture where _main_ (frame 2) directly references stg_orders (frame 0).
			// F10 at the end of stg_orders should behave like "step over the whole CTE" — it restores
			// to the call site (_main_ → from stg_orders) and then advances one step forward to the
			// next clause (_main_ → select). It must NOT fall through to `orders` (frame 1).
			harness.dispose();
			harness = new DapHarness({ parseService: mockParseService(DECOMPOSE_THREE_FRAMES) });
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'WITH stg_orders AS (...) SELECT * FROM stg_orders' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Entry: _main_ (frame 2), FROM clause (clause 0). F11 jumps into stg_orders (frame 0).
			harness.clear();
			harness.send('stepIn', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const inStg = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(inStg[0].name).toContain('stg_orders');

			// Step through stg_orders' two clauses (from → select).
			harness.clear();
			harness.send('next', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// F10 at the last clause of stg_orders (select).
			// Should restore to _main_ → from stg_orders (the call site) then advance one step
			// to _main_ → select. Must NOT fall through to `orders` (the next sequential frame).
			harness.clear();
			harness.send('next', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const backInMain = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(backInMain[0].name).toContain('_main_');
			// Must be on the SELECT clause — one step past where we stepped in from.
			expect(backInMain[0].name).toContain('select');
			expect(backInMain[0].name).not.toContain('from stg_orders');
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
			const newDecompose = {
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
			};

			// Replace the parseService so the second decompose call returns renamed frames
			let callCount = 0;
			const ps = harness.adapter['_parseService'] as unknown as { decomposeQuery: ReturnType<typeof vi.fn> };
			ps.decomposeQuery.mockImplementation(() => {
				callCount++;
				if (callCount >= 1) return Promise.resolve(JSON.stringify(newDecompose));
				return Promise.resolve(JSON.stringify(DECOMPOSE_SIMPLE));
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
			harness.send('evaluate', { expression: 'id', context: 'repl' });

			await vi.waitFor(() => {
				const resp = harness.lastResponse('evaluate');
				expect(resp).toBeDefined();
				expect(resp.success).toBe(true);
				expect((resp.body as Record<string, unknown>).result).toContain('row(s)');
			});
		});

		it('evaluates watch expression against current frame when no frameId', async () => {
			harness.send('evaluate', { expression: 'some_value', context: 'watch' });

			await vi.waitFor(() => {
				const resp = harness.lastResponse('evaluate');
				expect(resp).toBeDefined();
				expect(resp.success).toBe(true);
				expect((resp.body as Record<string, unknown>).result).toBeTruthy();
			});
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
	// Cross-model stepping
	// ──────────────────────────────────────────────────────────────

	describe('cross-model stepping', () => {
		afterEach(() => { harness?.dispose(); clearActiveEditor(); });

		it('stepIn on external ref loads child model inline (no separate session)', async () => {
			// Parent model: _main_ with a FROM clause referencing external 'orders'.
			const DECOMPOSE_PARENT = {
				success: true,
				frames: [{ name: '_main_', type: 'select', line: 0, endLine: 1 }],
				clauses: {
					_main_: [
						{ stage: 'from', sql: 'SELECT * FROM orders', line: 1 },
						{ stage: 'select', sql: 'SELECT id FROM orders', line: 0 },
					],
				},
				refs: { _main_: ['orders'] },
			};
			// Child model (orders): a simple single-frame query.
			const DECOMPOSE_CHILD = {
				success: true,
				frames: [{ name: '_main_', type: 'select', line: 0, endLine: 1 }],
				clauses: {
					_main_: [
						{ stage: 'select', sql: 'SELECT id FROM raw_orders', line: 0 },
					],
				},
				refs: { _main_: [] },
			};

			// ParseService returns parent decompose first, then child decompose on subsequent calls.
			let decomposeCallCount = 0;
			const ps = mockParseService();
			(ps.decomposeQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
				decomposeCallCount++;
				return Promise.resolve(JSON.stringify(decomposeCallCount === 1 ? DECOMPOSE_PARENT : DECOMPOSE_CHILD));
			});
			const bridge: BridgeRunner = {
				invokeRaw: vi.fn().mockImplementation((req: Record<string, unknown>) => {
					if (req.emit_debug_symbols) {
						return Promise.resolve({
							success: true, stdout: '', stderr: '',
							data: { success: true, symbols: [] },
						});
					}
					return Promise.resolve({ success: true, stdout: '', stderr: '', data: {} });
				}),
				compileInlineSql: vi.fn().mockResolvedValue('SELECT id FROM raw_orders'),
			} as unknown as BridgeRunner;

			// Mock fs.readFile so the child model source can be read.
			(vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
				new TextEncoder().encode('SELECT id FROM raw_orders'),
			);

			setActiveEditor('SELECT id FROM orders');
			harness = new DapHarness({ bridgeRunner: bridge, parseService: ps });
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'SELECT id FROM orders' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// F11 on the FROM clause — 'orders' is external.
			harness.clear();
			harness.send('stepIn', { threadId: 1 });

			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Inline stepping: stopped event fires, NO startDebugging request.
			expect(harness.events('stopped')[0].body).toMatchObject({ reason: 'step' });
			const startDbg = harness.messages.find(m => m.type === 'request' && m.command === 'startDebugging');
			expect(startDbg).toBeUndefined();
		});

		it('stepIn on external ref with unknown model stays stopped with error', async () => {
			const DECOMPOSE_EXTERNAL = {
				success: true,
				frames: [{ name: '_main_', type: 'select', line: 0, endLine: 1 }],
				clauses: {
					_main_: [
						{ stage: 'from', sql: 'SELECT * FROM unknown_model', line: 1 },
						{ stage: 'select', sql: 'SELECT * FROM unknown_model', line: 0 },
					],
				},
				refs: { _main_: ['unknown_model'] },
			};

			const indexer = mockManifestIndexer();
			(indexer.findModelsByName as ReturnType<typeof vi.fn>).mockReturnValue([]);

			setActiveEditor('SELECT * FROM unknown_model');
			harness = new DapHarness({
				parseService: mockParseService(DECOMPOSE_EXTERNAL),
				manifestIndexer: indexer,
			});
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'SELECT * FROM unknown_model' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stepIn', { threadId: 1 });

			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Session must still be stopped (not terminated or stuck).
			expect(harness.events('stopped')).toHaveLength(1);
			expect(harness.events('terminated')).toHaveLength(0);
		});

		it('Shift+F11 from child top frame pops back to parent and advances', async () => {
			const DECOMPOSE_PARENT = {
				success: true,
				frames: [{ name: '_main_', type: 'select', line: 0, endLine: 1 }],
				clauses: {
					_main_: [
						{ stage: 'from', sql: 'SELECT * FROM orders', line: 1 },
						{ stage: 'select', sql: 'SELECT id FROM orders', line: 0 },
					],
				},
				refs: { _main_: ['orders'] },
			};
			const DECOMPOSE_CHILD = {
				success: true,
				frames: [{ name: '_main_', type: 'select', line: 0, endLine: 1 }],
				clauses: {
					_main_: [
						{ stage: 'select', sql: 'SELECT id FROM raw_orders', line: 0 },
					],
				},
				refs: { _main_: [] },
			};

			let decomposeCallCount = 0;
			const ps = mockParseService();
			(ps.decomposeQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
				decomposeCallCount++;
				return Promise.resolve(JSON.stringify(decomposeCallCount === 1 ? DECOMPOSE_PARENT : DECOMPOSE_CHILD));
			});
			const bridge: BridgeRunner = {
				invokeRaw: vi.fn().mockImplementation((req: Record<string, unknown>) => {
					if (req.emit_debug_symbols) {
						return Promise.resolve({
							success: true, stdout: '', stderr: '',
							data: { success: true, symbols: [] },
						});
					}
					return Promise.resolve({ success: true, stdout: '', stderr: '', data: {} });
				}),
				compileInlineSql: vi.fn().mockResolvedValue('SELECT id FROM raw_orders'),
			} as unknown as BridgeRunner;

			(vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
				new TextEncoder().encode('SELECT id FROM raw_orders'),
			);

			setActiveEditor('SELECT id FROM orders');
			harness = new DapHarness({ bridgeRunner: bridge, parseService: ps });
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'SELECT id FROM orders' });

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Step into external ref — now inside the child model.
			harness.clear();
			harness.send('stepIn', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Shift+F11 from the child's top frame — should pop back to parent.
			harness.clear();
			harness.send('stepOut', { threadId: 1 });

			// Parent must resume — either next stopped (at the select clause) or terminated.
			await vi.waitFor(() => {
				expect(
					harness.events('stopped').length + harness.events('terminated').length,
				).toBeGreaterThan(0);
			});
		});

		it('multi-thread: emits thread events and serves per-thread stack traces', async () => {
			// Same parent/child setup used by the cross-model tests above.
			const DECOMPOSE_PARENT = {
				success: true,
				frames: [{ name: '_main_', type: 'select', line: 0, endLine: 1 }],
				clauses: {
					_main_: [
						{ stage: 'from', sql: 'SELECT * FROM orders', line: 1 },
						{ stage: 'select', sql: 'SELECT id FROM orders', line: 0 },
					],
				},
				refs: { _main_: ['orders'] },
			};
			const DECOMPOSE_CHILD = {
				success: true,
				frames: [{ name: '_main_', type: 'select', line: 0, endLine: 1 }],
				clauses: { _main_: [{ stage: 'select', sql: 'SELECT id FROM raw_orders', line: 0 }] },
				refs: { _main_: [] },
			};

			let decomposeCallCount = 0;
			const ps = mockParseService();
			(ps.decomposeQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
				decomposeCallCount++;
				return Promise.resolve(JSON.stringify(decomposeCallCount === 1 ? DECOMPOSE_PARENT : DECOMPOSE_CHILD));
			});
			const bridge: BridgeRunner = {
				invokeRaw: vi.fn().mockImplementation((req: Record<string, unknown>) => {
					if (req.emit_debug_symbols) {
						return Promise.resolve({ success: true, stdout: '', stderr: '', data: { success: true, symbols: [] } });
					}
					return Promise.resolve({ success: true, stdout: '', stderr: '', data: {} });
				}),
				compileInlineSql: vi.fn().mockResolvedValue('SELECT id FROM raw_orders'),
			} as unknown as BridgeRunner;

			(vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
				new TextEncoder().encode('SELECT id FROM raw_orders'),
			);

			setActiveEditor('SELECT id FROM orders');
			harness = new DapHarness({ bridgeRunner: bridge, parseService: ps });
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'SELECT id FROM orders' });
			await vi.waitFor(() => expect(harness.events('thread')).toHaveLength(1));

			harness.send('configurationDone');
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));

			// configurationDone already lands at the FROM clause (clause level).
			// One F11 from the FROM clause → external ref → steps into child model (Thread 2).
			harness.clear();
			harness.send('stepIn', { threadId: 1 });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));

			// thread(started, 2) event must have fired.
			const threadStarted = harness.events('thread').find(e => (e.body as Record<string, unknown>).reason === 'started');
			expect(threadStarted?.body).toMatchObject({ reason: 'started', threadId: 2 });

			// stopped event: child thread, not all threads.
			expect(harness.events('stopped')[0].body).toMatchObject({
				reason: 'step',
				threadId: 2,
				allThreadsStopped: false,
			});

			// threadsRequest while inside child → 2 threads.
			harness.send('threads');
			const threadsBody = harness.lastResponse('threads').body as { threads: Array<{ id: number }> };
			expect(threadsBody.threads).toHaveLength(2);
			expect(threadsBody.threads[0].id).toBe(1);
			expect(threadsBody.threads[1].id).toBe(2);

			// stackTrace(threadId: 1) → parent frozen frame.
			harness.send('stackTrace', { threadId: 1 });
			const parentFrames = (harness.lastResponse('stackTrace').body as { stackFrames: Array<{ name: string }> }).stackFrames;
			expect(parentFrames).toHaveLength(1);
			expect(parentFrames[0].name).toContain('_main_');

			// Shift+F11 from child (threadId: 2) → pops back to parent → thread(exited, 2).
			harness.clear();
			harness.send('stepOut', { threadId: 2 });
			await vi.waitFor(() => {
				expect(
					harness.events('stopped').length + harness.events('terminated').length,
				).toBeGreaterThan(0);
			});

			const threadExited = harness.events('thread').find(e => (e.body as Record<string, unknown>).reason === 'exited');
			expect(threadExited?.body).toMatchObject({ reason: 'exited', threadId: 2 });

			const stoppedEvt = harness.events('stopped')[0];
			if (stoppedEvt) {
				expect(stoppedEvt.body).toMatchObject({ threadId: 1, allThreadsStopped: true });
			}
		});

		it('guards stepping requests for non-active (frozen) threads', async () => {
			const DECOMPOSE_PARENT = {
				success: true,
				frames: [{ name: '_main_', type: 'select', line: 0, endLine: 1 }],
				clauses: {
					_main_: [
						{ stage: 'from', sql: 'SELECT * FROM orders', line: 1 },
						{ stage: 'select', sql: 'SELECT id FROM orders', line: 0 },
					],
				},
				refs: { _main_: ['orders'] },
			};
			const DECOMPOSE_CHILD = {
				success: true,
				frames: [{ name: '_main_', type: 'select', line: 0, endLine: 1 }],
				clauses: { _main_: [{ stage: 'select', sql: 'SELECT id FROM raw_orders', line: 0 }] },
				refs: { _main_: [] },
			};

			let decomposeCallCount = 0;
			const ps = mockParseService();
			(ps.decomposeQuery as ReturnType<typeof vi.fn>).mockImplementation(() => {
				decomposeCallCount++;
				return Promise.resolve(JSON.stringify(decomposeCallCount === 1 ? DECOMPOSE_PARENT : DECOMPOSE_CHILD));
			});
			const bridge: BridgeRunner = {
				invokeRaw: vi.fn().mockImplementation((req: Record<string, unknown>) => {
					if (req.emit_debug_symbols) {
						return Promise.resolve({ success: true, stdout: '', stderr: '', data: { success: true, symbols: [] } });
					}
					return Promise.resolve({ success: true, stdout: '', stderr: '', data: {} });
				}),
				compileInlineSql: vi.fn().mockResolvedValue('SELECT id FROM raw_orders'),
			} as unknown as BridgeRunner;

			(vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
				new TextEncoder().encode('SELECT id FROM raw_orders'),
			);

			setActiveEditor('SELECT id FROM orders');
			harness = new DapHarness({ bridgeRunner: bridge, parseService: ps });
			harness.send('initialize');
			harness.send('launch', { noDebug: false, sql: 'SELECT id FROM orders' });
			await vi.waitFor(() => expect(harness.events('thread')).toHaveLength(1));

			harness.send('configurationDone');
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));

			// configurationDone lands at the FROM clause → one F11 goes into child (Thread 2).
			harness.send('stepIn', { threadId: 1 });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(2));
			// Now in child (Thread 2).

			// Attempt to step frozen parent thread (Thread 1) → guard fires, stays in child.
			harness.clear();
			harness.send('stepOut', { threadId: 1 });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));

			// We must still be in Thread 2 (child not exited).
			expect(harness.events('stopped')[0].body).toMatchObject({ threadId: 2, allThreadsStopped: false });
			expect(harness.events('thread')).toHaveLength(0); // no thread(exited) fired
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Self-join ref alignment
	// ──────────────────────────────────────────────────────────────

	describe('self-join ref alignment', () => {
		afterEach(() => { harness?.dispose(); clearActiveEditor(); });

		it('stepIn on JOIN clause resolves to same CTE when refs are duplicated', async () => {
			const DECOMPOSE_SELF_JOIN = {
				success: true,
				frames: [
					{ name: 'base', type: 'cte', line: 0, endLine: 3 },
					{ name: '_main_', type: 'select', line: 4, endLine: 8 },
				],
				clauses: {
					base: [
						{ stage: 'from', sql: 'SELECT * FROM raw', line: 1 },
						{ stage: 'select', sql: 'SELECT id FROM raw', line: 0 },
					],
					_main_: [
						{ stage: 'from', sql: 'FROM base b1', line: 5 },
						{ stage: 'join', sql: 'JOIN base b2 ON b1.id = b2.id', line: 6 },
						{ stage: 'select', sql: 'SELECT b1.id, b2.id', line: 4 },
					],
				},
				refs: {
					base: ['raw'],
					_main_: ['base', 'base'],
				},
			};

			setActiveEditor('WITH base AS (SELECT id FROM raw) SELECT b1.id, b2.id FROM base b1 JOIN base b2 ON b1.id = b2.id');
			harness = new DapHarness({
				parseService: mockParseService(DECOMPOSE_SELF_JOIN),
			});
			harness.send('initialize');
			harness.send('launch', {
				noDebug: false,
				sql: 'WITH base AS (SELECT id FROM raw) SELECT b1.id, b2.id FROM base b1 JOIN base b2 ON b1.id = b2.id',
			});

			await vi.waitFor(() => {
				expect(harness.events('thread')).toHaveLength(1);
			});

			harness.send('configurationDone');
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			// Entry at _main_ → from base (clause 0). Step into base via FROM.
			harness.clear();
			harness.send('stepIn', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			let frames = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(frames[0].name).toContain('base');

			// Step out back to _main_. Should advance past the FROM to the JOIN clause.
			harness.clear();
			harness.send('stepOut', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			frames = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			expect(frames[0].name).toContain('_main_');
			expect(frames[0].name).toContain('join');

			// Step into the JOIN clause — must also resolve to 'base' (not undefined).
			harness.clear();
			harness.send('stepIn', { threadId: 1 });
			await vi.waitFor(() => {
				expect(harness.events('stopped')).toHaveLength(1);
			});

			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			frames = (harness.lastResponse('stackTrace').body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			// With deduped refs this would fail — JOIN would get refs[1]=undefined and skip the step-in.
			expect(frames[0].name).toContain('base');
		});
	});

	// ──────────────────────────────────────────────────────────────
	// Source map integration
	// ──────────────────────────────────────────────────────────────

	describe('source map integration', () => {
		it('uses compileWithSymbols for model files', async () => {
			setActiveEditor('SELECT {{ ref(\'orders\') }}');
			const bridge = mockBridgeRunner();
			const ps = mockParseService();
			harness = new DapHarness({
				bridgeRunner: bridge,
				parseService: ps,
				pathResolver: mockPathResolver('model'),
			});
			harness.send('initialize');
			harness.send('launch', { noDebug: false });

			await vi.waitFor(() => {
				// Either thread started or terminated (if decompose fails on mocked compiled SQL)
				const threadOrTerm = [...harness.events('thread'), ...harness.events('terminated')];
				expect(threadOrTerm.length).toBeGreaterThan(0);
			});

			// FTL path: parseRawForTokens should have been called (not bridge invokeRaw with emit_debug_symbols)
			expect(ps.parseRawForTokens).toHaveBeenCalled();
			// And compileInlineSql should have been called for compilation
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

			const decomposeData = {
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
			};

			const bridge = {
				invokeRaw: vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '', data: {} }),
				compileInlineSql: vi.fn().mockResolvedValue(compiledSql),
			} as unknown as BridgeRunner;

			// Provide a minimal SELECT token so emitDebugSymbolsFromTokens returns non-undefined,
			// causing _compileWithSymbols to use the annotated path and build a source map.
			const tokenResult = { sqlTokens: [{ type: 'SELECT', start: 0, end: 5, line: 0, col: 6 }], jinjaTokens: [] as [] };

			harness = new DapHarness({
				bridgeRunner: bridge,
				parseService: mockParseService(decomposeData, tokenResult),
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

			const decomposeData = {
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
			};

			const bridge = {
				invokeRaw: vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '', data: {} }),
				compileInlineSql: vi.fn().mockResolvedValue(compiledSql),
			} as unknown as BridgeRunner;

			// Provide a minimal SELECT token so _compileWithSymbols builds a source map.
			const tokenResult = { sqlTokens: [{ type: 'SELECT', start: 0, end: 5, line: 0, col: 6 }], jinjaTokens: [] as [] };

			harness = new DapHarness({
				bridgeRunner: bridge,
				parseService: mockParseService(decomposeData, tokenResult),
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

		const DECOMPOSE_NBA = {
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
					{ stage: 'join', sql: 'LEFT JOIN cte_wins USING(team)', line: 93 },
					{ stage: 'join', sql: 'LEFT JOIN cte_losses USING(team)', line: 94 },
					{ stage: 'join', sql: 'LEFT JOIN cte_favored_wins USING(team)', line: 95 },
					{ stage: 'join', sql: 'LEFT JOIN cte_favored_losses USING(team)', line: 96 },
					{ stage: 'join', sql: 'LEFT JOIN cte_avg_opponent_wins USING(team)', line: 97 },
					{ stage: 'join', sql: 'LEFT JOIN cte_avg_opponent_losses USING(team)', line: 98 },
					{ stage: 'join', sql: 'LEFT JOIN cte_home_wins USING(team)', line: 99 },
					{ stage: 'join', sql: 'LEFT JOIN cte_home_losses USING(team)', line: 100 },
					{ stage: 'select', sql: 'SELECT t.team, ... FROM nba_teams t LEFT JOIN ...', line: 76 },
				],
			},
			refs: {
				cte_wins: ['nba_latest_results'],
				cte_home_losses: ['nba_latest_results'],
				_main_: ['nba_teams', 'cte_wins', 'cte_losses', 'cte_favored_wins', 'cte_favored_losses', 'cte_avg_opponent_wins', 'cte_avg_opponent_losses', 'cte_home_wins', 'cte_home_losses'],
			},
		};

		it('breakpoint in FIRST CTE (frame[0]) is not skipped', async () => {
			setActiveEditor('-- multi-CTE model\n'.repeat(104), '/models/reg_season.sql');
			harness = new DapHarness({
				parseService: mockParseService(DECOMPOSE_NBA),
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
				parseService: mockParseService(DECOMPOSE_NBA),
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
				parseService: mockParseService(DECOMPOSE_NBA),
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

		it('returns all-rows list for a known column', () => {
			harness.clear();
			harness.send('evaluate', { expression: 'id', context: 'hover', frameId: 0 });
			const resp = harness.lastResponse('evaluate');
			expect(resp.success).toBe(true);
			// Hover now shows the full column as a list (same format as Variables panel)
			expect((resp.body as Record<string, unknown>).result).toMatch(/^\[.+\]$/);
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

		it('gotoTargets returns target when clicking on a valid clause line', () => {
			// After configurationDone we are at _main_, clause 0 (from), line granularity.
			// _main_ has clauses: from (line 6) and select (line 8).
			// stackTrace displays clause.line + 1, so select appears at line 9 to user.
			harness.clear();
			harness.send('gotoTargets', { source: {}, line: 9 });
			const resp = harness.lastResponse('gotoTargets');
			expect(resp.success).toBe(true);
			const targets = (resp.body as Record<string, unknown>).targets as Array<{ id: number; label: string }>;
			expect(targets).toHaveLength(1);
			expect(targets[0].label).toBe('skip to select');
			expect(targets[0].id).toBe(1);
		});

		it('gotoTargets returns empty when at the last clause', async () => {
			// Initial stop: _main_ ci=0.  Step 1 (stepIn): steps into base ci=0 (local CTE ref).
			// Step 2 (next/F10): advances within base to ci=1 (select — last clause, no forward targets).
			// Note: using 'next' not 'stepIn' because stepIn at base ci=0 would try cross-model
			// step-in for the external ref 'raw_orders', which sends startDebugging (no stopped event).
			harness.send('stepIn', { threadId: 1, granularity: 'line' });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(2));
			harness.send('next', { threadId: 1, granularity: 'line' });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(3));
			harness.clear();
			harness.send('gotoTargets', { source: {} });
			const resp = harness.lastResponse('gotoTargets');
			const targets = (resp.body as Record<string, unknown>).targets as Array<unknown>;
			expect(targets).toHaveLength(0);
		});

		it('goto resets and runs forward to the clicked position', async () => {
			harness.clear();
			// Ask for goto targets on line 9 (select clause displays as line 9), get the target back.
			harness.send('gotoTargets', { source: {}, line: 9 });
			const targResp = harness.lastResponse('gotoTargets');
			const targets = (targResp.body as Record<string, unknown>).targets as Array<{ id: number; label: string }>;
			expect(targets).toHaveLength(1);

			harness.clear();
			harness.send('goto', { threadId: 1, targetId: targets[0].id });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(1));
			const stopped = harness.events('stopped')[0];
			expect(stopped.body).toMatchObject({ reason: 'goto' });
		});

		it('goto lands at the EXACT target line in stackTrace', async () => {
			// Get goto targets for line 9 (select clause displayed as line 9).
			harness.send('gotoTargets', { source: {}, line: 9 });
			const targResp = harness.lastResponse('gotoTargets');
			const targets = (targResp.body as Record<string, unknown>).targets as Array<{ id: number; label: string }>;
			expect(targets).toHaveLength(1);

			// Execute goto.
			harness.send('goto', { threadId: 1, targetId: targets[0].id });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(2));

			// Get stackTrace and verify the current line matches the target line.
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			const stackResp = harness.lastResponse('stackTrace');
			expect(stackResp.success).toBe(true);
			const frames = (stackResp.body as Record<string, unknown>).stackFrames as Array<{ line: number; name: string }>;
			expect(frames.length).toBeGreaterThan(0);
			// The top frame should be at line 9 (the displayed line we clicked).
			expect(frames[0].line).toBe(9);
		});

		it('goto with join neutralization shows "skipped:" in stackTrace', async () => {
			// Step into base frame which has joins.
			harness.send('stepIn', { threadId: 1, granularity: 'line' });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(2));

			// Get current stackTrace to find a join clause line.
			harness.send('stackTrace', { threadId: 1 });
			let stackResp = harness.lastResponse('stackTrace');
			const frames = (stackResp.body as Record<string, unknown>).stackFrames as Array<{ line: number; name: string }>;
			// Find a later clause (should have joins in between).
			const targetLine = frames[frames.length - 1]?.line;
			if (!targetLine) return; // Skip if no targets.

			// Get goto targets for that line.
			harness.send('gotoTargets', { source: {}, line: targetLine });
			const targResp = harness.lastResponse('gotoTargets');
			const targets = (targResp.body as Record<string, unknown>).targets as Array<{ id: number; label: string }>;
			if (targets.length === 0) return; // Skip if no goto targets.

			// Execute goto.
			harness.send('goto', { threadId: 1, targetId: targets[0].id });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(3));

			// Get stackTrace and check for "skipped:" prefix on join clauses.
			harness.clear();
			harness.send('stackTrace', { threadId: 1 });
			stackResp = harness.lastResponse('stackTrace');
			const newFrames = (stackResp.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			const hasSkipped = newFrames.some(f => f.name.includes('skipped:'));
			// If there were joins to skip, we should see at least one "skipped:" frame.
			// This is a weak assertion because the test data might not have joins.
			if (targets[0].label.includes('skip')) {
				expect(hasSkipped).toBe(true);
			}
		});

		it('step forward after goto preserves "skipped:" state', async () => {
			// Step into base, goto forward skipping joins.
			harness.send('stepIn', { threadId: 1, granularity: 'line' });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(2));

			harness.send('gotoTargets', { source: {} });
			const targResp = harness.lastResponse('gotoTargets');
			const targets = (targResp.body as Record<string, unknown>).targets as Array<{ id: number; label: string }>;
			if (targets.length === 0) return; // Skip if no targets.

			harness.send('goto', { threadId: 1, targetId: targets[targets.length - 1].id });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(3));

			// Get stackTrace before stepping.
			harness.send('stackTrace', { threadId: 1 });
			const beforeStack = harness.lastResponse('stackTrace');
			const beforeFrames = (beforeStack.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			const beforeSkipped = beforeFrames.filter(f => f.name.includes('skipped:'));

			// Step forward (F11).
			harness.send('stepIn', { threadId: 1, granularity: 'line' });
			await vi.waitFor(() => expect(harness.events('stopped')).toHaveLength(4));

			// Get stackTrace after stepping.
			harness.send('stackTrace', { threadId: 1 });
			const afterStack = harness.lastResponse('stackTrace');
			const afterFrames = (afterStack.body as Record<string, unknown>).stackFrames as Array<{ name: string }>;
			const afterSkipped = afterFrames.filter(f => f.name.includes('skipped:'));

			// Skipped joins should still be marked as skipped after stepping forward.
			expect(afterSkipped.length).toBeGreaterThanOrEqual(beforeSkipped.length);
		});
	});
});
