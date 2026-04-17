import type { NinjaCategory } from '../categories';
import type { NinjaActionKind, NinjaSeverity, RuleConfigOptionSpec, RuleOptionValue } from '../rule';

export type { RuleOptionValue };

// ── Scope ───────────────────────────────────────────────────────────

export type ConfigScope = 'user' | 'workspace';

// ── Rule view model ─────────────────────────────────────────────────

export interface RuleViewModel {
	id: string;
	category: NinjaCategory;
	description: string;
	defaultSeverity: NinjaSeverity;
	type: 'token' | 'layout';
	actionKinds?: NinjaActionKind[];
	autoFixable?: boolean;
	fixable?: boolean;
	configOptions?: RuleConfigOptionSpec[];
}

// ── Per-rule scope info ─────────────────────────────────────────────

export interface RuleScopeInfo {
	defaultSeverity: NinjaSeverity;
	userSeverity?: NinjaSeverity;
	workspaceSeverity?: NinjaSeverity;
	effectiveSeverity: NinjaSeverity;
}

// ── Per-rule state in the snapshot ──────────────────────────────────

export interface RuleState {
	rule: RuleViewModel;
	scopeInfo: RuleScopeInfo;
	violationCount: number;
	isModified: boolean;
	/** Effective auto-fix enabled state. Only meaningful when rule.autoFixable is true. */
	autoFixEnabled: boolean;
	/** Current values for this rule's configOptions, keyed by settingPath. */
	configOptionValues: Record<string, RuleOptionValue>;
}

// ── Full snapshot sent to webview ───────────────────────────────────

export interface EditorSnapshot {
	activeScope: ConfigScope;
	rules: RuleState[];
	allCategoryCounts: Map<NinjaCategory, number>;
	activeCategory: NinjaCategory | 'all';
	searchQuery: string;
	isDirty: boolean;
	isScanning: boolean;
	summary: EditorSummary;
	sortColumn: SortColumn | null;
	sortDir: 'asc' | 'desc';
}

export interface EditorSummary {
	totalRules: number;
	activeRules: number;
	violations: number;
}

// ── Sort ────────────────────────────────────────────────────────────

export type SortColumn = 'id' | 'description' | 'counts' | 'severity';

// ── Severity options ────────────────────────────────────────────────

export const SEVERITY_OPTIONS: NinjaSeverity[] = ['error', 'warning', 'info', 'hint', 'off'];

// ── Messages: webview -> extension ──────────────────────────────────

export type InboundMessage =
	| { type: 'switchScope'; scope: ConfigScope }
	| { type: 'setSeverity'; ruleId: string; severity: NinjaSeverity }
	| { type: 'resetRule'; ruleId: string }
	| { type: 'resetAll' }
	| { type: 'save' }
	| { type: 'scan' }
	| { type: 'setCategory'; category: NinjaCategory | 'all' }
	| { type: 'setSearch'; query: string }
	| { type: 'setAutoFix'; ruleId: string; enabled: boolean }
	| { type: 'setSort'; column: SortColumn | null; dir: 'asc' | 'desc' }
	| { type: 'setRuleOption'; settingPath: string; value: RuleOptionValue };

// ── Messages: extension -> webview ──────────────────────────────────

export type OutboundMessage =
	| { type: 'setSnapshot'; snapshot: EditorSnapshot }
	| { type: 'scanProgress'; percent: number };
