import { describe, expect, it, vi } from 'vitest';
import {
	parseWithJinjaFallback,
	type ParsePass,
} from '../../ftl/parse-with-jinja-fallback';
import type { LineMap } from '../../ftl/nunjucks-renderer';

// The helper orchestrates the three-pass cascade. We don't care about sqlglot
// here — runOnce is a stub that lets us script which passes "succeed". This
// tests the surface contract that PyodideSqlParser.parse / traceLineageV2
// rely on (specifically, that `pass === 'pass2'` is what drives the consumer
// to set the `isPass2` flag and apply line-remapping).

describe('parseWithJinjaFallback', () => {
	it('returns pass 1 result when the first pass succeeds', () => {
		const runOnce = vi.fn((sql: string, pass: ParsePass) => ({ sql, pass }));
		const out = parseWithJinjaFallback(
			'SELECT id FROM users',
			runOnce,
			() => true,
		);

		expect(out.pass).toBe('pass1');
		expect(out.lineMap).toBeUndefined();
		expect(runOnce).toHaveBeenCalledTimes(1);
		expect(runOnce.mock.calls[0][1]).toBe('pass1');
	});

	it('falls through to pass 1b when pass 1 fails', () => {
		const runOnce = vi.fn((sql: string, pass: ParsePass) => ({ sql, pass }));
		const out = parseWithJinjaFallback(
			'SELECT * FROM tbl\n{{ my_macro() }}',
			runOnce,
			r => r.pass !== 'pass1',
		);

		expect(out.pass).toBe('pass1b');
		expect(out.lineMap).toBeUndefined();
		expect(runOnce).toHaveBeenCalledTimes(2);
		expect(runOnce.mock.calls[0][1]).toBe('pass1');
		expect(runOnce.mock.calls[1][1]).toBe('pass1b');
	});

	it('falls through to pass 2 (nunjucks render) when both blanker passes fail', () => {
		const runOnce = vi.fn((sql: string, pass: ParsePass, _lineMap?: LineMap) => ({ sql, pass }));
		const out = parseWithJinjaFallback(
			'SELECT 1',
			runOnce,
			r => r.pass === 'pass2',
		);

		expect(out.pass).toBe('pass2');
		// Pass 2 always exposes a lineMap so the caller can remap AST positions.
		expect(out.lineMap).toBeDefined();
		expect(runOnce).toHaveBeenCalledTimes(3);
		expect(runOnce.mock.calls.map(c => c[1])).toEqual(['pass1', 'pass1b', 'pass2']);
		// Pass 2 hand-off includes the lineMap as the third arg.
		expect(runOnce.mock.calls[2][2]).toBe(out.lineMap);
	});

	it('returns the pass 2 result even when pass 2 also "fails" — caller decides what to do', () => {
		// The helper does not retry past pass 2. If pass 2 also yields a
		// not-success result, that result is still returned with pass='pass2'.
		// Consumers (PyodideSqlParser.parse) treat pass 2 success/failure
		// uniformly — they always apply the post-processing.
		const runOnce = vi.fn((sql: string, pass: ParsePass) => ({ sql, pass }));
		const out = parseWithJinjaFallback('SELECT 1', runOnce, () => false);

		expect(out.pass).toBe('pass2');
		expect(runOnce).toHaveBeenCalledTimes(3);
	});

	it('passes the blanked SQL (not raw) to pass 1 and pass 1b', () => {
		const seen: Array<{ pass: ParsePass; sql: string }> = [];
		const runOnce = vi.fn((sql: string, pass: ParsePass) => {
			seen.push({ pass, sql });
			return { sql, pass };
		});
		// Statement-level macro forces pass 1 to fail; pass 1b succeeds.
		const raw = 'SELECT * FROM tbl\n{{ my_macro() }}';
		parseWithJinjaFallback(raw, runOnce, r => r.pass === 'pass1b');

		const pass1 = seen.find(s => s.pass === 'pass1')!;
		const pass1b = seen.find(s => s.pass === 'pass1b')!;
		// Both passes preserve length and newlines.
		expect(pass1.sql).toHaveLength(raw.length);
		expect(pass1b.sql).toHaveLength(raw.length);
		// Identifier mode (pass 1) emits a unique ID, not the macro name.
		expect(pass1.sql).toContain('__j');
		expect(pass1.sql).not.toContain('my_macro');
		// Comment mode (pass 1b) wraps the tag in /* */.
		expect(pass1b.sql).toContain('/*');
		expect(pass1b.sql).toContain('*/');
	});

	it('populates idMap with original tag info for unique-ID replacements', () => {
		const raw = 'SELECT {{ my_macro() }}, {{ var("x") }} FROM tbl';
		const out = parseWithJinjaFallback(raw, (sql, pass) => ({ sql, pass }), () => true);

		expect(out.idMap.size).toBe(2);
		const entries = [...out.idMap.entries()];
		// Keys are unique IDs.
		expect(entries[0][0]).toMatch(/^__j\w+__$/);
		expect(entries[1][0]).toMatch(/^__j\w+__$/);
		expect(entries[0][0]).not.toBe(entries[1][0]);
		// Values carry the original tag text.
		const originals = entries.map(([, v]) => v.original);
		expect(originals).toContain('{{ my_macro() }}');
		expect(originals).toContain('{{ var("x") }}');
	});

	it('idMap is empty for pass 2 (nunjucks render)', () => {
		const out = parseWithJinjaFallback('SELECT 1', (sql, pass) => ({ sql, pass }), () => false);
		expect(out.pass).toBe('pass2');
		expect(out.idMap.size).toBe(0);
	});
});
