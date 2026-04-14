import { describe, it, expect } from 'vitest';
import { parseInlineSuppressions } from '../../ninja/config-loader';

describe('parseInlineSuppressions', () => {
	it('returns empty map for text with no noqa comments', () => {
		const result = parseInlineSuppressions('select 1\nfrom t\n');
		expect(result.size).toBe(0);
	});

	it('parses bare -- noqa as suppressing all rules', () => {
		const result = parseInlineSuppressions('SELECT 1 -- noqa\n');
		expect(result.get(0)).toBe('all');
	});

	it('parses -- noqa: rule1 as suppressing specific rule', () => {
		const result = parseInlineSuppressions('SELECT 1 -- noqa: ninja.cap.keywords\n');
		const suppressed = result.get(0);
		expect(suppressed).toBeInstanceOf(Set);
		expect((suppressed as Set<string>).has('ninja.cap.keywords')).toBe(true);
	});

	it('parses -- noqa: rule1, rule2 as suppressing multiple rules', () => {
		const result = parseInlineSuppressions('SELECT NULL -- noqa: ninja.cap.keywords, ninja.cap.literals\n');
		const suppressed = result.get(0) as Set<string>;
		expect(suppressed.has('ninja.cap.keywords')).toBe(true);
		expect(suppressed.has('ninja.cap.literals')).toBe(true);
	});

	it('handles multiple lines with noqa', () => {
		const text = 'SELECT 1 -- noqa\nSELECT NULL -- noqa: ninja.cap.literals\n';
		const result = parseInlineSuppressions(text);
		expect(result.get(0)).toBe('all');
		expect((result.get(1) as Set<string>).has('ninja.cap.literals')).toBe(true);
	});

	it('ignores noqa on lines without the marker', () => {
		const result = parseInlineSuppressions('SELECT 1\nSELECT 2 -- noqa\n');
		expect(result.has(0)).toBe(false);
		expect(result.get(1)).toBe('all');
	});

	it('handles -- noqa followed by another comment', () => {
		const result = parseInlineSuppressions('SELECT 1 -- noqa -- other comment\n');
		// rest after noqa starts with '-- other comment', which starts with '--'
		expect(result.get(0)).toBe('all');
	});

	it('handles empty text', () => {
		const result = parseInlineSuppressions('');
		expect(result.size).toBe(0);
	});

	it('trims whitespace in rule names', () => {
		const result = parseInlineSuppressions('SELECT 1 -- noqa:  ninja.cap.keywords , ninja.cap.literals \n');
		const suppressed = result.get(0) as Set<string>;
		expect(suppressed.has('ninja.cap.keywords')).toBe(true);
		expect(suppressed.has('ninja.cap.literals')).toBe(true);
	});

	it('handles noqa at the end of file without trailing newline', () => {
		const result = parseInlineSuppressions('SELECT 1 -- noqa');
		expect(result.get(0)).toBe('all');
	});
});
