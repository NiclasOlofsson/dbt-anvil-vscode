import type { NinjaCategory } from '../categories';
import type { NinjaFixCapability, NinjaSeverity } from '../rule';

// ── Scope ───────────────────────────────────────────────────────────

export type ConfigScope = 'user' | 'workspace';

// ── Rule view model ─────────────────────────────────────────────────

export interface RuleViewModel {
	id: string;
	category: NinjaCategory;
	description: string;
	defaultSeverity: NinjaSeverity;
	fixes: NinjaFixCapability;
	type: 'token' | 'layout';
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
	baselineCount: number;
	configuredCount: number;
	isModified: boolean;
}

// ── Full snapshot sent to webview ───────────────────────────────────

export interface EditorSnapshot {
	activeScope: ConfigScope;
	rules: RuleState[];
	activeCategory: NinjaCategory | 'all';
	searchQuery: string;
	isDirty: boolean;
	isScanning: boolean;
	summary: EditorSummary;
}

export interface EditorSummary {
	totalRules: number;
	activeRules: number;
	configuredViolations: number;
	baselineViolations: number;
}

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
	| { type: 'setSearch'; query: string };

// ── Messages: extension -> webview ──────────────────────────────────

export type OutboundMessage =
	| { type: 'setSnapshot'; snapshot: EditorSnapshot }
	| { type: 'scanProgress'; percent: number };
