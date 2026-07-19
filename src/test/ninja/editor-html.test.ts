import { describe, it, expect } from 'vitest';
import { renderEditor } from '../../ninja/editor/editor-html';
import type { EditorSnapshot, RuleState } from '../../ninja/editor/editor-types';
import { NinjaCategory } from '../../ninja/categories';

function ruleState(overrides: Partial<RuleState['rule']> = {}, values: Record<string, string | number | boolean> = {}): RuleState {
	return {
		rule: {
			id: 'layout-indented-on',
			category: NinjaCategory.Layout,
			description: 'Test rule',
			defaultSeverity: 'warning',
			type: 'layout',
			fixScope: 'none',
			...overrides,
		},
		scopeInfo: { defaultSeverity: 'warning', effectiveSeverity: 'warning' },
		violationCount: 0,
		isModified: false,
		isDisabled: false,
		autoFixEnabled: false,
		configOptionValues: values,
	};
}

function snapshot(rules: RuleState[]): EditorSnapshot {
	return {
		activeScope: 'workspace',
		rules,
		allCategoryCounts: new Map(),
		activeCategory: 'all',
		searchQuery: '',
		isDirty: false,
		isScanning: false,
		summary: { totalRules: rules.length, activeRules: rules.length, violations: 0 },
		sortColumn: null,
		sortDir: 'asc',
		preset: 'dbt-anvil',
		availablePresets: ['dbt-anvil'],
	};
}

describe('renderEditor option controls', () => {
	// dbt-anvil.ninja.* boolean settings must round-trip as booleans. The
	// webview DOM only produces strings, so the bool <select> is marked and
	// the client script coerces it before posting setRuleOption; without
	// that, the string "false" lands in a boolean setting and reads truthy.
	it('marks bool option selects so the client posts real booleans', () => {
		const html = renderEditor(snapshot([
			ruleState({
				configOptions: [{ settingPath: 'layout.indentedOn', label: 'Indent ON', type: 'bool' }],
			}, { 'layout.indentedOn': true }),
		]), 'test-nonce');

		expect(html).toMatch(/<select[^>]*data-path="layout\.indentedOn"[^>]*data-bool="true"/);
		// The opt-select change handler must branch on the marker and coerce.
		expect(html).toContain('dataset.bool');
		expect(html).toMatch(/dataset\.bool[^;]*sel\.value === 'true'/);
	});

	it('leaves enum option selects unmarked (their settings are strings)', () => {
		const html = renderEditor(snapshot([
			ruleState({
				configOptions: [{ settingPath: 'layout.commaPosition', label: 'Commas', type: 'enum', choices: ['leading', 'trailing'] }],
			}, { 'layout.commaPosition': 'trailing' }),
		]), 'test-nonce');

		const enumSelect = html.match(/<select[^>]*data-path="layout\.commaPosition"[^>]*>/);
		expect(enumSelect).not.toBeNull();
		expect(enumSelect![0]).not.toContain('data-bool');
	});
});
