import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryResult, CancelSignal } from '../providers/database/database-provider';
import type { DbtJobPriority } from '../dbt/execution-service';
import { QueryRunner, type StatementResult } from '../dbt/query-runner';

// -------- vscode stub --------
vi.mock('vscode', () => ({
	workspace: {
		getConfiguration: () => ({
			get: (key: string, defaultValue: unknown) => defaultValue,
		}),
	},
	window: {
		withProgress: async (_opts: unknown, task: (progress: { report: () => void }, token: { onCancellationRequested: (cb: () => void) => void }) => Promise<void>) => {
			const progress = { report: () => {} };
			const token = { onCancellationRequested: () => {} };
			await task(progress, token);
		},
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	ProgressLocation: { Notification: 15 },
}));

// -------- helpers --------
function makeQueryResult(rowCount: number): QueryResult {
	return {
		columns: ['id'],
		rows: Array.from({ length: rowCount }, (_, i) => ({ id: i })),
		rowCount,
		executionTimeMs: 10,
	};
}

function makeFakeProvider(results: Array<QueryResult | Error>) {
	let callIndex = 0;
	const calls: Array<{ sql: string; limit: number; priority?: DbtJobPriority }> = [];
	return {
		calls,
		provider: {
			adapterType: 'test',
			query: async (sql: string, limit: number, _signal?: CancelSignal, priority?: DbtJobPriority) => {
				calls.push({ sql, limit, priority });
				const r = results[callIndex++];
				if (r instanceof Error) throw r;
				return r;
			},
			describe: async () => [],
			listSchemas: async () => [],
			listTables: async () => [],
		},
	};
}

function makeEditor(text: string, cursorOffset: number, selectionStart?: number, selectionEnd?: number) {
	const lines = text.split('\n');
	const offsetToPosition = (off: number) => {
		let remaining = off;
		for (let line = 0; line < lines.length; line++) {
			const lineLen = lines[line].length + 1; // +1 for \n
			if (remaining < lineLen) return { line, character: remaining };
			remaining -= lineLen;
		}
		return { line: lines.length - 1, character: lines[lines.length - 1].length };
	};

	const cursorPos = offsetToPosition(cursorOffset);
	const hasSelection = selectionStart !== undefined && selectionEnd !== undefined && selectionStart !== selectionEnd;

	return {
		document: {
			getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
				if (!range) return text;
				// Convert positions back to offsets and substr
				let startOff = 0;
				for (let i = 0; i < range.start.line; i++) startOff += lines[i].length + 1;
				startOff += range.start.character;
				let endOff = 0;
				for (let i = 0; i < range.end.line; i++) endOff += lines[i].length + 1;
				endOff += range.end.character;
				return text.substring(startOff, endOff);
			},
			offsetAt: (pos: { line: number; character: number }) => {
				let off = 0;
				for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
				return off + pos.character;
			},
			languageId: 'jinja-sql',
		},
		selection: hasSelection
			? {
				isEmpty: false,
				active: cursorPos,
				start: offsetToPosition(selectionStart),
				end: offsetToPosition(selectionEnd),
			}
			: {
				isEmpty: true,
				active: cursorPos,
			},
	};
}

// -------- tests --------

describe('QueryRunner', () => {
	let collectedResults: StatementResult[];
	let onResults: (results: StatementResult[]) => void;

	beforeEach(() => {
		collectedResults = [];
		onResults = (r) => { collectedResults = r; };
	});

	it('executes single statement from cursor', async () => {
		const { provider, calls } = makeFakeProvider([makeQueryResult(3)]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor('SELECT 1', 4);

		await runner.executeFromEditor(editor as never);

		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toBe('SELECT 1');
		expect(collectedResults).toHaveLength(1);
		expect(collectedResults[0].result?.rowCount).toBe(3);
	});

	it('executes statement at cursor position in multi-statement file', async () => {
		const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3';
		//                        ^ cursor at offset 10 = start of "SELECT 2"
		const { provider, calls } = makeFakeProvider([makeQueryResult(1)]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor(sql, 10);

		await runner.executeFromEditor(editor as never);

		expect(calls).toHaveLength(1);
		expect(calls[0].sql.trim()).toBe('SELECT 2');
	});

	it('executes selected text (single statement)', async () => {
		const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3';
		// Select "SELECT 2" (offset 10..18)
		const { provider, calls } = makeFakeProvider([makeQueryResult(5)]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor(sql, 10, 10, 18);

		await runner.executeFromEditor(editor as never);

		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toBe('SELECT 2');
	});

	it('splits selected multi-statement text and executes all', async () => {
		const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3';
		// Select "SELECT 1;\nSELECT 2" (offset 0..18)
		const { provider, calls } = makeFakeProvider([makeQueryResult(1), makeQueryResult(2)]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor(sql, 0, 0, 18);

		await runner.executeFromEditor(editor as never);

		expect(calls).toHaveLength(2);
		expect(calls[0].sql.trim()).toBe('SELECT 1');
		expect(calls[1].sql.trim()).toBe('SELECT 2');
		expect(collectedResults).toHaveLength(2);
	});

	it('executes all statements with executeAll', async () => {
		const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3';
		const { provider, calls } = makeFakeProvider([
			makeQueryResult(1), makeQueryResult(2), makeQueryResult(3),
		]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor(sql, 0);

		await runner.executeAll(editor as never);

		expect(calls).toHaveLength(3);
		expect(collectedResults).toHaveLength(3);
	});

	it('collects errors per statement when stopOnError is false', async () => {
		const sql = 'SELECT 1;\nBAD SQL;\nSELECT 3';
		const { provider } = makeFakeProvider([
			makeQueryResult(1),
			new Error('syntax error'),
			makeQueryResult(3),
		]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor(sql, 0);

		await runner.executeAll(editor as never);

		expect(collectedResults).toHaveLength(3);
		expect(collectedResults[0].result).toBeDefined();
		expect(collectedResults[1].error).toBe('syntax error');
		expect(collectedResults[2].result).toBeDefined();
	});

	it('does nothing for empty document', async () => {
		const { provider, calls } = makeFakeProvider([]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor('', 0);

		await runner.executeFromEditor(editor as never);

		expect(calls).toHaveLength(0);
		expect(collectedResults).toHaveLength(0);
	});

	it('does nothing for whitespace-only document', async () => {
		const { provider, calls } = makeFakeProvider([]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor('  \n  \n  ', 0);

		await runner.executeFromEditor(editor as never);

		expect(calls).toHaveLength(0);
		expect(collectedResults).toHaveLength(0);
	});

	it('passes default limit of 500', async () => {
		const { provider, calls } = makeFakeProvider([makeQueryResult(1)]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor('SELECT 1', 0);

		await runner.executeFromEditor(editor as never);

		expect(calls[0].limit).toBe(500);
	});

	it('passes User priority', async () => {
		const { provider, calls } = makeFakeProvider([makeQueryResult(1)]);
		const runner = new QueryRunner(provider as never, onResults);
		const editor = makeEditor('SELECT 1', 0);

		await runner.executeFromEditor(editor as never);

		// Priority.User = 3
		expect(calls[0].priority).toBe(3);
	});

	it('executeSql runs a raw SQL string', async () => {
		const { provider, calls } = makeFakeProvider([makeQueryResult(7)]);
		const runner = new QueryRunner(provider as never, onResults);

		await runner.executeSql('SELECT 42');

		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toBe('SELECT 42');
		expect(collectedResults).toHaveLength(1);
		expect(collectedResults[0].result?.rowCount).toBe(7);
	});

	it('executeSql splits multi-statement input', async () => {
		const { provider, calls } = makeFakeProvider([makeQueryResult(1), makeQueryResult(2)]);
		const runner = new QueryRunner(provider as never, onResults);

		await runner.executeSql('SELECT 1;\nSELECT 2');

		expect(calls).toHaveLength(2);
		expect(collectedResults).toHaveLength(2);
	});
});
