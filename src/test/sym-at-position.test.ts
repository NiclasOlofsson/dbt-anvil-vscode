/**
 * Cursor → Sym hit-testing via sqllens's `symbolAt` (stage-1 accessor).
 *
 * Pins the two things the adoption changes on purpose:
 *  - the signature speaks absolute char OFFSETS (what `TextDocument.offsetAt`
 *    yields natively), not (line, column) pairs;
 *  - "narrowest covering symbol" ranks by TRUE character width. The retired
 *    hand-rolled ranking approximated width as lineSpan*1e6 + columnDelta,
 *    which mis-ranked a wide single-line span against a narrow multi-line one.
 */
import { describe, expect, it } from 'vitest';
import { ParseService } from '../services/parse-service';
import type { DocumentModel } from '../services/parse-service';
import { MAIN_FRAME } from '../ftl/sqllens/api';
import type { Span, Sym } from '../ftl/sqllens/api';

function span(start: number, end: number, line: number, column: number, endLine: number, endColumn: number): Span {
	return { start, end, line, column, endLine, endColumn };
}

function sym(name: string, s: Span, kind: Sym['kind'] = 'column'): Sym {
	return { kind, modifiers: ['reference'], name, span: s, frame: MAIN_FRAME };
}

function model(symbols: Sym[]): DocumentModel {
	return { ctes: [], refs: [], sources: [], finalColumns: [], timing: { parseMs: 0, totalMs: 0 }, symbols };
}

describe('ParseService.symAtPosition (offset-based, true char width)', () => {
	it('returns the narrowest covering symbol by character width, not line-count approximation', () => {
		// A wide single-line symbol (200 chars on line 1) and a narrow two-line
		// symbol (50 chars spanning lines 1-2) both cover offset 150. The old
		// metric ranked the two-liner at 1e6+, so the 200-char span always won;
		// true char width says the 50-char span is narrower.
		const wideOneLiner = sym('wide', span(0, 200, 1, 0, 1, 200));
		const narrowTwoLiner = sym('narrow', span(140, 190, 1, 140, 2, 9));
		const m = model([wideOneLiner, narrowTwoLiner]);

		expect(ParseService.symAtPosition(m, 150)?.name).toBe('narrow');
	});

	it('misses outside every span and never matches a zero-width span', () => {
		const zeroWidth = sym('star-expanded', span(10, 10, 1, 10, 1, 10));
		const real = sym('real', span(20, 25, 1, 20, 1, 25));
		const m = model([zeroWidth, real]);

		expect(ParseService.symAtPosition(m, 10)).toBeUndefined();
		expect(ParseService.symAtPosition(m, 5)).toBeUndefined();
		expect(ParseService.symAtPosition(m, 24)?.name).toBe('real');
		// end-exclusive
		expect(ParseService.symAtPosition(m, 25)).toBeUndefined();
	});

	it('partIndexAtPosition resolves the dotted part by offset', () => {
		// `o.order_id` at offsets 30..40: qualifier `o` [30,31), name [32,40).
		const dotted: Sym = {
			...sym('o.order_id', span(30, 40, 1, 30, 1, 40)),
			partSpans: [span(30, 31, 1, 30, 1, 31), span(32, 40, 1, 32, 1, 40)],
		};
		expect(ParseService.partIndexAtPosition(dotted, 30)).toBe(0);
		expect(ParseService.partIndexAtPosition(dotted, 35)).toBe(1);
		expect(ParseService.partIndexAtPosition(dotted, 31)).toBeUndefined(); // the dot
		expect(ParseService.partIndexAtPosition(sym('bare', span(0, 4, 1, 0, 1, 4)), 2)).toBeUndefined();
	});
});
