import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sym, symbolBindings } from './helpers';
import { capIdentifiersRule } from '../../ninja/rules/cap-identifiers';
import { FixAction } from '../../ninja/violation';
import type { DocumentModel } from '../../services/parse-service';
import type { Sym } from '../../ftl/sqllens/api';
import type { NinjaConfig } from '../../ninja/config';

const RULE = 'ninja.cap.identifiers';

function withIdentifierStyle(style: NinjaConfig['capitalisation']['identifiers']['style']): NinjaConfig {
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

function check(symbols: Sym[], config: NinjaConfig, modelOverrides: Partial<DocumentModel> = {}) {
	const m = model({ ...modelOverrides, symbols });
	const doc = mockDocument('');
	return capIdentifiersRule.check({ model: m, document: doc, config });
}

describe(RULE, () => {
	// ── Style off — no violations regardless of input ─────────────────────

	it('emits no violations when identifier style is off', () => {
		const symbols: Sym[] = [
			sym('column', 'OrderId', 0, 7, { modifiers: ['declaration', 'output'] }),
			sym('column', 'customer_id', 0, 20, { modifiers: ['declaration', 'output'] }),
		];
		const v = check(symbols, withIdentifierStyle('off'));
		expect(v).toHaveLength(0);
	});

	// ── snake_case policy ─────────────────────────────────────────────────

	it('passes a column alias that matches snake_case', () => {
		const symbols: Sym[] = [sym('column', 'order_id', 0, 7, { modifiers: ['declaration', 'output'] })];
		const v = check(symbols, withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(0);
	});

	it('flags a column alias that violates snake_case', () => {
		const symbols: Sym[] = [sym('column', 'orderId', 0, 7, { modifiers: ['declaration', 'output'] })];
		const v = check(symbols, withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('orderId');
		expect(v[0].message).toContain('order_id');           // suggestion appears in message
	});

	it('attaches a FixAction with autoFix=false for the violation', () => {
		const symbols: Sym[] = [sym('column', 'orderId', 0, 7, { modifiers: ['declaration', 'output'] })];
		const v = check(symbols, withIdentifierStyle('snake_case'));
		expect(v[0].action?.type).toBe(FixAction.TYPE);
		const action = v[0].action as FixAction;
		expect(action.autoFix).toBe(false);
		expect(action.ops.length).toBeGreaterThan(0);
		expect(action.ops[0].kind).toBe('replace');
	});

	it('emits NO violation when a single-word identifier conforms trivially', () => {
		// `order` matches snake_case (single lowercase word). No flag.
		const symbols: Sym[] = [sym('column', 'order', 0, 7, { modifiers: ['declaration', 'output'] })];
		const v = check(symbols, withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(0);
	});

	// ── camelCase policy ──────────────────────────────────────────────────

	it('passes a column alias that matches camelCase', () => {
		const symbols: Sym[] = [sym('column', 'orderId', 0, 7, { modifiers: ['declaration', 'output'] })];
		const v = check(symbols, withIdentifierStyle('camelCase'));
		expect(v).toHaveLength(0);
	});

	it('flags a column alias that violates camelCase', () => {
		// `id` is in the configured acronym list so the suggestion preserves
		// it as `ID` — that's the configured behaviour, not a bug.
		const symbols: Sym[] = [sym('column', 'order_id', 0, 7, { modifiers: ['declaration', 'output'] })];
		const v = check(symbols, withIdentifierStyle('camelCase'));
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('orderID');
	});

	it('accepts acronym runs when acronym is in the list', () => {
		// orderID matches camelCase if ID is a known acronym.
		const symbols: Sym[] = [sym('column', 'orderID', 0, 7, { modifiers: ['declaration', 'output'] })];
		const v = check(symbols, withIdentifierStyle('camelCase'));
		expect(v).toHaveLength(0);
	});

	// ── PascalCase policy ─────────────────────────────────────────────────

	it('flags a column alias that violates PascalCase', () => {
		// `id` is in the configured acronym list — suggestion preserves it as `ID`.
		const symbols: Sym[] = [sym('column', 'order_id', 0, 7, { modifiers: ['declaration', 'output'] })];
		const v = check(symbols, withIdentifierStyle('PascalCase'));
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('OrderID');
	});

	// ── CTE name violations ──────────────────────────────────────────────

	it('flags a CTE definition name that violates the policy', () => {
		const cteDecl = sym('cte', 'MyCte', 0, 5, { modifiers: ['declaration'] });
		const v = check([cteDecl], withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('MyCte');
		expect(v[0].message).toContain('my_cte');
	});

	// ── User-written table alias violations ──────────────────────────────

	it('flags a table alias that violates the policy', () => {
		const ordersRelation = sym('table', 'orders', 0, 0);
		const alias = sym('alias', 'OrdAlias', 0, 12, { modifiers: ['declaration'] });
		const v = check(
			[ordersRelation, alias],
			withIdentifierStyle('snake_case'),
			{ symbolBindings: symbolBindings({ aliasOf: [[ordersRelation, alias]] }) },
		);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('OrdAlias');
		expect(v[0].message).toContain('ord_alias');
	});

	// ── Column references are NOT flagged ────────────────────────────────

	it('does NOT flag column references — only introductions', () => {
		// A 'reference' column sym is a use of a column defined elsewhere.
		// The user can't pick their style — that belongs to the source.
		const colRefSym = sym('column', 'OrderId', 0, 7);
		const v = check([colRefSym], withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(0);
	});

	// ── Empty input ──────────────────────────────────────────────────────

	it('emits no violations on an empty symbol stream', () => {
		const v = check([], withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(0);
	});
});
