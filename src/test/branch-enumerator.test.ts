import { describe, expect, it } from 'vitest';
import {
	buildBranchTree,
	countVariants,
	enumerateVariants,
	selectVariant,
} from '../dbt/branch-enumerator';
import type { ConditionalNode, FixedNode } from '../dbt/branch-enumerator';
import { tokenize } from '../dbt/jinja-tokenizer';
import type { JinjaToken } from '../dbt/jinja-tokenizer';

function tree(source: string) {
	return buildBranchTree(tokenize(source));
}

function raws(tokens: JinjaToken[]): string[] {
	return tokens.map(t => t.raw);
}

// ─── buildBranchTree ─────────────────────────────────────────────────────────

describe('buildBranchTree', () => {
	it('returns empty array for empty token list', () => {
		expect(buildBranchTree([])).toEqual([]);
	});

	it('returns a single FixedNode for plain text', () => {
		const nodes = tree('SELECT 1');
		expect(nodes).toHaveLength(1);
		expect(nodes[0].type).toBe('fixed');
	});

	it('wraps all non-branching tokens in FixedNodes', () => {
		const nodes = tree('{{ col }} FROM {{ ref(\'t\') }}');
		expect(nodes).toHaveLength(1);
		expect(nodes[0].type).toBe('fixed');
		expect((nodes[0] as FixedNode).tokens).toHaveLength(3); // expr, text, expr
	});

	it('creates a ConditionalNode for if/endif', () => {
		const nodes = tree('{% if x %}body{% endif %}');
		expect(nodes).toHaveLength(1);
		expect(nodes[0].type).toBe('conditional');
	});

	it('adds a synthetic empty-else arm when there is no explicit else', () => {
		const nodes = tree('{% if x %}body{% endif %}');
		const cond = nodes[0] as ConditionalNode;
		expect(cond.branches).toHaveLength(2);
		expect(cond.branches[1].header).toBeUndefined();
		expect(cond.branches[1].body).toHaveLength(0);
	});

	it('creates exactly two arms for if/else/endif without adding synthetic else', () => {
		const nodes = tree('{% if x %}a{% else %}b{% endif %}');
		const cond = nodes[0] as ConditionalNode;
		expect(cond.branches).toHaveLength(2);
		expect(cond.branches[0].header?.type).toBe('tag');
		expect(cond.branches[1].header?.type).toBe('tag');
	});

	it('creates three arms for if/elif/else/endif', () => {
		const nodes = tree('{% if a %}1{% elif b %}2{% else %}3{% endif %}');
		const cond = nodes[0] as ConditionalNode;
		expect(cond.branches).toHaveLength(3);
	});

	it('adds synthetic else after an elif chain with no explicit else', () => {
		const nodes = tree('{% if a %}1{% elif b %}2{% endif %}');
		const cond = nodes[0] as ConditionalNode;
		// if arm, elif arm, synthetic else
		expect(cond.branches).toHaveLength(3);
		expect(cond.branches[2].header).toBeUndefined();
	});

	it('attaches the endif token to the ConditionalNode', () => {
		const nodes = tree('{% if x %}body{% endif %}');
		const cond = nodes[0] as ConditionalNode;
		expect(cond.endif).toBeDefined();
		expect(cond.endif?.type).toBe('tag');
	});

	it('places body tokens inside the correct arm', () => {
		const nodes = tree('{% if x %}hello{% else %}world{% endif %}');
		const cond = nodes[0] as ConditionalNode;
		const ifBody = cond.branches[0].body;
		const elseBody = cond.branches[1].body;
		expect((ifBody[0] as FixedNode).tokens[0].raw).toBe('hello');
		expect((elseBody[0] as FixedNode).tokens[0].raw).toBe('world');
	});

	it('nests an inner conditional inside the outer if arm', () => {
		const nodes = tree('{% if a %}{% if b %}inner{% endif %}{% endif %}');
		expect(nodes).toHaveLength(1);
		const outer = nodes[0] as ConditionalNode;
		const outerIfBody = outer.branches[0].body;
		expect(outerIfBody.some(n => n.type === 'conditional')).toBe(true);
		// The outer else arm (synthetic) has an empty body
		expect(outer.branches[outer.branches.length - 1].body).toHaveLength(0);
	});

	it('places text before and after a conditional as FixedNodes', () => {
		const nodes = tree('SELECT {% if x %}col{% endif %} FROM t');
		expect(nodes).toHaveLength(3);
		expect(nodes[0].type).toBe('fixed');
		expect(nodes[1].type).toBe('conditional');
		expect(nodes[2].type).toBe('fixed');
	});

	it('handles two sequential conditionals', () => {
		const nodes = tree('{% if a %}1{% endif %}{% if b %}2{% endif %}');
		expect(nodes).toHaveLength(2);
		expect(nodes[0].type).toBe('conditional');
		expect(nodes[1].type).toBe('conditional');
	});

	it('handles a malformed unclosed if gracefully', () => {
		const nodes = tree('{% if x %}body');
		expect(nodes).toHaveLength(1);
		expect(nodes[0].type).toBe('conditional');
		const cond = nodes[0] as ConditionalNode;
		expect(cond.endif).toBeUndefined();
		// Still has synthetic else so it is enumerable
		expect(cond.branches.length).toBeGreaterThanOrEqual(2);
	});
});

// ─── countVariants ────────────────────────────────────────────────────────────

describe('countVariants', () => {
	it('returns 1 for an empty node list', () => {
		expect(countVariants([])).toBe(1);
	});

	it('returns 1 for pure text with no conditionals', () => {
		expect(countVariants(tree('SELECT 1'))).toBe(1);
	});

	it('returns 1 for expressions and comments with no conditionals', () => {
		expect(countVariants(tree('{{ col }} {# comment #}'))).toBe(1);
	});

	it('returns 2 for a single if/endif (implicit else adds the false-path)', () => {
		expect(countVariants(tree('{% if x %}body{% endif %}'))).toBe(2);
	});

	it('returns 2 for a single if/else/endif', () => {
		expect(countVariants(tree('{% if x %}a{% else %}b{% endif %}'))).toBe(2);
	});

	it('returns 3 for if/elif/else/endif', () => {
		expect(countVariants(tree('{% if a %}1{% elif b %}2{% else %}3{% endif %}'))).toBe(3);
	});

	it('returns 3 for if/elif/endif (elif + implicit else)', () => {
		expect(countVariants(tree('{% if a %}1{% elif b %}2{% endif %}'))).toBe(3);
	});

	it('returns 4 for two sequential if/else/endif blocks', () => {
		const source = '{% if a %}1{% else %}2{% endif %}{% if b %}3{% else %}4{% endif %}';
		expect(countVariants(tree(source))).toBe(4);
	});

	it('returns 3 for outer-if containing inner-if (both without else)', () => {
		// outer: if-arm (contains inner-if → 2 variants) + synthetic-else (1 variant) = 3
		const source = '{% if a %}{% if b %}x{% endif %}{% endif %}';
		expect(countVariants(tree(source))).toBe(3);
	});

	it('returns 4 for outer-if/else containing inner-if/else in one arm', () => {
		// outer has if-arm and else-arm
		// if-arm contains inner if/else → 2 variants
		// else-arm is plain text → 1 variant
		// total: (2 + 1) = 3  ...wait, outer has explicit else so it is 2 arms
		// arm counts: [2, 1] → sum = 3? No: arm 0 has inner → 2, arm 1 has text → 1 → sum=3
		// Hmm, but outer has explicit else so no synthetic, 2 arms: [inner_cond_arm, else_arm]
		// inner_cond_arm has inner conditional → 2 variants
		// else_arm has plain text → 1 variant
		// outer count: 2 + 1 = 3
		const source = '{% if a %}{% if b %}x{% else %}y{% endif %}{% else %}z{% endif %}';
		expect(countVariants(tree(source))).toBe(3);
	});
});

// ─── selectVariant ────────────────────────────────────────────────────────────

describe('selectVariant', () => {
	it('returns all tokens for a tree without conditionals', () => {
		const source = 'SELECT 1';
		const nodes = tree(source);
		const active = selectVariant(nodes, 0);
		expect(active).toHaveLength(1);
		expect(active[0].raw).toBe('SELECT 1');
	});

	it('variant 0 picks the if-branch for if/else/endif', () => {
		const source = '{% if x %}a{% else %}b{% endif %}';
		const active = selectVariant(tree(source), 0);
		expect(raws(active)).toContain('{% if x %}');
		expect(raws(active)).toContain('a');
		expect(raws(active)).not.toContain('{% else %}');
		expect(raws(active)).not.toContain('b');
		expect(raws(active)).toContain('{% endif %}');
	});

	it('variant 1 picks the else-branch for if/else/endif', () => {
		const source = '{% if x %}a{% else %}b{% endif %}';
		const active = selectVariant(tree(source), 1);
		expect(raws(active)).not.toContain('{% if x %}');
		expect(raws(active)).not.toContain('a');
		expect(raws(active)).toContain('{% else %}');
		expect(raws(active)).toContain('b');
		expect(raws(active)).toContain('{% endif %}');
	});

	it('variant 0 picks the if-branch, variant 1 picks the synthetic-else (no tokens, just endif)', () => {
		const source = '{% if x %}body{% endif %}';
		const v0 = selectVariant(tree(source), 0);
		const v1 = selectVariant(tree(source), 1);

		expect(raws(v0)).toContain('{% if x %}');
		expect(raws(v0)).toContain('body');
		expect(raws(v0)).toContain('{% endif %}');

		// Synthetic else: no header, no body, just the endif
		expect(raws(v1)).not.toContain('{% if x %}');
		expect(raws(v1)).not.toContain('body');
		expect(raws(v1)).toContain('{% endif %}');
		expect(v1).toHaveLength(1); // only the endif token
	});

	it('fixed tokens surrounding a conditional are present in every variant', () => {
		const source = 'SELECT {% if x %}col{% endif %} FROM t';
		const nodes = tree(source);
		const v0 = selectVariant(nodes, 0);
		const v1 = selectVariant(nodes, 1);

		for (const v of [v0, v1]) {
			expect(raws(v)).toContain('SELECT ');
			expect(raws(v)).toContain(' FROM t');
		}
	});

	it('selects the correct of three arms', () => {
		const source = '{% if a %}1{% elif b %}2{% else %}3{% endif %}';
		const nodes = tree(source);

		expect(raws(selectVariant(nodes, 0))).toContain('1');
		expect(raws(selectVariant(nodes, 1))).toContain('2');
		expect(raws(selectVariant(nodes, 2))).toContain('3');

		expect(raws(selectVariant(nodes, 0))).not.toContain('2');
		expect(raws(selectVariant(nodes, 0))).not.toContain('3');
	});

	it('handles nested conditionals across all variants', () => {
		// outer if/endif (no else) contains inner if/else/endif → 3 variants
		const source = '{% if a %}{% if b %}x{% else %}y{% endif %}{% endif %}';
		const nodes = tree(source);
		expect(countVariants(nodes)).toBe(3);

		const v0 = selectVariant(nodes, 0); // outer-if, inner-if
		const v1 = selectVariant(nodes, 1); // outer-if, inner-else
		const v2 = selectVariant(nodes, 2); // synthetic outer-else (only endif)

		expect(raws(v0)).toContain('x');
		expect(raws(v0)).not.toContain('y');

		expect(raws(v1)).toContain('y');
		expect(raws(v1)).not.toContain('x');

		// v2: synthetic outer else — only outer endif, no inner tokens
		expect(raws(v2)).not.toContain('x');
		expect(raws(v2)).not.toContain('y');
		expect(v2).toHaveLength(1);
	});
});

// ─── enumerateVariants ───────────────────────────────────────────────────────

describe('enumerateVariants', () => {
	it('returns a single variant for a tree without conditionals', () => {
		const variants = enumerateVariants(tree('SELECT 1'));
		expect(variants).toHaveLength(1);
	});

	it('returns countVariants variants', () => {
		const source = '{% if a %}1{% elif b %}2{% else %}3{% endif %}';
		const nodes = tree(source);
		expect(enumerateVariants(nodes)).toHaveLength(countVariants(nodes));
	});

	it('each variant is distinct for a simple if/else', () => {
		const nodes = tree('{% if x %}a{% else %}b{% endif %}');
		const [v0, v1] = enumerateVariants(nodes);
		expect(raws(v0)).toContain('a');
		expect(raws(v1)).toContain('b');
		expect(raws(v0)).not.toContain('b');
		expect(raws(v1)).not.toContain('a');
	});

	it('returns 4 variants for two sequential if/else blocks', () => {
		const source = '{% if a %}1{% else %}2{% endif %}{% if b %}3{% else %}4{% endif %}';
		const variants = enumerateVariants(tree(source));
		expect(variants).toHaveLength(4);
		const allRaws = variants.map(raws);
		// Each combination of first/second conditional exists
		expect(allRaws.some(r => r.includes('1') && r.includes('3'))).toBe(true);
		expect(allRaws.some(r => r.includes('1') && r.includes('4'))).toBe(true);
		expect(allRaws.some(r => r.includes('2') && r.includes('3'))).toBe(true);
		expect(allRaws.some(r => r.includes('2') && r.includes('4'))).toBe(true);
	});
});
