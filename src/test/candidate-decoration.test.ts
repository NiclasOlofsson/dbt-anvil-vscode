import { describe, it, expect } from 'vitest';
import { makeCandidateDecorator } from '../services/candidate-decoration';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { DocumentModel } from '../services/parse-service';

// ── stubs ────────────────────────────────────────────────────────────────────

const INDEXER = {
	findModelsByName: (name: string) =>
		name === 'stg_orders'
			? [{ materialisation: 'incremental', packageName: 'jaffle_shop', description: 'Order staging' }]
			: [],
	index: {
		sources: new Map(Object.entries({
			a: { sourceName: 'raw', name: 'orders', schema: 'raw_data' },
			// The trap: same table name under a DIFFERENT source. The compound key
			// (sourceName from the call args) must pick the right one.
			b: { sourceName: 'legacy', name: 'orders', schema: 'old_dwh' },
		})),
	},
} as unknown as ManifestIndexer;

/** Two same-named CTEs at different declarations — the span join must pick by position. */
const MODEL = {
	ctes: [
		{ name: 'x', line: 1, col: 4, columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
		{ name: 'x', line: 5, col: 8, columns: [{ name: 'only_one' }] },
	],
} as unknown as DocumentModel;

const decorate = makeCandidateDecorator(INDEXER, () => MODEL);

const cand = (label: string) => ({ label, kind: 'table' }) as never;

// ── tests ────────────────────────────────────────────────────────────────────

describe('makeCandidateDecorator', () => {
	it('decorates a ref template candidate with materialisation and package', () => {
		const d = decorate(cand('stg_orders'), { kind: 'template', call: { name: 'ref', args: ['stg_orders'] } } as never);
		expect(d).toMatchObject({ detail: 'incremental — jaffle_shop', documentation: 'Order staging' });
	});

	it('decorates a FROM-slot table candidate through the same manifest join', () => {
		const d = decorate(cand('stg_orders'), { kind: 'table' } as never);
		expect(d).toMatchObject({ detail: 'incremental — jaffle_shop' });
	});

	it('resolves a source candidate on the compound (sourceName, table) key', () => {
		const d = decorate(cand('orders'), {
			kind: 'template',
			call: { name: 'source', args: ['legacy'] },
		} as never);
		expect(d).toMatchObject({ detail: 'source — old_dwh' });
	});

	it('joins a CTE candidate by declaration span, not by name', () => {
		// Both CTEs are named `x`; the span decides which column count shows.
		const outer = decorate(cand('x'), { kind: 'cte', declarationSpan: { line: 2, column: 4 } } as never);
		expect(outer).toMatchObject({ detail: 'CTE — 3 columns' });
		const shadow = decorate(cand('x'), { kind: 'cte', declarationSpan: { line: 6, column: 8 } } as never);
		expect(shadow).toMatchObject({ detail: 'CTE — 1 column' });
	});

	it('returns undefined on every miss (unknown model, spanless CTE, no indexer)', () => {
		expect(decorate(cand('nope'), { kind: 'table' } as never)).toBeUndefined();
		expect(decorate(cand('x'), { kind: 'cte' } as never)).toBeUndefined();
		expect(decorate(cand('x'), { kind: 'keyword' } as never)).toBeUndefined();
		const bare = makeCandidateDecorator(undefined, () => undefined);
		expect(bare(cand('stg_orders'), { kind: 'table' } as never)).toBeUndefined();
	});
});
