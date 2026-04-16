import { describe, it, expect } from 'vitest';
import { run, violationsFor } from './helpers';

const RULE = 'ninja.layout.long-lines';

describe(RULE, () => {
	it('flags lines exceeding maxLineLength', () => {
		const longLine = 'select ' + 'a'.repeat(200);
		const v = violationsFor(run(longLine + '\n'), RULE);
		expect(v.length).toBe(1);
	});

	it('passes lines within limit', () => {
		const v = violationsFor(run('select 1\n', { maxLineLength: 120 }), RULE);
		expect(v.length).toBe(0);
	});

	it('flags lines at exactly maxLineLength + 1', () => {
		const line = 'a'.repeat(121);
		const v = violationsFor(run(line + '\n', { maxLineLength: 120 }), RULE);
		expect(v.length).toBe(1);
	});

	it('passes lines at exactly maxLineLength', () => {
		const line = 'a'.repeat(120);
		const v = violationsFor(run(line + '\n', { maxLineLength: 120 }), RULE);
		expect(v.length).toBe(0);
	});

	it('reports correct character count in message', () => {
		const line = 'a'.repeat(150);
		const v = violationsFor(run(line + '\n', { maxLineLength: 120 }), RULE);
		expect(v[0].message).toContain('150');
		expect(v[0].message).toContain('120');
	});

	it('flags multiple long lines', () => {
		const line = 'a'.repeat(150);
		const v = violationsFor(run(line + '\n' + line + '\n', { maxLineLength: 120 }), RULE);
		expect(v.length).toBe(2);
		expect(v[0].range.start.line).toBe(0);
		expect(v[1].range.start.line).toBe(1);
	});

	it('does not provide auto-fix', () => {
		const longLine = 'select ' + 'a'.repeat(200);
		const v = violationsFor(run(longLine + '\n'), RULE);
		expect(v[0].action).toBeUndefined();
	});

	it('is not fixable — no TextEdit provided', () => {
		const longLine = 'select ' + 'a'.repeat(200);
		const v = violationsFor(run(longLine + '\n'), RULE);
		expect(v[0].action).toBeUndefined();
	});

	it('uses custom maxLineLength config', () => {
		const v = violationsFor(run('a'.repeat(81) + '\n', { maxLineLength: 80 }), RULE);
		expect(v.length).toBe(1);
	});

	it('handles CRLF line endings', () => {
		const longLine = 'a'.repeat(130);
		const v = violationsFor(run(longLine + '\r\n', { maxLineLength: 120 }), RULE);
		expect(v.length).toBe(1);
	});

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});

	it('range starts at maxLineLength column', () => {
		const longLine = 'a'.repeat(150);
		const v = violationsFor(run(longLine + '\n', { maxLineLength: 120 }), RULE);
		expect(v[0].range.start.character).toBe(120);
		expect(v[0].range.end.character).toBe(150);
	});
});
