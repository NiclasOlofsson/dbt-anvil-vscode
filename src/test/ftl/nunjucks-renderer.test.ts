import { describe, it, expect } from 'vitest';
import { buildLineMap, renderForParse } from '../../ftl/nunjucks-renderer.js';

// ── buildLineMap ─────────────────────────────────────────────────────────────
// Mirrors bridge.py _render_jinja_for_parse line-map construction.
// For each Jinja tag, raw_line advances by the tag's internal newline count
// while ren_line stays put.  A new breakpoint is emitted on divergence.

describe('buildLineMap', () => {
    it('returns [[0,0]] for SQL with no Jinja tags', () => {
        expect(buildLineMap('SELECT id FROM users')).toEqual([[0, 0]]);
    });

    it('returns [[0,0]] for SQL with only single-line tags (no divergence)', () => {
        expect(buildLineMap('{{ ref("t") }}\nSELECT 1')).toEqual([[0, 0]]);
        expect(buildLineMap('{% if true %}\nSELECT 1\n{% endif %}')).toEqual([[0, 0]]);
    });

    it('emits a breakpoint when a tag contains a newline', () => {
        // Tag '{{ foo\n}}' has 1 internal newline.
        // raw advances to 1, ren stays at 0 → breakpoint [0, 1].
        expect(buildLineMap('{{ foo\n}}\nSELECT 1')).toEqual([[0, 0], [0, 1]]);
    });

    it('accounts for literal newlines before the tag', () => {
        // 'foo\n{{ bar\nbaz\n}}\nqux'
        // Literal 'foo\n': raw=1, ren=1.
        // Tag '{{ bar\nbaz\n}}' has 2 newlines: raw→3, ren stays 1 → breakpoint [1, 3].
        expect(buildLineMap('foo\n{{ bar\nbaz\n}}\nqux')).toEqual([[0, 0], [1, 3]]);
    });

    it('handles two multi-line tags accumulating divergence', () => {
        // '{{ a\n}}\nlit\n{{ b\nc\n}}\nend'
        // Tag 1 '{{ a\n}}' (1 newline): raw→1, ren stays 0 → breakpoint [0, 1].
        // Literal '\nlit\n': raw=3, ren=2.
        // Tag 2 '{{ b\nc\n}}' (2 newlines): raw→5, ren stays 2 → breakpoint [2, 5].
        expect(buildLineMap('{{ a\n}}\nlit\n{{ b\nc\n}}\nend')).toEqual([[0, 0], [0, 1], [2, 5]]);
    });
});

// ── renderForParse ────────────────────────────────────────────────────────────
// Wraps nunjucks stub rendering + buildLineMap.

describe('renderForParse', () => {
    it('renders unknown macro calls to the stub identifier', () => {
        const { rendered, lineMap } = renderForParse('{{ my_macro() }}');
        expect(rendered).toBe('__jinja__');
        expect(lineMap).toEqual([[0, 0]]);
    });

    it('renders ref() to the last argument', () => {
        const { rendered } = renderForParse("{{ ref('users') }}");
        expect(rendered).toBe('users');
    });

    it('renders source() to the last argument', () => {
        const { rendered } = renderForParse("{{ source('raw', 'orders') }}");
        expect(rendered).toBe('orders');
    });

    it('renders is_incremental() as false, keeping only the else branch', () => {
        const { rendered } = renderForParse(
            '{% if is_incremental() %}OLD{% else %}NEW{% endif %}',
        );
        expect(rendered).toBe('NEW');
    });

    it('returns the raw SQL unchanged when nunjucks fails to render', () => {
        const sql = '{{ unclosed';
        const { rendered } = renderForParse(sql);
        expect(rendered).toBe(sql);
    });

    it('returns correct line map for a multi-line tag', () => {
        const { lineMap } = renderForParse('{{ foo\n}}\nSELECT 1');
        expect(lineMap).toEqual([[0, 0], [0, 1]]);
    });
});
