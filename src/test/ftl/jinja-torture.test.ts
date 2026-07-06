/**
 * The jinja-torture corpus gate: samples/jinja-torture is a purpose-built dbt
 * project whose models distill every templating shape that has bitten a real
 * project (each model's header names its origin). Three gates per model:
 *
 *   parse  — syntax-error expectations. 'clean' models must parse without
 *            syntax errors; 'open' models are tripwires (it.fails) tied to a
 *            named upstream channel item — they go RED the moment the fix
 *            lands, forcing the flip to 'clean'.
 *   format — reflow idempotence for every parse-clean model: formatting the
 *            formatted output must be a no-op. Byte-oracles can be added per
 *            model later; idempotence is the oracle-free floor.
 *   ninja  — expected/forbidden rule ids where declared, including one
 *            deliberate violation so the gate can never go vacuously green.
 *
 * The map below is CLOSED over the models directory: an unmapped model or a
 * mapped-but-missing file fails the suite, so the corpus cannot drift.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SqllensDocumentParser } from '../../ftl/sqllens/document-parser';
import { makeTemplateProvider } from '../../ftl/sqllens/template-shape';
import { reflowDocument } from '../../ninja/reflow/engine';
import { runNinja } from '../../ninja/engine';
import { cfg, mockDocument } from '../ninja/helpers';
import type { DocumentModel } from '../../services/parse-service';

const PROJECT = path.join(__dirname, '..', '..', '..', 'samples', 'jinja-torture');

type ParseExpectation = 'clean' | { open: string };

const PARSE: Record<string, ParseExpectation> = {
	'stg_orders.sql': 'clean',
	'stg_customers.sql': 'clean',
	'stg_sites.sql': 'clean',
	'and_mode_trailing.sql': 'clean',
	'where_mode_trailing.sql': 'clean',
	'where_mode_after_from.sql': 'clean',
	'whole_model_multiline.sql': 'clean',
	'whole_model_oneline.sql': 'clean',
	'twin_tags.sql': 'clean',
	'forloop_union.sql': 'clean',
	'left_outer_ninja.sql': 'clean',
	'bare_join_violation.sql': 'clean',
	'quoted_identifiers.sql': 'clean',
};

/**
 * glued_from.sql keeps a stronger gate than error-freedom: before sqllens
 * caaf882 the fill FUSED with the glued FROM keyword into one identifier — a
 * silent misparse (no FROM clause at all). The gate demands a real table_ref
 * so that failure mode can never come back unnoticed.
 */
const GLUED = 'glued_from.sql';

/**
 * Format-gate tripwires: reflow is not yet a fixed point on these shapes —
 * pass 2 explodes a paren-wrapped multi-line ON predicate that pass 1 left
 * inline. Extension-side printer item (ours, not upstream). Flip to the
 * plain gate when the printer converges.
 */
const FORMAT_OPEN = new Set(['and_mode_trailing.sql', 'where_mode_trailing.sql']);

const NINJA: Record<string, { expects: string[]; absent: string[] }> = {
	'left_outer_ninja.sql': { expects: [], absent: ['ninja.ambiguity.implicit-join'] },
	'bare_join_violation.sql': { expects: ['ninja.ambiguity.implicit-join'], absent: [] },
};

function macroCatalog(): Map<string, string> {
	const cat = new Map<string, string>();
	for (const f of fs.readdirSync(path.join(PROJECT, 'macros'))) {
		if (!f.endsWith('.sql')) continue;
		const src = fs.readFileSync(path.join(PROJECT, 'macros', f), 'utf8');
		for (const m of src.matchAll(/\{%-?\s*macro\s+([A-Za-z0-9_]+)\s*\(/g)) {
			const start = m.index!;
			const end = src.indexOf('endmacro', start);
			cat.set(m[1], src.slice(start, end === -1 ? undefined : end + 12));
		}
	}
	return cat;
}

const catalog = macroCatalog();
const parser = new SqllensDocumentParser({
	adapterType: 'databricks',
	templateProvider: makeTemplateProvider(n => catalog.get(n)),
});

const modelFiles = fs.readdirSync(path.join(PROJECT, 'models')).filter(f => f.endsWith('.sql'));

function readModel(name: string): string {
	return fs.readFileSync(path.join(PROJECT, 'models', name), 'utf8');
}

function syntaxErrors(model: DocumentModel): string[] {
	return (model.parseWarnings ?? []).filter(w => w.type === 'syntax_error').map(w => w.message);
}

describe('jinja-torture corpus — map is closed over the models directory', () => {
	it('every model has a parse expectation and every expectation a model', () => {
		expect(modelFiles.sort()).toEqual([...Object.keys(PARSE), GLUED].sort());
	});
});

describe('jinja-torture corpus — parse gate', () => {
	for (const [name, expectation] of Object.entries(PARSE)) {
		if (expectation === 'clean') {
			it(`${name} parses without syntax errors`, async () => {
				const model = await parser.parse(readModel(name));
				expect(syntaxErrors(model)).toEqual([]);
			});
		} else {
			// TRIPWIRE: goes red when the upstream fix lands — flip to 'clean'.
			it.fails(`${name} still open: ${expectation.open}`, async () => {
				const model = await parser.parse(readModel(name));
				expect(syntaxErrors(model)).toEqual([]);
			});
		}
	}

	it(`${GLUED} parses with a real relation (no fill fusing into the keyword)`, async () => {
		const model = await parser.parse(readModel(GLUED));
		expect(syntaxErrors(model)).toEqual([]);
		expect(model.tokens.some(t => t.type === 'table_ref')).toBe(true);
	});

	it('twin_tags: same-length fills stay distinct (name-keyed consumers must not collide)', async () => {
		const model = await parser.parse(readModel('twin_tags.sql'));
		const names = model.finalColumns.map(c => c.name);
		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe('jinja-torture corpus — format gate (reflow idempotence)', () => {
	const cleanModels = Object.entries(PARSE).filter(([, e]) => e === 'clean').map(([n]) => n);
	for (const name of cleanModels) {
		const gate = async (): Promise<void> => {
			const source = readModel(name);
			const model = await parser.parse(source);
			const first = reflowDocument(mockDocument(source), model, cfg());
			const formatted = first.edit ? first.edit.newText : source;
			const model2 = await parser.parse(formatted);
			const second = reflowDocument(mockDocument(formatted), model2, cfg());
			const reformatted = second.edit ? second.edit.newText : formatted;
			expect(reformatted).toBe(formatted);
		};
		if (FORMAT_OPEN.has(name)) {
			// TRIPWIRE: flips red when the printer converges on this shape.
			it.fails(`${name} reflow not yet idempotent (paren-ON explosion, printer item)`, gate);
		} else {
			it(`${name} reflow is idempotent`, gate);
		}
	}
});

describe('jinja-torture corpus — ninja gate', () => {
	for (const [name, exp] of Object.entries(NINJA)) {
		it(`${name} surfaces exactly the expected rules`, async () => {
			const source = readModel(name);
			const model = await parser.parse(source);
			const result = runNinja(mockDocument(source), model, [], cfg());
			const ids = new Set(result.violations.map(v => v.rule));
			for (const must of exp.expects) expect(ids, `expected ${must}`).toContain(must);
			for (const not of exp.absent) expect(ids, `must not surface ${not}`).not.toContain(not);
		});
	}
});
