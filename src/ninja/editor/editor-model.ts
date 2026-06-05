import type { NinjaCategory } from '../categories';
import type { NinjaSeverity, RuleOptionValue } from '../rule';
import type { FormatPreset } from '../presets';
import {
	SEVERITY_OPTIONS,
	type ConfigScope,
	type EditorSnapshot,
	type EditorSummary,
	type RuleState,
	type RuleScopeInfo,
	type RuleViewModel,
	type SortColumn,
} from './editor-types';

const AVAILABLE_PRESETS: FormatPreset[] = ['sqlfmt', 'dbt-labs', 'dbt-anvil', 'custom'];

// ── Inspected config input ──────────────────────────────────────────

export interface InspectedRuleConfig {
	ruleId: string;
	userSeverity?: NinjaSeverity;
	workspaceSeverity?: NinjaSeverity;
}

// ── Presentation model ──────────────────────────────────────────────

export class EditorModel {
	private readonly _rules: RuleViewModel[];
	private _activeScope: ConfigScope = 'workspace';
	private _activeCategory: NinjaCategory | 'all' = 'all';
	private _searchQuery = '';
	private _isDirty = false;
	private _isScanning = false;
	private _sortColumn: SortColumn | null = null;
	private _sortDir: 'asc' | 'desc' = 'asc';

	// Per-scope draft overrides: ruleId -> severity
	private _userOverrides = new Map<string, NinjaSeverity>();
	private _workspaceOverrides = new Map<string, NinjaSeverity>();

	// Per-rule auto-fix overrides (merged from all scopes, workspace wins)
	private _autoFixRules = new Map<string, boolean>();

	// Violation counts
	private _violationCounts = new Map<string, number>();

	// Global config option values keyed by settingPath
	private _optionValues = new Map<string, RuleOptionValue>();

	// Paths that have an explicit override at the active scope
	private _overriddenOptionPaths = new Set<string>();

	// Rule IDs that are completely disabled (merged from all scopes)
	private _disabledRules = new Set<string>();

	// Draft value of `format.preset`. Mutations bump _isDirty; on save the
	// panel writes this to settings.json. The initial value is the
	// pre-load placeholder; the panel immediately calls applyPreset with
	// the actual setting value during construction.
	private _preset: FormatPreset = 'dbt-anvil';

	constructor(rules: RuleViewModel[]) {
		this._rules = rules;
	}

	// ── Scope ─────────────────────────────────────────────────────

	get activeScope(): ConfigScope { return this._activeScope; }

	switchScope(scope: ConfigScope): void {
		this._activeScope = scope;
	}

	// ── Config data ingestion ─────────────────────────────────────

	applyDisabledRules(ids: string[]): void {
		this._disabledRules = new Set(ids);
	}

	applyPreset(preset: FormatPreset): void {
		this._preset = preset;
	}

	setPreset(preset: FormatPreset): void {
		if (this._preset === preset) return;
		this._preset = preset;
		this._isDirty = true;
	}

	get preset(): FormatPreset { return this._preset; }

	isDisabled(ruleId: string): boolean {
		return this._disabledRules.has(ruleId);
	}

	setDisabled(ruleId: string, disabled: boolean): void {
		if (disabled) this._disabledRules.add(ruleId);
		else this._disabledRules.delete(ruleId);
	}

	applyAutoFixConfig(rules: Record<string, boolean>): void {
		this._autoFixRules = new Map(Object.entries(rules));
	}

	applyOptionValues(values: Record<string, RuleOptionValue>): void {
		for (const [k, v] of Object.entries(values)) {
			this._optionValues.set(k, v);
		}
	}

	applyOptionOverrides(paths: Set<string>): void {
		this._overriddenOptionPaths = new Set(paths);
	}

	setAutoFix(ruleId: string, enabled: boolean): void {
		this._autoFixRules.set(ruleId, enabled);
	}

	applyInspectedConfig(configs: InspectedRuleConfig[]): void {
		this._userOverrides.clear();
		this._workspaceOverrides.clear();
		for (const c of configs) {
			if (c.userSeverity !== undefined) this._userOverrides.set(c.ruleId, c.userSeverity);
			if (c.workspaceSeverity !== undefined) this._workspaceOverrides.set(c.ruleId, c.workspaceSeverity);
		}
		this._isDirty = false;
	}

	// ── Counts ────────────────────────────────────────────────────

	applyViolationCounts(counts: Map<string, number>): void {
		this._violationCounts = counts;
	}

	// ── Severity mutations ────────────────────────────────────────

	setSeverity(ruleId: string, severity: NinjaSeverity): void {
		this._overridesForActiveScope().set(ruleId, severity);
		this._isDirty = true;
	}

	resetRule(ruleId: string): void {
		this._overridesForActiveScope().delete(ruleId);
		this._autoFixRules.delete(ruleId);
		this._isDirty = true;
	}

	resetAll(): void {
		this._overridesForActiveScope().clear();
		this._isDirty = true;
	}

	/**
	 * Clear every customization at the active scope: severity overrides,
	 * autoFix overrides, per-rule option values, disabled rules, and
	 * `format.preset`. The model goes back to the equivalent of an empty
	 * settings.json — the panel marks every affected field dirty so save
	 * emits the corresponding removes. Discard backs out as usual.
	 */
	resetToDefaults(defaultPreset: FormatPreset): void {
		this._overridesForActiveScope().clear();
		this._autoFixRules.clear();
		this._optionValues.clear();
		this._overriddenOptionPaths = new Set();
		this._disabledRules.clear();
		this._preset = defaultPreset;
		this._isDirty = true;
	}

	// ── Filtering ─────────────────────────────────────────────────

	setCategory(category: NinjaCategory | 'all'): void {
		this._activeCategory = category;
	}

	setSearch(query: string): void {
		this._searchQuery = query;
	}

	setSort(column: SortColumn | null, dir: 'asc' | 'desc'): void {
		this._sortColumn = column;
		this._sortDir = dir;
	}

	setScanning(scanning: boolean): void {
		this._isScanning = scanning;
	}

	// ── Per-rule queries ──────────────────────────────────────────

	effectiveSeverity(ruleId: string): NinjaSeverity {
		const ws = this._workspaceOverrides.get(ruleId);
		if (ws !== undefined) return ws;
		const user = this._userOverrides.get(ruleId);
		if (user !== undefined) return user;
		const rule = this._rules.find(r => r.id === ruleId);
		return rule?.defaultSeverity ?? 'mute';
	}

	scopeInfo(ruleId: string): RuleScopeInfo {
		const rule = this._rules.find(r => r.id === ruleId);
		return {
			defaultSeverity: rule?.defaultSeverity ?? 'mute',
			userSeverity: this._userOverrides.get(ruleId),
			workspaceSeverity: this._workspaceOverrides.get(ruleId),
			effectiveSeverity: this.effectiveSeverity(ruleId),
		};
	}

	isModified(ruleId: string): boolean {
		const rule = this._rules.find(r => r.id === ruleId);
		const hasOptionOverride = rule?.configOptions?.some(o => this._overriddenOptionPaths.has(o.settingPath)) ?? false;
		return this._overridesForActiveScope().has(ruleId)
			|| (this._autoFixRules.get(ruleId) ?? true) !== true
			|| hasOptionOverride;
	}

	// ── Dirty overrides for persistence ───────────────────────────

	get isDirty(): boolean { return this._isDirty; }

	/**
	 * Returns the current overrides for the given scope.
	 * The panel uses this to persist via config-loader.
	 */
	getOverrides(scope: ConfigScope): Map<string, NinjaSeverity> {
		return scope === 'user'
			? new Map(this._userOverrides)
			: new Map(this._workspaceOverrides);
	}

	markClean(): void {
		this._isDirty = false;
	}

	// ── Snapshot ──────────────────────────────────────────────────

	snapshot(): EditorSnapshot {
		const sorted = this._sortedRules(this._filteredRules());
		const rules: RuleState[] = sorted.map(rule => {
			const configOptionValues: Record<string, RuleOptionValue> = {};
			for (const opt of rule.configOptions ?? []) {
				const val = this._optionValues.get(opt.settingPath);
				if (val !== undefined) configOptionValues[opt.settingPath] = val;
			}
			return {
				rule,
				scopeInfo: this.scopeInfo(rule.id),
				violationCount: this._violationCounts.get(rule.id) ?? 0,
				isModified: this.isModified(rule.id),
				isDisabled: this._disabledRules.has(rule.id),
				autoFixEnabled: this._autoFixRules.get(rule.id) ?? true,
				configOptionValues,
			};
		});

		const allCategoryCounts = new Map<NinjaCategory, number>();
		for (const rule of this._rules) {
			allCategoryCounts.set(rule.category, (allCategoryCounts.get(rule.category) ?? 0) + 1);
		}

		return {
			activeScope: this._activeScope,
			rules,
			allCategoryCounts,
			activeCategory: this._activeCategory,
			searchQuery: this._searchQuery,
			isDirty: this._isDirty,
			isScanning: this._isScanning,
			summary: this._summary(),
			sortColumn: this._sortColumn,
			sortDir: this._sortDir,
			preset: this._preset,
			availablePresets: AVAILABLE_PRESETS,
		};
	}

	// ── Internals ─────────────────────────────────────────────────

	private _overridesForActiveScope(): Map<string, NinjaSeverity> {
		return this._activeScope === 'user' ? this._userOverrides : this._workspaceOverrides;
	}

	private _filteredRules(): RuleViewModel[] {
		let rules = this._rules;
		if (this._activeCategory !== 'all') {
			rules = rules.filter(r => r.category === this._activeCategory);
		}
		if (this._searchQuery) {
			const q = this._searchQuery.toLowerCase();
			rules = rules.filter(r =>
				r.id.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
			);
		}
		return rules;
	}

	private _sortedRules(rules: RuleViewModel[]): RuleViewModel[] {
		if (!this._sortColumn) return rules;
		const dir = this._sortDir === 'asc' ? 1 : -1;
		const col = this._sortColumn;
		return [...rules].sort((a, b) => {
			if (col === 'id') return dir * a.id.localeCompare(b.id);
			if (col === 'description') return dir * a.description.localeCompare(b.description);
			if (col === 'counts') {
				const aC = this._violationCounts.get(a.id) ?? 0;
				const bC = this._violationCounts.get(b.id) ?? 0;
				return dir * (aC - bC);
			}
			return dir * (SEVERITY_OPTIONS.indexOf(this.effectiveSeverity(a.id)) - SEVERITY_OPTIONS.indexOf(this.effectiveSeverity(b.id)));
		});
	}

	private _summary(): EditorSummary {
		let activeRules = 0;
		let violations = 0;
		for (const rule of this._rules) {
			if (!this._disabledRules.has(rule.id)) activeRules++;
			violations += this._violationCounts.get(rule.id) ?? 0;
		}
		return {
			totalRules: this._rules.length,
			activeRules,
			violations,
		};
	}
}
