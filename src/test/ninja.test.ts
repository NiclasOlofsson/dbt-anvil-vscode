import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, type NinjaConfig } from '../ninja/config';
import { runNinja, type NinjaResult } from '../ninja/engine';
import type { DocumentModel } from '../services/parse-service';
import * as vscode from 'vscode';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal NinjaConfig with optional overrides. */
function cfg(overrides: Partial<NinjaConfig> = {}): NinjaConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

/** Build a minimal mock vscode.TextDocument from SQL text. */
function mockDocument(text: string): vscode.TextDocument {
	const lines = text.split('\n');
	return {
		getText: () => text,
		positionAt(offset: number) {
			let remaining = offset;
			for (let i = 0; i < lines.length; i++) {
				// +1 accounts for the newline character
				if (remaining <= lines[i].length) return new vscode.Position(i, remaining);
				remaining -= lines[i].length + 1;
			}
			return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
		},
		offsetAt(pos: vscode.Position) {
			let offset = 0;
			for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
			return offset + pos.character;
		},
		lineAt(line: number) {
			return { text: lines[line], lineNumber: line, range: new vscode.Range(line, 0, line, lines[line].length) };
		},
		lineCount: lines.length,
		uri: vscode.Uri.file('/test.sql'),
		fileName: '/test.sql',
		languageId: 'sql',
		version: 1,
		isDirty: false,
		isUntitled: false,
		isClosed: false,
		eol: 1,
		save: async () => true,
		getWordRangeAtPosition: () => undefined,
		validateRange: (r: vscode.Range) => r,
		validatePosition: (p: vscode.Position) => p,
	} as unknown as vscode.TextDocument;
}

/** Empty DocumentModel (no tokens → all words are candidates for capitalisation rules). */
const emptyModel: DocumentModel = {
	ctes: [],
	refs: [],
	sources: [],
	finalColumns: [],
	tokens: [],
	timing: { parseMs: 0, totalMs: 0 },
};

/** Run ninja and return result for convenience. */
function run(sql: string, config?: Partial<NinjaConfig>, model?: DocumentModel): NinjaResult {
	const doc = mockDocument(sql);
	return runNinja(doc, model ?? emptyModel, [], cfg(config));
}

/** Shortcut: return just rule IDs for all violations. */
function ruleIds(result: NinjaResult): string[] {
	return result.violations.map(v => v.rule);
}

// ── Capitalisation rules ───────────────────────────────────────────────────

describe('ninja.cap.keywords', () => {
	it('flags uppercase keyword when policy is lower', () => {
		const r = run('SELECT 1', { capitalisation: { ...DEFAULT_CONFIG.capitalisation, keywords: 'lower' } });
		const kw = r.violations.filter(v => v.rule === 'ninja.cap.keywords');
		expect(kw.length).toBe(1);
		expect(kw[0].message).toContain('select');
	});

	it('passes when keyword matches policy', () => {
		const r = run('select 1', { capitalisation: { ...DEFAULT_CONFIG.capitalisation, keywords: 'lower' } });
		const kw = r.violations.filter(v => v.rule === 'ninja.cap.keywords');
		expect(kw.length).toBe(0);
	});

	it('flags lowercase keyword when policy is upper', () => {
		const r = run('select 1', { capitalisation: { ...DEFAULT_CONFIG.capitalisation, keywords: 'upper' } });
		const kw = r.violations.filter(v => v.rule === 'ninja.cap.keywords');
		expect(kw.length).toBe(1);
		expect(kw[0].message).toContain('SELECT');
	});

	it('flags inconsistent keywords', () => {
		// consistent mode checks per-keyword: 'select' first seen lower → 'SELECT' later is inconsistent
		const r = run('select 1\nSELECT 2', { capitalisation: { ...DEFAULT_CONFIG.capitalisation, keywords: 'consistent' } });
		const kw = r.violations.filter(v => v.rule === 'ninja.cap.keywords');
		expect(kw.length).toBe(1);
		expect(kw[0].message).toContain('select');
	});

	it('provides an auto-fix', () => {
		const r = run('SELECT 1');
		const kw = r.violations.filter(v => v.rule === 'ninja.cap.keywords');
		expect(kw[0].fix).toBeDefined();
		expect(kw[0].fix![0].newText).toBe('select');
	});
});

describe('ninja.cap.functions', () => {
	it('flags uppercase function when policy is lower', () => {
		const r = run('select COUNT(*) from t', { capitalisation: { ...DEFAULT_CONFIG.capitalisation, functions: 'lower' } });
		const fn = r.violations.filter(v => v.rule === 'ninja.cap.functions');
		expect(fn.length).toBe(1);
		expect(fn[0].message).toContain('count');
	});

	it('ignores functions not followed by parenthesis', () => {
		// 'count' as a column name, not a function call
		const r = run('select count from t', { capitalisation: { ...DEFAULT_CONFIG.capitalisation, functions: 'upper' } });
		const fn = r.violations.filter(v => v.rule === 'ninja.cap.functions');
		expect(fn.length).toBe(0);
	});
});

describe('ninja.cap.literals', () => {
	it('flags uppercase NULL when policy is lower', () => {
		const r = run('select NULL');
		const lit = r.violations.filter(v => v.rule === 'ninja.cap.literals');
		expect(lit.length).toBe(1);
		expect(lit[0].fix![0].newText).toBe('null');
	});

	it('passes lowercase null', () => {
		const r = run('select null');
		const lit = r.violations.filter(v => v.rule === 'ninja.cap.literals');
		expect(lit.length).toBe(0);
	});
});

describe('ninja.cap.types', () => {
	it('flags uppercase type when policy is lower', () => {
		const r = run('select cast(x as VARCHAR)');
		const types = r.violations.filter(v => v.rule === 'ninja.cap.types');
		expect(types.length).toBe(1);
		expect(types[0].fix![0].newText).toBe('varchar');
	});

	it('flags lowercase type when policy is upper', () => {
		const r = run('select cast(x as int)', { capitalisation: { ...DEFAULT_CONFIG.capitalisation, types: 'upper' } });
		const types = r.violations.filter(v => v.rule === 'ninja.cap.types');
		expect(types.length).toBe(1);
		expect(types[0].fix![0].newText).toBe('INT');
	});

	it('passes when type matches lower policy', () => {
		const r = run('select cast(x as integer)');
		const types = r.violations.filter(v => v.rule === 'ninja.cap.types');
		expect(types.length).toBe(0);
	});
});

// ── Layout rules ───────────────────────────────────────────────────────────

describe('ninja.layout.trailing-whitespace (LT01)', () => {
	it('detects trailing spaces', () => {
		const r = run('select 1   \n');
		const tw = r.violations.filter(v => v.rule === 'ninja.layout.trailing-whitespace');
		expect(tw.length).toBe(1);
	});

	it('passes clean lines', () => {
		const r = run('select 1\n');
		const tw = r.violations.filter(v => v.rule === 'ninja.layout.trailing-whitespace');
		expect(tw.length).toBe(0);
	});
});

describe('ninja.layout.trailing-newline (LT12)', () => {
	it('flags file not ending with newline', () => {
		const r = run('select 1');
		const tn = r.violations.filter(v => v.rule === 'ninja.layout.trailing-newline');
		expect(tn.length).toBe(1);
	});

	it('passes file ending with single newline', () => {
		const r = run('select 1\n');
		const tn = r.violations.filter(v => v.rule === 'ninja.layout.trailing-newline');
		expect(tn.length).toBe(0);
	});
});

describe('ninja.layout.leading-whitespace (LT13)', () => {
	it('flags file starting with blank lines', () => {
		const r = run('\n\nselect 1\n');
		const lw = r.violations.filter(v => v.rule === 'ninja.layout.leading-whitespace');
		expect(lw.length).toBe(1);
	});

	it('passes file starting with content', () => {
		const r = run('select 1\n');
		const lw = r.violations.filter(v => v.rule === 'ninja.layout.leading-whitespace');
		expect(lw.length).toBe(0);
	});
});

describe('ninja.layout.max-blank-lines (LT15)', () => {
	it('flags consecutive blank lines', () => {
		const r = run('select 1\n\n\nfrom t\n');
		const bl = r.violations.filter(v => v.rule === 'ninja.layout.max-blank-lines');
		expect(bl.length).toBe(1);
	});

	it('allows single blank line', () => {
		const r = run('select 1\n\nfrom t\n');
		const bl = r.violations.filter(v => v.rule === 'ninja.layout.max-blank-lines');
		expect(bl.length).toBe(0);
	});
});

describe('ninja.layout.long-lines (LT05)', () => {
	it('flags lines exceeding maxLineLength', () => {
		const longLine = 'select ' + 'a'.repeat(200);
		const r = run(longLine + '\n');
		const ll = r.violations.filter(v => v.rule === 'ninja.layout.long-lines');
		expect(ll.length).toBe(1);
	});

	it('passes lines within limit', () => {
		const r = run('select 1\n', { maxLineLength: 120 });
		const ll = r.violations.filter(v => v.rule === 'ninja.layout.long-lines');
		expect(ll.length).toBe(0);
	});
});

describe('ninja.layout.indent (LT02)', () => {
	it('flags tabs when unit is space', () => {
		const r = run('select\n\t1\n');
		const indent = r.violations.filter(v => v.rule === 'ninja.layout.indent');
		expect(indent.length).toBe(1);
		expect(indent[0].message).toContain('tabs');
	});

	it('flags spaces when unit is tab', () => {
		const r = run('select\n    1\n', { indentation: { unit: 'tab', size: 4 } });
		const indent = r.violations.filter(v => v.rule === 'ninja.layout.indent');
		expect(indent.length).toBe(1);
		expect(indent[0].message).toContain('spaces');
	});

	it('flags non-multiple-of-size indentation', () => {
		const r = run('select\n   1\n', { indentation: { unit: 'space', size: 4 } });
		const indent = r.violations.filter(v => v.rule === 'ninja.layout.indent');
		expect(indent.length).toBe(1);
		expect(indent[0].message).toContain('3 spaces');
	});

	it('passes correct space indentation', () => {
		const r = run('select\n    1\n', { indentation: { unit: 'space', size: 4 } });
		const indent = r.violations.filter(v => v.rule === 'ninja.layout.indent');
		expect(indent.length).toBe(0);
	});

	it('flags mixed spaces and tabs', () => {
		const r = run('select\n \t1\n');
		const indent = r.violations.filter(v => v.rule === 'ninja.layout.indent');
		expect(indent.length).toBe(1);
		expect(indent[0].message).toContain('Mixed');
	});
});

describe('ninja.layout.function_spacing (LT06)', () => {
	it('flags space before opening parenthesis', () => {
		const r = run('select count (*) from t\n');
		const fs = r.violations.filter(v => v.rule === 'ninja.layout.function_spacing');
		expect(fs.length).toBe(1);
		expect(fs[0].message).toContain('count');
	});

	it('passes function with no space', () => {
		const r = run('select count(*) from t\n');
		const fs = r.violations.filter(v => v.rule === 'ninja.layout.function_spacing');
		expect(fs.length).toBe(0);
	});

	it('provides a delete fix', () => {
		const r = run('select count (*) from t\n');
		const fs = r.violations.filter(v => v.rule === 'ninja.layout.function_spacing');
		expect(fs[0].fix).toBeDefined();
		expect(fs[0].fix![0].newText).toBe('');
	});
});

// ── Jinja padding ──────────────────────────────────────────────────────────

describe('ninja.jinja.padding (JJ01)', () => {
	it('flags missing space in expression delimiter', () => {
		const sql = '{{ref("orders")}}';
		const doc = mockDocument(sql);
		const r = runNinja(doc, emptyModel, [], cfg());
		const jp = r.violations.filter(v => v.rule === 'ninja.jinja.padding');
		expect(jp.length).toBeGreaterThan(0);
	});

	it('passes properly padded expression', () => {
		const sql = '{{ ref("orders") }}';
		const doc = mockDocument(sql);
		const r = runNinja(doc, emptyModel, [], cfg());
		const jp = r.violations.filter(v => v.rule === 'ninja.jinja.padding');
		expect(jp.length).toBe(0);
	});
});

// ── Engine integration ─────────────────────────────────────────────────────

describe('engine', () => {
	it('returns empty violations when disabled', () => {
		const r = run('SELECT 1', { enabled: false });
		expect(r.violations.length).toBe(0);
	});

	it('respects rule severity override to off', () => {
		const r = run('SELECT 1', { rules: { 'ninja.cap.keywords': 'off' } });
		const kw = r.violations.filter(v => v.rule === 'ninja.cap.keywords');
		expect(kw.length).toBe(0);
	});

	it('suppresses violations with -- noqa', () => {
		const r = run('SELECT 1 -- noqa\n');
		const kw = r.violations.filter(v => v.rule === 'ninja.cap.keywords');
		expect(kw.length).toBe(0);
	});

	it('suppresses specific rule with -- noqa: rule', () => {
		const r = run('SELECT NULL -- noqa: ninja.cap.keywords\n');
		const kw = r.violations.filter(v => v.rule === 'ninja.cap.keywords');
		expect(kw.length).toBe(0);
		// NULL should still be flagged (cap.literals not suppressed)
		const lit = r.violations.filter(v => v.rule === 'ninja.cap.literals');
		expect(lit.length).toBe(1);
	});

	it('populates severityMap', () => {
		const r = run('SELECT 1');
		expect(r.severityMap.has('ninja.cap.keywords')).toBe(true);
	});
});
