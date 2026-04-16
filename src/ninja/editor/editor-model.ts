import type { NinjaCategory } from '../categories';
import type { NinjaSeverity } from '../rule';
import type {
	ConfigScope,
	EditorSnapshot,
	EditorSummary,
	RuleState,
	RuleScopeInfo,
	RuleViewModel,
} from './editor-types';

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

	// Per-scope draft overrides: ruleId -> severity
	private _userOverrides = new Map<string, NinjaSeverity>();
	private _workspaceOverrides = new Map<string, NinjaSeverity>();

	// Violation counts
	private _baselineCounts = new Map<string, number>();
	private _configuredCounts = new Map<string, number>();

	constructor(rules: RuleViewModel[]) {
		this._rules = rules;
	}

	// ── Scope ─────────────────────────────────────────────────────

	get activeScope(): ConfigScope { return this._activeScope; }

	switchScope(scope: ConfigScope): void {
		this._activeScope = scope;
	}

	// ── Config data ingestion ─────────────────────────────────────

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

	applyBaselineCounts(counts: Map<string, number>): void {
		this._baselineCounts = counts;
	}

	applyConfiguredCounts(counts: Map<string, number>): void {
		this._configuredCounts = counts;
	}

	// ── Severity mutations ────────────────────────────────────────

	setSeverity(ruleId: string, severity: NinjaSeverity): void {
		this._overridesForActiveScope().set(ruleId, severity);
		this._isDirty = true;
	}

	resetRule(ruleId: string): void {
		this._overridesForActiveScope().delete(ruleId);
		this._isDirty = true;
	}

	resetAll(): void {
		this._overridesForActiveScope().clear();
		this._isDirty = true;
	}

	// ── Filtering ─────────────────────────────────────────────────

	setCategory(category: NinjaCategory | 'all'): void {
		this._activeCategory = category;
	}

	setSearch(query: string): void {
		this._searchQuery = query;
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
		return rule?.defaultSeverity ?? 'off';
	}

	scopeInfo(ruleId: string): RuleScopeInfo {
		const rule = this._rules.find(r => r.id === ruleId);
		return {
			defaultSeverity: rule?.defaultSeverity ?? 'off',
			userSeverity: this._userOverrides.get(ruleId),
			workspaceSeverity: this._workspaceOverrides.get(ruleId),
			effectiveSeverity: this.effectiveSeverity(ruleId),
		};
	}

	isModified(ruleId: string): boolean {
		return this._overridesForActiveScope().has(ruleId);
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
		const filtered = this._filteredRules();
		const rules: RuleState[] = filtered.map(rule => ({
			rule,
			scopeInfo: this.scopeInfo(rule.id),
			baselineCount: this._baselineCounts.get(rule.id) ?? 0,
			configuredCount: this._configuredCounts.get(rule.id) ?? 0,
			isModified: this.isModified(rule.id),
		}));

		return {
			activeScope: this._activeScope,
			rules,
			activeCategory: this._activeCategory,
			searchQuery: this._searchQuery,
			isDirty: this._isDirty,
			isScanning: this._isScanning,
			summary: this._summary(),
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

	private _summary(): EditorSummary {
		let activeRules = 0;
		let configuredViolations = 0;
		let baselineViolations = 0;
		for (const rule of this._rules) {
			if (this.effectiveSeverity(rule.id) !== 'off') activeRules++;
			configuredViolations += this._configuredCounts.get(rule.id) ?? 0;
			baselineViolations += this._baselineCounts.get(rule.id) ?? 0;
		}
		return {
			totalRules: this._rules.length,
			activeRules,
			configuredViolations,
			baselineViolations,
		};
	}
}
