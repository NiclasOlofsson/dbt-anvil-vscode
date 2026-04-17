import * as vscode from 'vscode';
import type { NinjaConfig, CapitalisationPolicy, CommaPosition, OperatorPosition, NotEqualStyle, UnionStyle } from './config';
import { DEFAULT_CONFIG } from './config';
import type { NinjaSeverity, RuleOptionValue } from './rule';
import type { InspectedRuleConfig } from './editor/editor-model';
import type { ConfigScope } from './editor/editor-types';

/**
 * Build a NinjaConfig by reading VS Code settings (`dbt-studio.ninja.*`).
 * Falls back to DEFAULT_CONFIG for any missing values.
 */
export function loadConfig(): NinjaConfig {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');

	return {
		enabled: cfg.get<boolean>('enabled', DEFAULT_CONFIG.enabled),
		rules: cfg.get<Record<string, NinjaSeverity>>('rules', DEFAULT_CONFIG.rules),
		autoFix: {
			applyOnFormat: cfg.get<boolean>('autoFix.applyOnFormat', DEFAULT_CONFIG.autoFix.applyOnFormat),
			applyOnFixAll: cfg.get<boolean>('autoFix.applyOnFixAll', DEFAULT_CONFIG.autoFix.applyOnFixAll),
			rules: cfg.get<Record<string, boolean>>('autoFix.rules', DEFAULT_CONFIG.autoFix.rules),
		},
		capitalisation: {
			keywords: cfg.get<CapitalisationPolicy>('capitalisation.keywords', DEFAULT_CONFIG.capitalisation.keywords),
			functions: cfg.get<CapitalisationPolicy>('capitalisation.functions', DEFAULT_CONFIG.capitalisation.functions),
			literals: cfg.get<CapitalisationPolicy>('capitalisation.literals', DEFAULT_CONFIG.capitalisation.literals),
			types: cfg.get<CapitalisationPolicy>('capitalisation.types', DEFAULT_CONFIG.capitalisation.types),
		},
		indentation: {
			unit: cfg.get<'space' | 'tab'>('indentation.unit', DEFAULT_CONFIG.indentation.unit),
			size: cfg.get<number>('indentation.size', DEFAULT_CONFIG.indentation.size),
		},
		maxLineLength: cfg.get<number>('maxLineLength', DEFAULT_CONFIG.maxLineLength),
		maxBlankLines: cfg.get<number>('maxBlankLines', DEFAULT_CONFIG.maxBlankLines),
		layout: {
			commaPosition: cfg.get<CommaPosition>('layout.commaPosition', DEFAULT_CONFIG.layout.commaPosition),
			operatorPosition: cfg.get<OperatorPosition>('layout.operatorPosition', DEFAULT_CONFIG.layout.operatorPosition),
		},
		structure: {
			allowStarInCte: cfg.get<boolean>('structure.allowStarInCte', DEFAULT_CONFIG.structure.allowStarInCte),
		},
		convention: {
			notEqual: cfg.get<NotEqualStyle>('convention.notEqual', DEFAULT_CONFIG.convention.notEqual),
			unionStyle: cfg.get<UnionStyle>('convention.unionStyle', DEFAULT_CONFIG.convention.unionStyle),
		},
	};
}

/** Parse `-- noqa` and `-- noqa: rule1, rule2` comments to get suppressed rules per line. */
export function parseInlineSuppressions(text: string): Map<number, Set<string> | 'all'> {
	const suppressions = new Map<number, Set<string> | 'all'>();
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const idx = line.indexOf('-- noqa');
		if (idx === -1) continue;
		const rest = line.slice(idx + 7).trim();
		if (rest === '' || rest.startsWith('--')) {
			suppressions.set(i, 'all');
		} else if (rest.startsWith(':')) {
			const codes = rest.slice(1).split(',').map(s => s.trim()).filter(Boolean);
			suppressions.set(i, new Set(codes));
		}
	}
	return suppressions;
}

/**
 * Inspect `dbt-studio.ninja.rules` at each scope and return per-rule
 * user / workspace severity values.
 */
export function inspectRuleSeverities(): InspectedRuleConfig[] {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const inspection = cfg.inspect<Record<string, NinjaSeverity>>('rules');
	const global = inspection?.globalValue ?? {};
	const workspace = inspection?.workspaceValue ?? {};

	const allIds = new Set([...Object.keys(global), ...Object.keys(workspace)]);
	const result: InspectedRuleConfig[] = [];
	for (const ruleId of allIds) {
		result.push({
			ruleId,
			userSeverity: global[ruleId],
			workspaceSeverity: workspace[ruleId],
		});
	}
	return result;
}

/** Persist a single rule severity override at the given scope. */
export async function saveRuleSeverity(ruleId: string, severity: NinjaSeverity, scope: ConfigScope): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const target = scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
	const inspection = cfg.inspect<Record<string, NinjaSeverity>>('rules');
	const current = (scope === 'user' ? inspection?.globalValue : inspection?.workspaceValue) ?? {};
	await cfg.update('rules', { ...current, [ruleId]: severity }, target);
}

/** Remove a single rule override at the given scope (for Reset). */
export async function removeRuleSeverity(ruleId: string, scope: ConfigScope): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const target = scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
	const inspection = cfg.inspect<Record<string, NinjaSeverity>>('rules');
	const current = { ...((scope === 'user' ? inspection?.globalValue : inspection?.workspaceValue) ?? {}) };
	delete current[ruleId];
	const value = Object.keys(current).length > 0 ? current : undefined;
	await cfg.update('rules', value, target);
}

/**
 * Return the effective per-rule auto-fix overrides (workspace value wins over user/global).
 * Absence means "use the rule's built-in default" (true for autoFixable rules).
 */
export function inspectAutoFixRules(): Record<string, boolean> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const inspection = cfg.inspect<Record<string, boolean>>('autoFix.rules');
	return { ...(inspection?.globalValue ?? {}), ...(inspection?.workspaceValue ?? {}) };
}

/** Persist a per-rule auto-fix override at the given scope. */
export async function saveAutoFixRule(ruleId: string, enabled: boolean, scope: ConfigScope): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const target = scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
	const inspection = cfg.inspect<Record<string, boolean>>('autoFix.rules');
	const current = (scope === 'user' ? inspection?.globalValue : inspection?.workspaceValue) ?? {};
	await cfg.update('autoFix.rules', { ...current, [ruleId]: enabled }, target);
}

/** Remove a per-rule auto-fix override, reverting to the default (enabled). */
export async function removeAutoFixRule(ruleId: string, scope: ConfigScope): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const target = scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
	const inspection = cfg.inspect<Record<string, boolean>>('autoFix.rules');
	const current = { ...(scope === 'user' ? inspection?.globalValue : inspection?.workspaceValue) ?? {} };
	delete current[ruleId];
	await cfg.update('autoFix.rules', current, target);
}

/**
 * Persist a single global config option (e.g. layout.operatorPosition) at the given scope.
 * `settingPath` is the sub-path under `dbt-studio.ninja`, e.g. `layout.operatorPosition`.
 */
export async function saveConfigOption(settingPath: string, value: RuleOptionValue, scope: ConfigScope): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const target = scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
	await cfg.update(settingPath, value, target);
}

/** Remove a config option override at the given scope, restoring it to the default. */
export async function removeConfigOption(settingPath: string, scope: ConfigScope): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const target = scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
	await cfg.update(settingPath, undefined, target);
}

/**
 * Read current values for an arbitrary list of sub-paths under `dbt-studio.ninja`.
 * Returns a flat Record<settingPath, currentValue>.
 */
export function inspectConfigOptions(paths: string[]): Record<string, RuleOptionValue> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const result: Record<string, RuleOptionValue> = {};
	for (const p of paths) {
		const val = cfg.get<RuleOptionValue>(p);
		if (val !== undefined) result[p] = val;
	}
	return result;
}

/** Returns the subset of paths that have an explicit override at the given scope. */
export function getOverriddenOptionPaths(paths: string[], scope: ConfigScope): Set<string> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const result = new Set<string>();
	for (const p of paths) {
		const info = cfg.inspect<RuleOptionValue>(p);
		if (!info) continue;
		const overridden = scope === 'user' ? info.globalValue !== undefined : info.workspaceValue !== undefined;
		if (overridden) result.add(p);
	}
	return result;
}
