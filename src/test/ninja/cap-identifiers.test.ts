import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, colDef, tableRef } from './helpers';
import { capIdentifiersRule } from '../../ninja/rules/cap-identifiers';
import { FixAction } from '../../ninja/violation';
import type { DocumentModel, TokenInfo } from '../../services/parse-service';
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

function check(tokens: TokenInfo[], config: NinjaConfig, modelOverrides: Partial<DocumentModel> = {}) {
	const m = model({ ...modelOverrides, tokens });
	const doc = mockDocument('');
	return capIdentifiersRule.check({ model: m, document: doc, config });
}

describe(RULE, () => {
	// ── Style off — no violations regardless of input ─────────────────────

	it('emits no violations when identifier style is off', () => {
		const tokens: TokenInfo[] = [
			colDef('OrderId', 0, 7),
			colDef('customer_id', 0, 20),
		];
		const v = check(tokens, withIdentifierStyle('off'));
		expect(v).toHaveLength(0);
	});

	// ── snake_case policy ─────────────────────────────────────────────────

	it('passes a column alias that matches snake_case', () => {
		const tokens: TokenInfo[] = [colDef('order_id', 0, 7)];
		const v = check(tokens, withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(0);
	});

	it('flags a column alias that violates snake_case', () => {
		const tokens: TokenInfo[] = [colDef('orderId', 0, 7)];
		const v = check(tokens, withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('orderId');
		expect(v[0].message).toContain('order_id');           // suggestion appears in message
	});

	it('attaches a FixAction with autoFix=false for the violation', () => {
		const tokens: TokenInfo[] = [colDef('orderId', 0, 7)];
		const v = check(tokens, withIdentifierStyle('snake_case'));
		expect(v[0].action?.type).toBe(FixAction.TYPE);
		const action = v[0].action as FixAction;
		expect(action.autoFix).toBe(false);
		expect(action.ops.length).toBeGreaterThan(0);
		expect(action.ops[0].kind).toBe('replace');
	});

	it('emits NO violation when a single-word identifier conforms trivially', () => {
		// `order` matches snake_case (single lowercase word). No flag.
		const tokens: TokenInfo[] = [colDef('order', 0, 7)];
		const v = check(tokens, withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(0);
	});

	// ── camelCase policy ──────────────────────────────────────────────────

	it('passes a column alias that matches camelCase', () => {
		const tokens: TokenInfo[] = [colDef('orderId', 0, 7)];
		const v = check(tokens, withIdentifierStyle('camelCase'));
		expect(v).toHaveLength(0);
	});

	it('flags a column alias that violates camelCase', () => {
		// `id` is in the configured acronym list so the suggestion preserves
		// it as `ID` — that's the configured behaviour, not a bug.
		const tokens: TokenInfo[] = [colDef('order_id', 0, 7)];
		const v = check(tokens, withIdentifierStyle('camelCase'));
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('orderID');
	});

	it('accepts acronym runs when acronym is in the list', () => {
		// orderID matches camelCase if ID is a known acronym.
		const tokens: TokenInfo[] = [colDef('orderID', 0, 7)];
		const v = check(tokens, withIdentifierStyle('camelCase'));
		expect(v).toHaveLength(0);
	});

	// ── PascalCase policy ─────────────────────────────────────────────────

	it('flags a column alias that violates PascalCase', () => {
		// `id` is in the configured acronym list — suggestion preserves it as `ID`.
		const tokens: TokenInfo[] = [colDef('order_id', 0, 7)];
		const v = check(tokens, withIdentifierStyle('PascalCase'));
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('OrderID');
	});

	// ── CTE name violations ──────────────────────────────────────────────

	it('flags a CTE definition name that violates the policy', () => {
		const cteDef: TokenInfo = {
			type: 'table_ref',
			name: 'MyCte',
			line: 0, col: 5, endCol: 10,
			cteDefinition: true,
		};
		const v = check([cteDef], withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('MyCte');
		expect(v[0].message).toContain('my_cte');
	});

	// ── User-written table alias violations ──────────────────────────────

	it('flags a table alias that violates the policy', () => {
		const ref = tableRef('orders', 0, 5, 'OrdAlias');
		const v = check([ref], withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('OrdAlias');
		expect(v[0].message).toContain('ord_alias');
	});

	it('does NOT flag a synthesized alias (no source position)', () => {
		// Synthesized aliases come from qualify() — not user-written, so
		// not a style violation the user can act on.
		const ref: TokenInfo = {
			type: 'table_ref',
			name: 'orders',
			line: 0, col: 5, endCol: 11,
			alias: 'O',
			synthesized: true,
		};
		const v = check([ref], withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(0);
	});

	// ── Column references are NOT flagged ────────────────────────────────

	it('does NOT flag column references — only introductions', () => {
		// column_ref tokens are references to columns defined elsewhere.
		// The user can't pick their style — that belongs to the source.
		const colRefTok: TokenInfo = {
			type: 'column_ref',
			name: 'OrderId',
			line: 0, col: 7, endCol: 14,
		};
		const v = check([colRefTok], withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(0);
	});

	// ── Empty input ──────────────────────────────────────────────────────

	it('emits no violations on an empty token stream', () => {
		const v = check([], withIdentifierStyle('snake_case'));
		expect(v).toHaveLength(0);
	});
});
