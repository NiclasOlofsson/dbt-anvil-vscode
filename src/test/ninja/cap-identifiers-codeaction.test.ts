import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sym, colSym, symbolBindings, applyEditsToText } from './helpers';
import { capIdentifiersRule } from '../../ninja/rules/cap-identifiers';
import { filterAutoFixViolations } from '../../providers/sql/formatting-provider';
import { FixAction } from '../../ninja/violation';
import type { NinjaConfig } from '../../ninja/config';

function withStyle(style: NinjaConfig['capitalisation']['identifiers']['style']): NinjaConfig {
	return cfg({
		capitalisation: {
			...cfg().capitalisation,
			identifiers: {
				style,
				acronyms: ['ID', 'URL'],
				words: [],
			},
		},
	});
}

describe('cap-identifiers code-action integration', () => {
	it('applies a column-alias rename in-file via the FixAction ops', () => {
		// Source: select 1 as orderId from t
		//                     ^^^^^^^ position 12..19
		const sql = 'select 1 as orderId from t';
		const doc = mockDocument(sql);
		const aliasSym = sym('column', 'orderId', 0, 12, { modifiers: ['declaration', 'output'] });
		const m = model({ symbols: [aliasSym] });

		const violations = capIdentifiersRule.check({ model: m, document: doc, config: withStyle('snake_case') });
		expect(violations).toHaveLength(1);

		const action = violations[0].action as FixAction;
		expect(action.type).toBe(FixAction.TYPE);
		expect(action.autoFix).toBe(false);

		const after = applyEditsToText(sql, action.ops);
		expect(after).toBe('select 1 as order_id from t');
	});

	it('renames a CTE definition and every reference atomically', () => {
		// Source: with MyCte as (select 1) select * from MyCte
		// Sym positions (line 0):
		//   MyCte def:  col 5..10
		//   MyCte use:  col 39..44
		const sql = 'with MyCte as (select 1) select * from MyCte';
		const doc = mockDocument(sql);
		const cteDef = sym('cte', 'MyCte', 0, 5, { modifiers: ['declaration'] });
		const cteUse = sym('cte', 'MyCte', 0, 39);
		const m = model({ symbols: [cteDef, cteUse] });

		const violations = capIdentifiersRule.check({ model: m, document: doc, config: withStyle('snake_case') });
		expect(violations).toHaveLength(1);

		const action = violations[0].action as FixAction;
		// Two ops — def + use, both rewritten.
		expect(action.ops.length).toBe(2);

		const after = applyEditsToText(sql, action.ops);
		expect(after).toBe('with my_cte as (select 1) select * from my_cte');
	});

	it('renames a table alias and its qualifier spans atomically', () => {
		// Source: select OrdAlias.id from orders as OrdAlias
		const sql = 'select OrdAlias.id from orders as OrdAlias';
		const doc = mockDocument(sql);

		const ordersRelation = sym('table', 'orders', 0, 24);
		// orders ends at col 30; ` as ` then alias starts at col 34, ends at 42.
		const alias = sym('alias', 'OrdAlias', 0, 34, { modifiers: ['declaration'] });
		// Qualifier `OrdAlias` spans col 7..15, name `id` spans col 16..18.
		const colWithQualifier = colSym(0, [{ name: 'OrdAlias', col: 7 }, { name: 'id', col: 16 }]);

		const m = model({
			symbols: [ordersRelation, alias, colWithQualifier],
			symbolBindings: symbolBindings({
				aliasOf: [[ordersRelation, alias]],
				sourceOf: [[colWithQualifier, ordersRelation]],
			}),
		});

		const violations = capIdentifiersRule.check({ model: m, document: doc, config: withStyle('snake_case') });
		expect(violations).toHaveLength(1);

		const action = violations[0].action as FixAction;
		// Two ops — alias def + qualifier on the column ref.
		expect(action.ops.length).toBe(2);

		const after = applyEditsToText(sql, action.ops);
		expect(after).toBe('select ord_alias.id from orders as ord_alias');
	});

	it('autoFix filter excludes the violation from bulk auto-fix flows', () => {
		const aliasSym = sym('column', 'orderId', 0, 12, { modifiers: ['declaration', 'output'] });
		const m = model({ symbols: [aliasSym] });
		const doc = mockDocument('select 1 as orderId from t');
		const ninjaConfig = withStyle('snake_case');

		const violations = capIdentifiersRule.check({ model: m, document: doc, config: ninjaConfig });
		expect(violations).toHaveLength(1);

		const autoFixable = filterAutoFixViolations(violations, ninjaConfig);
		// autoFix: false on the action → never participates in bulk apply.
		expect(autoFixable).toHaveLength(0);
	});

	it('autoFix filter includes the violation when config overrides the rule to true', () => {
		// Even though the rule defaults to autoFix: false, config.autoFix.rules[ruleId]
		// = true should opt the user into bulk apply. This documents the override path.
		const aliasSym = sym('column', 'orderId', 0, 12, { modifiers: ['declaration', 'output'] });
		const m = model({ symbols: [aliasSym] });
		const doc = mockDocument('select 1 as orderId from t');
		const ninjaConfig: NinjaConfig = {
			...withStyle('snake_case'),
			autoFix: {
				...cfg().autoFix,
				rules: { 'ninja.cap.identifiers': true },
			},
		};

		const violations = capIdentifiersRule.check({ model: m, document: doc, config: ninjaConfig });
		const autoFixable = filterAutoFixViolations(violations, ninjaConfig);
		expect(autoFixable).toHaveLength(1);
	});
});
