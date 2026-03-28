import { describe, expect, it } from 'vitest';
import { generateVariants } from '../dbt/sql-variant-generator';

function sql(source: string, index: number): string {
	return generateVariants(source)[index].sql;
}

// ─── invariants ──────────────────────────────────────────────────────────────

describe('generateVariants – invariants', () => {
	it('preserves source length for plain SQL', () => {
		const source = 'SELECT 1 FROM t';
		const [v] = generateVariants(source);
		expect(v.sql.length).toBe(source.length);
	});

	it('preserves source length for a source with one conditional', () => {
		const source = '{% if x %}SELECT 1{% else %}SELECT 2{% endif %}';
		const variants = generateVariants(source);
		for (const v of variants) {
			expect(v.sql.length).toBe(source.length);
		}
	});

	it('preserves source length for nested conditionals', () => {
		const source = '{% if a %}{% if b %}x{% else %}y{% endif %}{% else %}z{% endif %}';
		const variants = generateVariants(source);
		for (const v of variants) {
			expect(v.sql.length).toBe(source.length);
		}
	});

	it('returns exactly one variant for plain SQL', () => {
		expect(generateVariants('SELECT 1')).toHaveLength(1);
	});

	it('returns two variants for if/else/endif', () => {
		expect(generateVariants('{% if x %}a{% else %}b{% endif %}')).toHaveLength(2);
	});

	it('returns three variants for if/elif/else/endif', () => {
		const source = '{% if a %}1{% elif b %}2{% else %}3{% endif %}';
		expect(generateVariants(source)).toHaveLength(3);
	});

	it('variant indices are correct', () => {
		const source = '{% if x %}a{% else %}b{% endif %}';
		const variants = generateVariants(source);
		expect(variants[0].index).toBe(0);
		expect(variants[1].index).toBe(1);
	});
});

// ─── content masking ─────────────────────────────────────────────────────────

describe('generateVariants – content masking', () => {
	it('plain SQL is returned unchanged', () => {
		const source = 'SELECT 1 FROM t';
		expect(generateVariants(source)[0].sql).toBe(source);
	});

	it('variant 0 keeps the if-arm and spaces out the else-arm body', () => {
		const source = '{% if x %}SELECT 1{% else %}SELECT 2{% endif %}';
		const v0 = sql(source, 0);
		// Keep the if header and endif
		expect(v0).toContain('{% if x %}');
		expect(v0).toContain('{% endif %}');
		// Keep if-arm body
		expect(v0).toContain('SELECT 1');
		// Mask else header and body
		expect(v0).not.toContain('{% else %}');
		expect(v0).not.toContain('SELECT 2');
		// Masked region is spaces only
		const elseStart = source.indexOf('{% else %}');
		const endifStart = source.indexOf('{% endif %}');
		const masked = v0.slice(elseStart, endifStart);
		expect(masked.trim()).toBe('');
	});

	it('variant 1 keeps the else-arm and spaces out the if-arm body', () => {
		const source = '{% if x %}SELECT 1{% else %}SELECT 2{% endif %}';
		const v1 = sql(source, 1);
		expect(v1).not.toContain('{% if x %}');
		expect(v1).not.toContain('SELECT 1');
		expect(v1).toContain('{% else %}');
		expect(v1).toContain('SELECT 2');
		expect(v1).toContain('{% endif %}');

		const ifStart = source.indexOf('{% if x %}');
		const elseStart = source.indexOf('{% else %}');
		const masked = v1.slice(ifStart, elseStart);
		expect(masked.trim()).toBe('');
	});

	it('tokens on either side of a conditional are in every variant', () => {
		const source = 'SELECT {% if x %}col{% else %}other{% endif %} FROM t';
		const variants = generateVariants(source);
		for (const v of variants) {
			expect(v.sql).toContain('SELECT ');
			expect(v.sql).toContain(' FROM t');
		}
	});

	it('three-arm variant selects the right body each time', () => {
		const source = '{% if a %}1{% elif b %}2{% else %}3{% endif %}';
		const v0 = sql(source, 0);
		const v1 = sql(source, 1);
		const v2 = sql(source, 2);

		expect(v0).toContain('1');
		expect(v0).not.toContain('2');
		expect(v0).not.toContain('3');

		expect(v1).toContain('2');
		expect(v1).not.toContain('1');
		expect(v1).not.toContain('3');

		expect(v2).toContain('3');
		expect(v2).not.toContain('1');
		expect(v2).not.toContain('2');
	});

	it('implicit-else variant is all spaces except for the endif', () => {
		const source = '{% if x %}body{% endif %}';
		const v1 = sql(source, 1); // synthetic-else path
		// The endif is kept; everything else is spaces
		expect(v1).toContain('{% endif %}');
		// Everything before the endif is spaces
		const endifStart = source.indexOf('{% endif %}');
		expect(v1.slice(0, endifStart).trim()).toBe('');
	});

	it('expressions inside the active arm are kept', () => {
		const source = '{% if x %}{{ col }}{% else %}other{% endif %}';
		const v0 = sql(source, 0);
		expect(v0).toContain('{{ col }}');
		expect(v0).not.toContain('other');
	});

	it('masking does not affect surrounding fixed content', () => {
		const source = 'A {% if x %}B{% endif %} C';
		const v0 = sql(source, 0);
		const v1 = sql(source, 1);
		expect(v0[0]).toBe('A');
		expect(v1[0]).toBe('A');
		expect(v0[v0.length - 1]).toBe('C');
		expect(v1[v1.length - 1]).toBe('C');
	});
});

// ─── nested conditionals ─────────────────────────────────────────────────────

describe('generateVariants – nested conditionals', () => {
	it('returns 3 variants for outer-if (no else) containing inner if/else', () => {
		const source = '{% if a %}{% if b %}x{% else %}y{% endif %}{% endif %}';
		expect(generateVariants(source)).toHaveLength(3);
	});

	it('variant 0: outer-if + inner-if → x visible', () => {
		const source = '{% if a %}{% if b %}x{% else %}y{% endif %}{% endif %}';
		expect(sql(source, 0)).toContain('x');
		expect(sql(source, 0)).not.toContain('y');
	});

	it('variant 1: outer-if + inner-else → y visible', () => {
		const source = '{% if a %}{% if b %}x{% else %}y{% endif %}{% endif %}';
		expect(sql(source, 1)).toContain('y');
		expect(sql(source, 1)).not.toContain('x');
	});

	it('variant 2: synthetic outer-else → no x, no y', () => {
		const source = '{% if a %}{% if b %}x{% else %}y{% endif %}{% endif %}';
		const v2 = sql(source, 2);
		expect(v2).not.toContain('x');
		expect(v2).not.toContain('y');
	});

	it('all nested variants preserve length', () => {
		const source = '{% if a %}{% if b %}x{% else %}y{% endif %}{% endif %}';
		for (const v of generateVariants(source)) {
			expect(v.sql.length).toBe(source.length);
		}
	});
});

// ─── two sequential conditionals ─────────────────────────────────────────────

describe('generateVariants – two sequential conditionals', () => {
	it('returns 4 variants', () => {
		const source = '{% if a %}1{% else %}2{% endif %}{% if b %}3{% else %}4{% endif %}';
		expect(generateVariants(source)).toHaveLength(4);
	});

	it('covers all four combinations', () => {
		const source = '{% if a %}1{% else %}2{% endif %}{% if b %}3{% else %}4{% endif %}';
		const sqls = generateVariants(source).map(v => v.sql);
		expect(sqls.some(s => s.includes('1') && s.includes('3'))).toBe(true);
		expect(sqls.some(s => s.includes('1') && s.includes('4'))).toBe(true);
		expect(sqls.some(s => s.includes('2') && s.includes('3'))).toBe(true);
		expect(sqls.some(s => s.includes('2') && s.includes('4'))).toBe(true);
	});

	it('all four variants preserve source length', () => {
		const source = '{% if a %}1{% else %}2{% endif %}{% if b %}3{% else %}4{% endif %}';
		for (const v of generateVariants(source)) {
			expect(v.sql.length).toBe(source.length);
		}
	});
});
