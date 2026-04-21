import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { mockDocument } from './helpers';
import { planEdits } from '../../ninja/code-actions/edit-planner';
import { FixAction, type NinjaViolation } from '../../ninja/violation';

function fixViolation(
	rule: string,
	edits: Array<{ start: [number, number]; end: [number, number]; text: string }>,
): NinjaViolation {
	return {
		rule,
		message: `${rule} violation`,
		range: new vscode.Range(edits[0].start[0], edits[0].start[1], edits[0].end[0], edits[0].end[1]),
		action: {
			type: FixAction.TYPE,
			autoFix: true,
			ops: edits.map(e => ({
				kind: 'replace' as const,
				range: new vscode.Range(e.start[0], e.start[1], e.end[0], e.end[1]),
				text: e.text,
			})),
		},
	};
}

function snippetViolation(rule: string, line: number, col: number, snippet: string): NinjaViolation {
	return {
		rule,
		message: `${rule} snippet`,
		range: new vscode.Range(line, col, line, col),
		action: { type: 'snippet', position: new vscode.Position(line, col), snippet } as NinjaViolation['action'],
	};
}

describe('edit-planner', () => {
	it('returns no groups when there are no violations', () => {
		const doc = mockDocument('select 1');
		const result = planEdits([], doc);
		expect(result.groups).toEqual([]);
		expect(result.dropped).toEqual([]);
	});

	it('skips snippet actions', () => {
		const doc = mockDocument('select 1');
		const result = planEdits([snippetViolation('rule.snippet', 0, 0, 'x')], doc);
		expect(result.groups).toEqual([]);
	});

	it('passes through non-overlapping edits', () => {
		const doc = mockDocument('select 1, 2, 3');
		const v1 = fixViolation('rule.a', [{ start: [0, 0], end: [0, 6], text: 'SELECT' }]);
		const v2 = fixViolation('rule.b', [{ start: [0, 7], end: [0, 8], text: '11' }]);
		const result = planEdits([v1, v2], doc);
		expect(result.dropped).toEqual([]);
		expect(result.groups).toHaveLength(2);
	});

	it('sorts surviving groups ascending by offset for forward-walk apply', () => {
		const doc = mockDocument('select 1, 2, 3');
		const v1 = fixViolation('rule.a', [{ start: [0, 0], end: [0, 6], text: 'SELECT' }]);
		const v2 = fixViolation('rule.b', [{ start: [0, 7], end: [0, 8], text: '11' }]);
		const result = planEdits([v1, v2], doc);
		const offsets = result.groups.map(g => g.start);
		const sortedAsc = [...offsets].sort((a, b) => a - b);
		expect(offsets).toEqual(sortedAsc);
	});

	it('drops the higher-priority loser when two fix groups overlap', () => {
		const doc = mockDocument('select foo from bar');
		const v1 = fixViolation('rule.outer', [{ start: [0, 7], end: [0, 15], text: 'BAZ FROM' }]);
		const v2 = fixViolation('rule.inner', [{ start: [0, 7], end: [0, 10], text: 'baz' }]);
		const priorityFor = (rule: string) => (rule === 'rule.outer' ? 50 : 200);
		const result = planEdits([v1, v2], doc, { priorityFor });
		expect(result.groups).toHaveLength(1);
		expect((result.groups[0].ops[0] as { kind: 'replace'; text: string }).text).toBe('BAZ FROM');
		expect(result.dropped).toEqual([{ rule: 'rule.inner', reason: 'overlap-loser', winnerRule: 'rule.outer' }]);
	});

	it('arbitrates by emission order on equal priority', () => {
		const doc = mockDocument('select foo from bar');
		const v1 = fixViolation('rule.first', [{ start: [0, 7], end: [0, 10], text: 'aaa' }]);
		const v2 = fixViolation('rule.second', [{ start: [0, 7], end: [0, 10], text: 'bbb' }]);
		const result = planEdits([v1, v2], doc);
		expect(result.groups).toHaveLength(1);
		expect((result.groups[0].ops[0] as { kind: 'replace'; text: string }).text).toBe('aaa');
		expect(result.dropped[0].rule).toBe('rule.second');
	});

	it('treats a paired insert+delete as one atomic group (operator-position pattern)', () => {
		// Mirrors src/ninja/rules/convention-operator-position.ts:65-69 — a delete
		// at one location plus an insert at another, both required to make the fix
		// semantically sound. The planner must consider them together when
		// detecting overlap with another rule.
		const doc = mockDocument('a\nand b');
		const operatorFix = fixViolation('ninja.convention.operator-position', [
			{ start: [1, 0], end: [1, 4], text: '' }, // delete "and "
			{ start: [0, 1], end: [0, 1], text: ' and' }, // insert " and"
		]);
		const recaseFix = fixViolation('rule.recase', [{ start: [1, 0], end: [1, 3], text: 'AND' }]);
		const priorityFor = (rule: string) => (rule === 'ninja.convention.operator-position' ? 50 : 200);
		const result = planEdits([operatorFix, recaseFix], doc, { priorityFor });
		// operator-position group (1 group, 2 ops) survives; recase is dropped.
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0].ops).toHaveLength(2);
		expect(result.dropped).toEqual([
			{ rule: 'rule.recase', reason: 'overlap-loser', winnerRule: 'ninja.convention.operator-position' },
		]);
	});

	it('lets pure insertions at distinct offsets coexist', () => {
		const doc = mockDocument('select foo from bar');
		const v1 = fixViolation('rule.a', [{ start: [0, 7], end: [0, 7], text: '"' }]);
		const v2 = fixViolation('rule.b', [{ start: [0, 10], end: [0, 10], text: '"' }]);
		const result = planEdits([v1, v2], doc);
		expect(result.dropped).toEqual([]);
		expect(result.groups).toHaveLength(2);
	});

	it('flags two pure insertions at the same offset as a conflict', () => {
		const doc = mockDocument('select foo');
		const v1 = fixViolation('rule.a', [{ start: [0, 7], end: [0, 7], text: 'X' }]);
		const v2 = fixViolation('rule.b', [{ start: [0, 7], end: [0, 7], text: 'Y' }]);
		const result = planEdits([v1, v2], doc);
		expect(result.groups).toHaveLength(1);
		expect(result.dropped).toHaveLength(1);
	});

	it('uses the engine priority lookup by default (no override)', () => {
		const doc = mockDocument('select foo');
		const v1 = fixViolation('unknown.first', [{ start: [0, 7], end: [0, 10], text: 'aaa' }]);
		const v2 = fixViolation('unknown.second', [{ start: [0, 7], end: [0, 10], text: 'bbb' }]);
		const result = planEdits([v1, v2], doc);
		expect((result.groups[0].ops[0] as { kind: 'replace'; text: string }).text).toBe('aaa');
	});
});
