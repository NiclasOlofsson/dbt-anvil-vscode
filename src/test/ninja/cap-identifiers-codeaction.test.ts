import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, colDef, tableRef, applyEditsToText } from './helpers';
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
		const aliasTok = colDef('orderId', 0, 12);
		const m = model({ tokens: [aliasTok] });

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
		// Token positions (line 0):
		//   MyCte def:  col 5..10
		//   MyCte use:  col 47..52
		const sql = 'with MyCte as (select 1) select * from MyCte';
		const doc = mockDocument(sql);
		const cteDef = { type: 'table_ref' as const, name: 'MyCte', line: 0, col: 5, endCol: 10, cteDefinition: true as const };
		const cteUse = { type: 'table_ref' as const, name: 'MyCte', line: 0, col: 39, endCol: 44 };
		const m = model({ tokens: [cteDef, cteUse] });

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

		const ordersRef = tableRef('orders', 0, 24, 'OrdAlias');
		// orders ends at col 30; ` as ` then alias starts at col 34, ends at 42.
		ordersRef.aliasLine = 0;
		ordersRef.aliasCol = 34;
		ordersRef.aliasEndCol = 42;

		const colWithQualifier = {
			type: 'column_ref' as const,
			name: 'id',
			line: 0, col: 16, endCol: 18,
			table: 'OrdAlias',
			tableLine: 0,
			tableCol: 7,
			tableEndCol: 15,
		};

		const m = model({ tokens: [ordersRef, colWithQualifier] });

		const violations = capIdentifiersRule.check({ model: m, document: doc, config: withStyle('snake_case') });
		expect(violations).toHaveLength(1);

		const action = violations[0].action as FixAction;
		// Two ops — alias def + qualifier on the column_ref.
		expect(action.ops.length).toBe(2);

		const after = applyEditsToText(sql, action.ops);
		expect(after).toBe('select ord_alias.id from orders as ord_alias');
	});

	it('autoFix filter excludes the violation from bulk auto-fix flows', () => {
		const aliasTok = colDef('orderId', 0, 12);
		const m = model({ tokens: [aliasTok] });
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
		const aliasTok = colDef('orderId', 0, 12);
		const m = model({ tokens: [aliasTok] });
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
