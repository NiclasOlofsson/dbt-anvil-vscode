import * as vscode from 'vscode';
import type { NinjaConfig, CommaPosition, OperatorPosition, NotEqualStyle, UnionStyle } from './config';
import { DEFAULT_CONFIG } from './config';
import { PRESETS, type FormatPreset } from './presets';
import type { NinjaSeverity, RuleOptionValue } from './rule';
import type { InspectedRuleConfig } from './editor/editor-model';
import type { ConfigScope } from './editor/editor-types';

/**
 * Build a NinjaConfig by reading VS Code settings (`dbt-studio.ninja.*`).
 * Falls back to DEFAULT_CONFIG for any missing values.
 */
export function loadConfig(): NinjaConfig {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');

	// Backward compat: treat applyOnFormat=true as format.mode='fix-all'
	const legacyApplyOnFormat = cfg.get<boolean>('autoFix.applyOnFormat', DEFAULT_CONFIG.autoFix.applyOnFormat);
	const formatMode = cfg.get<'off' | 'fix-all' | 'full'>('format.mode', legacyApplyOnFormat ? 'fix-all' : DEFAULT_CONFIG.format.mode);
	const formatPreset = cfg.get<FormatPreset>('format.preset', DEFAULT_CONFIG.format.preset);
	const preset = PRESETS[formatPreset] ?? {};

	// For each setting: use the explicitly-set user value if present, otherwise
	// fall back to the preset value, then to DEFAULT_CONFIG.
	function get<T>(key: string, presetVal: T | undefined, defaultVal: T): T {
		const info = cfg.inspect<T>(key);
		if (info?.workspaceValue !== undefined) return info.workspaceValue;
		if (info?.globalValue !== undefined) return info.globalValue;
		return presetVal !== undefined ? presetVal : defaultVal;
	}

	return {
		enabled: cfg.get<boolean>('enabled', DEFAULT_CONFIG.enabled),
		format: { mode: formatMode, preset: formatPreset },
		rules: cfg.get<Record<string, NinjaSeverity>>('rules', DEFAULT_CONFIG.rules),
		disabledRules: cfg.get<string[]>('disabledRules', DEFAULT_CONFIG.disabledRules),
		autoFix: {
			applyOnFormat: cfg.get<boolean>('autoFix.applyOnFormat', DEFAULT_CONFIG.autoFix.applyOnFormat),
			applyOnFixAll: cfg.get<boolean>('autoFix.applyOnFixAll', DEFAULT_CONFIG.autoFix.applyOnFixAll),
			rules: cfg.get<Record<string, boolean>>('autoFix.rules', DEFAULT_CONFIG.autoFix.rules),
		},
		capitalisation: {
			keywords: get('capitalisation.keywords', preset.capitalisation?.keywords, DEFAULT_CONFIG.capitalisation.keywords),
			functions: get('capitalisation.functions', preset.capitalisation?.functions, DEFAULT_CONFIG.capitalisation.functions),
			literals: get('capitalisation.literals', preset.capitalisation?.literals, DEFAULT_CONFIG.capitalisation.literals),
			types: get('capitalisation.types', preset.capitalisation?.types, DEFAULT_CONFIG.capitalisation.types),
		},
		indentation: {
			unit: get<'space' | 'tab'>('indentation.unit', preset.indentation?.unit, DEFAULT_CONFIG.indentation.unit),
			size: get('indentation.size', preset.indentation?.size, DEFAULT_CONFIG.indentation.size),
		},
		maxLineLength: get('maxLineLength', preset.maxLineLength, DEFAULT_CONFIG.maxLineLength),
		maxBlankLines: get('maxBlankLines', preset.maxBlankLines, DEFAULT_CONFIG.maxBlankLines),
		layout: {
			commaPosition: get<CommaPosition>('layout.commaPosition', preset.layout?.commaPosition, DEFAULT_CONFIG.layout.commaPosition),
			operatorPosition: get<OperatorPosition>('layout.operatorPosition', preset.layout?.operatorPosition, DEFAULT_CONFIG.layout.operatorPosition),
		},
		structure: {
			allowStarInCte: cfg.get<boolean>('structure.allowStarInCte', DEFAULT_CONFIG.structure.allowStarInCte),
		},
		convention: {
			notEqual: get<NotEqualStyle>('convention.notEqual', preset.convention?.notEqual, DEFAULT_CONFIG.convention.notEqual),
			unionStyle: get<UnionStyle>('convention.unionStyle', preset.convention?.unionStyle, DEFAULT_CONFIG.convention.unionStyle),
			explicitAs: get<boolean>('convention.explicitAs', preset.convention?.explicitAs, DEFAULT_CONFIG.convention.explicitAs),
			explicitInnerJoin: get<boolean>('convention.explicitInnerJoin', preset.convention?.explicitInnerJoin, DEFAULT_CONFIG.convention.explicitInnerJoin),
		},
	};
}

/** Parse `-- noqa` and `-- noqa: rule1, rule2` comments to get suppressed rules per line. */
export function parseInlineSuppressions(lines: string[]): Map<number, Set<string> | 'all'> {
	const suppressions = new Map<number, Set<string> | 'all'>();
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

/** Return the merged disabled rule IDs across user + workspace scopes. */
export function inspectDisabledRules(): { user: string[]; workspace: string[] } {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const info = cfg.inspect<string[]>('disabledRules');
	return {
		user: info?.globalValue ?? [],
		workspace: info?.workspaceValue ?? [],
	};
}

/** Add a rule ID to the disabled list at the given scope. */
export async function disableRule(ruleId: string, scope: ConfigScope): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const target = scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
	const info = cfg.inspect<string[]>('disabledRules');
	const current = (scope === 'user' ? info?.globalValue : info?.workspaceValue) ?? [];
	if (!current.includes(ruleId)) {
		await cfg.update('disabledRules', [...current, ruleId], target);
	}
}

/** Remove a rule ID from the disabled list at the given scope (re-enables it). */
export async function enableRule(ruleId: string, scope: ConfigScope): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');
	const target = scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
	const info = cfg.inspect<string[]>('disabledRules');
	const current = (scope === 'user' ? info?.globalValue : info?.workspaceValue) ?? [];
	const updated = current.filter(id => id !== ruleId);
	await cfg.update('disabledRules', updated.length > 0 ? updated : undefined, target);
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
