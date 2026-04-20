import { describe, it, expect, beforeEach } from 'vitest';
import { EditorModel } from '../../ninja/editor/editor-model';
import type { RuleViewModel } from '../../ninja/editor/editor-types';
import { NinjaCategory } from '../../ninja/categories';

function makeRule(id: string, overrides: Partial<RuleViewModel> = {}): RuleViewModel {
	return {
		id,
		category: NinjaCategory.Capitalisation,
		description: `Test rule ${id}`,
		defaultSeverity: 'warning',
		type: 'token',
		...overrides,
	};
}

const RULES: RuleViewModel[] = [
	makeRule('cap-keywords'),
	makeRule('cap-functions'),
	makeRule('alias-column-as', { category: NinjaCategory.Aliasing, defaultSeverity: 'info' }),
	makeRule('structure-unused-cte', { category: NinjaCategory.Structure }),
];

describe('EditorModel', () => {
	let model: EditorModel;

	beforeEach(() => {
		model = new EditorModel(RULES);
	});

	// ── Scope ─────────────────────────────────────────────────

	it('defaults to workspace scope', () => {
		expect(model.activeScope).toBe('workspace');
	});

	it('switches scope', () => {
		model.switchScope('user');
		expect(model.activeScope).toBe('user');
	});

	// ── Effective severity ────────────────────────────────────

	it('returns default severity when no overrides', () => {
		expect(model.effectiveSeverity('cap-keywords')).toBe('warning');
		expect(model.effectiveSeverity('alias-column-as')).toBe('info');
	});

	it('workspace override wins over user override', () => {
		model.applyInspectedConfig([
			{ ruleId: 'cap-keywords', userSeverity: 'error', workspaceSeverity: 'mute' },
		]);
		expect(model.effectiveSeverity('cap-keywords')).toBe('mute');
	});

	it('user override wins over default', () => {
		model.applyInspectedConfig([
			{ ruleId: 'cap-keywords', userSeverity: 'error' },
		]);
		expect(model.effectiveSeverity('cap-keywords')).toBe('error');
	});

	it('returns mute for unknown rule', () => {
		expect(model.effectiveSeverity('nonexistent')).toBe('mute');
	});

	// ── setSeverity / resetRule ───────────────────────────────

	it('setSeverity marks model dirty and updates effective severity', () => {
		expect(model.isDirty).toBe(false);
		model.setSeverity('cap-keywords', 'error');
		expect(model.isDirty).toBe(true);
		expect(model.effectiveSeverity('cap-keywords')).toBe('error');
	});

	it('setSeverity on user scope only affects user overrides', () => {
		model.switchScope('user');
		model.setSeverity('cap-keywords', 'hint');
		// No workspace override → user value wins
		expect(model.effectiveSeverity('cap-keywords')).toBe('hint');
		// Workspace override would still win
		model.switchScope('workspace');
		model.setSeverity('cap-keywords', 'mute');
		expect(model.effectiveSeverity('cap-keywords')).toBe('mute');
	});

	it('resetRule removes override and marks dirty', () => {
		model.setSeverity('cap-keywords', 'error');
		model.resetRule('cap-keywords');
		expect(model.effectiveSeverity('cap-keywords')).toBe('warning'); // default
		expect(model.isDirty).toBe(true);
	});

	it('resetAll clears all overrides for active scope', () => {
		model.setSeverity('cap-keywords', 'error');
		model.setSeverity('cap-functions', 'mute');
		model.resetAll();
		expect(model.effectiveSeverity('cap-keywords')).toBe('warning');
		expect(model.effectiveSeverity('cap-functions')).toBe('warning');
	});

	// ── isModified ────────────────────────────────────────────

	it('isModified reflects active scope overrides', () => {
		model.setSeverity('cap-keywords', 'error');
		expect(model.isModified('cap-keywords')).toBe(true);
		expect(model.isModified('cap-functions')).toBe(false);
	});

	it('isModified changes with scope', () => {
		model.setSeverity('cap-keywords', 'error'); // workspace
		model.switchScope('user');
		expect(model.isModified('cap-keywords')).toBe(false);
	});

	// ── applyInspectedConfig ─────────────────────────────────

	it('applyInspectedConfig clears dirty flag', () => {
		model.setSeverity('cap-keywords', 'error');
		model.applyInspectedConfig([]);
		expect(model.isDirty).toBe(false);
	});

	// ── scopeInfo ─────────────────────────────────────────────

	it('scopeInfo returns full breakdown', () => {
		model.applyInspectedConfig([
			{ ruleId: 'cap-keywords', userSeverity: 'hint', workspaceSeverity: 'error' },
		]);
		const info = model.scopeInfo('cap-keywords');
		expect(info.defaultSeverity).toBe('warning');
		expect(info.userSeverity).toBe('hint');
		expect(info.workspaceSeverity).toBe('error');
		expect(info.effectiveSeverity).toBe('error');
	});

	// ── getOverrides ──────────────────────────────────────────

	it('getOverrides returns a copy of overrides', () => {
		model.setSeverity('cap-keywords', 'error');
		const overrides = model.getOverrides('workspace');
		expect(overrides.get('cap-keywords')).toBe('error');
		// Mutating the copy doesn't affect model
		overrides.set('cap-functions', 'mute');
		expect(model.effectiveSeverity('cap-functions')).toBe('warning');
	});

	// ── Filtering ─────────────────────────────────────────────

	it('filters by category', () => {
		model.setCategory(NinjaCategory.Capitalisation);
		const snap = model.snapshot();
		expect(snap.rules.length).toBe(2);
		expect(snap.rules.every(r => r.rule.category === NinjaCategory.Capitalisation)).toBe(true);
	});

	it('filters by search query (id match)', () => {
		model.setSearch('alias');
		const snap = model.snapshot();
		expect(snap.rules.length).toBe(1);
		expect(snap.rules[0].rule.id).toBe('alias-column-as');
	});

	it('filters by search query (description match)', () => {
		model.setSearch('unused');
		const snap = model.snapshot();
		expect(snap.rules.length).toBe(1);
		expect(snap.rules[0].rule.id).toBe('structure-unused-cte');
	});

	it('combined category + search filter', () => {
		model.setCategory(NinjaCategory.Capitalisation);
		model.setSearch('keywords');
		const snap = model.snapshot();
		expect(snap.rules.length).toBe(1);
		expect(snap.rules[0].rule.id).toBe('cap-keywords');
	});

	// ── Counts ────────────────────────────────────────────────

	it('includes violation counts in snapshot', () => {
		model.applyViolationCounts(new Map([['cap-keywords', 5], ['alias-column-as', 3]]));
		const snap = model.snapshot();
		const kw = snap.rules.find(r => r.rule.id === 'cap-keywords')!;
		expect(kw.violationCount).toBe(5);
	});

	// ── Summary ───────────────────────────────────────────────

	it('summary counts active rules (not disabled)', () => {
		model.applyDisabledRules(['cap-keywords']);
		const snap = model.snapshot();
		expect(snap.summary.totalRules).toBe(4);
		expect(snap.summary.activeRules).toBe(3);
	});

	it('summary aggregates violation counts', () => {
		model.applyViolationCounts(new Map([['cap-keywords', 10], ['cap-functions', 5]]));
		const snap = model.snapshot();
		expect(snap.summary.violations).toBe(15);
	});

	// ── markClean ─────────────────────────────────────────────

	it('markClean resets dirty flag', () => {
		model.setSeverity('cap-keywords', 'error');
		model.markClean();
		expect(model.isDirty).toBe(false);
	});

	// ── Scanning state ────────────────────────────────────────

	it('isScanning reflected in snapshot', () => {
		model.setScanning(true);
		expect(model.snapshot().isScanning).toBe(true);
		model.setScanning(false);
		expect(model.snapshot().isScanning).toBe(false);
	});
});
