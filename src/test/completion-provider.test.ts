import { describe, it, expect, vi } from 'vitest';
import type { ParseService } from '../services/parse-service';
import type { Completion } from '../ftl/sqllens/api';

import { DbtCompletionProvider } from '../providers/sql/completion-provider';
import { ParseService as RealParseService } from '../services/parse-service';
import { SqllensDocumentParser } from '../ftl/sqllens/document-parser';
import { createMockLogger } from './helpers';

// ─── helpers ─────────────────────────────────────────────────────────────────

const TOKEN = { isCancellationRequested: false };
const CTX = {};

function mockDocument(lines: string[]) {
	const text = lines.join('\n');
	return {
		getText: () => text,
		lineAt: (line: number) => ({ text: lines[line] ?? '' }),
		offsetAt: ({ line, character }: { line: number; character: number }) => {
			let offset = 0;
			for (let i = 0; i < line; i++) offset += (lines[i]?.length ?? 0) + 1; // +1 for \n
			return offset + character;
		},
		positionAt: (offset: number) => {
			let remaining = offset;
			for (let line = 0; line < lines.length; line++) {
				if (remaining <= (lines[line]?.length ?? 0)) return { line, character: remaining };
				remaining -= (lines[line]?.length ?? 0) + 1;
			}
			return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
		},
		uri: { toString: () => 'file:///test.sql' },
		version: 1,
	};
}

/** A ParseService stub exposing only `completeAt` — the one method the provider calls. */
function serviceReturning(candidates: Completion[]): { service: ParseService; completeAt: ReturnType<typeof vi.fn> } {
	const completeAt = vi.fn().mockReturnValue(candidates);
	return { service: { completeAt } as unknown as ParseService, completeAt };
}

function run(candidates: Completion[], lines: string[], character: number, line = 0) {
	const { service, completeAt } = serviceReturning(candidates);
	const provider = new DbtCompletionProvider(createMockLogger(), service);
	const items = provider.provideCompletionItems(
		mockDocument(lines) as never,
		{ line, character } as never,
		TOKEN as never,
		CTX as never,
	);
	return { items, completeAt };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('DbtCompletionProvider — maps sqllens candidates by kind', () => {
	it('maps each content kind to its CompletionItemKind and passes detail through', () => {
		const { items } = run(
			[
				{ label: 'base', kind: 'cte', detail: 'in-scope CTE' },
				{ label: 'customers', kind: 'table' },
				{ label: 'niclas_gold', kind: 'namespace' },
				{ label: 'order_id', kind: 'column', detail: 'bigint' },
				{ label: 'my_model', kind: 'template', detail: 'table — jaffle' },
			],
			['select '],
			7,
		);

		const by = (label: string) => items!.find(i => i.label === label)!;
		expect(by('base').kind).toBe(5 /* Variable */);
		expect(by('base').detail).toBe('in-scope CTE');
		expect(by('customers').kind).toBe(17 /* Reference */);
		expect(by('customers').detail).toBeUndefined();
		expect(by('niclas_gold').kind).toBe(8 /* Module */);
		expect(by('order_id').kind).toBe(4 /* Field */);
		expect(by('order_id').detail).toBe('bigint');
		expect(by('my_model').kind).toBe(17 /* Reference */);
		expect(by('my_model').detail).toBe('table — jaffle');
	});

	it('renders functions as a snippet (Function kind) and keywords (Keyword kind)', () => {
		const { items } = run(
			[
				{ label: 'ifnull', kind: 'function' },
				{ label: 'coalesce', kind: 'function', detail: 'returns first non-null' },
				{ label: 'FROM', kind: 'keyword' },
			],
			['select ifn'],
			10,
		);

		const ifnull = items!.find(i => i.label === 'ifnull')!;
		expect(ifnull.kind).toBe(2 /* Function */);
		expect((ifnull.insertText as unknown as { value: string }).value).toBe('ifnull($0)');
		expect(ifnull.detail).toBe('SQL function'); // default when sqllens gives none

		expect(items!.find(i => i.label === 'coalesce')!.detail).toBe('returns first non-null');

		const from = items!.find(i => i.label === 'FROM')!;
		expect(from.kind).toBe(13 /* Keyword */);
	});

	it('sorts content candidates before functions and keywords, preserving sqllens order', () => {
		// sqllens hands them back in one list; we keep its order for content and push fn/kw last.
		const { items } = run(
			[
				{ label: 'base', kind: 'cte' },
				{ label: 'customers', kind: 'table' },
				{ label: 'ifnull', kind: 'function' },
				{ label: 'FROM', kind: 'keyword' },
			],
			['from '],
			5,
		);
		const sort = (label: string) => items!.find(i => i.label === label)!.sortText;
		expect(sort('base')).toBe('0000');
		expect(sort('customers')).toBe('0001');
		expect(sort('ifnull')).toBe('8_ifnull');
		expect(sort('FROM')).toBe('9_FROM');
		// content < function < keyword
		expect(sort('customers')! < sort('ifnull')!).toBe(true);
		expect(sort('ifnull')! < sort('FROM')!).toBe(true);
	});

	it('preserves sqllens shadow-rank: an in-scope CTE ahead of a same-named table', () => {
		const { items } = run(
			[
				{ label: 'orders', kind: 'cte' },
				{ label: 'orders', kind: 'table' },
			],
			['from ord'],
			8,
		);
		expect(items!).toHaveLength(2);
		expect(items![0].kind).toBe(5 /* Variable — the CTE */);
		expect(items![0].sortText).toBe('0000');
		expect(items![1].kind).toBe(17 /* Reference — the table */);
		expect(items![1].sortText).toBe('0001');
	});

	it('applies sqllens replaceRange as every item\'s replacement range', () => {
		// sqllens 1.6.0: candidates arrive prefix-pruned with the typed fragment's span,
		// delimiter-aware ("my_t includes the opening quote). The items must replace that
		// exact span so accepting never leaves a stray fragment or quote behind.
		const candidates = [
			{ label: 'customers', kind: 'table' },
			{ label: 'cust_orders', kind: 'cte' },
			{ label: 'current_date', kind: 'function' },
		] as Completion[] & { replaceRange?: { start: number; end: number } };
		candidates.replaceRange = { start: 7, end: 11 }; // the "cust" fragment
		const { items } = run(candidates, ['select cust'], 11);

		for (const item of items!) {
			expect(item.range).toBeDefined();
			const r = item.range as { start: { line: number; character: number }; end: { line: number; character: number } };
			expect(r.start).toMatchObject({ line: 0, character: 7 });
			expect(r.end).toMatchObject({ line: 0, character: 11 });
		}
	});

	it('sets no range when sqllens reports no replaceRange (empty-prefix caret)', () => {
		const { items } = run([{ label: 'customers', kind: 'table' }], ['select '], 7);
		expect(items![0].range).toBeUndefined();
	});

	it('a jinja call slot maps the template candidates and nothing else leaks', () => {
		// sqllens answers a jinja call slot with kind "template" only — no SQL columns leak in.
		const { items } = run(
			[{ label: 'customers', kind: 'template', detail: 'table — jaffle' }],
			['select 1 from {{ ref(\'cu'],
			24,
		);
		expect(items!.map(i => i.label)).toEqual(['customers']);
		expect(items![0].kind).toBe(17 /* Reference */);
		expect(items![0].detail).toBe('table — jaffle');
	});

	it('asks sqllens once at the caret offset — one offset serves both jinja and SQL', () => {
		const { completeAt } = run([{ label: 'ifnull', kind: 'function' }], ['SELECT ifn'], 10);
		// The caret (10), NOT the word start — sqllens 1.4.0 made the caret token the token being typed.
		expect(completeAt).toHaveBeenCalledTimes(1);
		expect(completeAt).toHaveBeenCalledWith('SELECT ifn', 10, 'file:///test.sql');
	});

	it('returns undefined when sqllens has no candidates', () => {
		const { items } = run([], ['select '], 7);
		expect(items).toBeUndefined();
	});

	it('skips completion inside a SQL line comment (before touching sqllens)', () => {
		const { items, completeAt } = run([{ label: 'ifnull', kind: 'function' }], ['-- select ifn'], 13);
		expect(items).toBeUndefined();
		expect(completeAt).not.toHaveBeenCalled();
	});
});

describe('DbtCompletionProvider — end-to-end with the real parser (no mocked completeAt)', () => {
	it('completes ifnull at a CASE value slot in a databricks jinja model, typing a bare word (no dot)', () => {
		// Whole chain, nothing stubbed: provider → real ParseService → real SqllensDocumentParser →
		// sqllens completeAt. Mirrors the reported screenshot.
		const parser = new SqllensDocumentParser({ adapterType: 'databricks' });
		const parseService = new RealParseService(parser, createMockLogger());
		const provider = new DbtCompletionProvider(createMockLogger(), parseService);

		const lines = [
			'select',
			'  case',
			'    when ve.defaultdimension is not null then ifn',
			'  end as gold_chainkey',
			'from {{ ref(\'some_model\') }} ve',
		];
		const items = provider.provideCompletionItems(
			mockDocument(lines) as never,
			{ line: 2, character: lines[2].length } as never,
			TOKEN as never,
			CTX as never,
		);

		const ifnull = items!.find(i => i.label === 'ifnull');
		expect(ifnull, 'ifnull should be offered as a function completion').toBeDefined();
		expect(ifnull!.kind).toBe(2 /* Function */);
	});
});
