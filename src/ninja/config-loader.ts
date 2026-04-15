import * as vscode from 'vscode';
import type { NinjaConfig, CapitalisationPolicy, CommaPosition, OperatorPosition, NotEqualStyle, UnionStyle } from './config';
import { DEFAULT_CONFIG } from './config';
import type { NinjaSeverity } from './rule';

/**
 * Build a NinjaConfig by reading VS Code settings (`dbt-studio.ninja.*`).
 * Falls back to DEFAULT_CONFIG for any missing values.
 */
export function loadConfig(): NinjaConfig {
	const cfg = vscode.workspace.getConfiguration('dbt-studio.ninja');

	return {
		enabled: cfg.get<boolean>('enabled', DEFAULT_CONFIG.enabled),
		rules: cfg.get<Record<string, NinjaSeverity>>('rules', DEFAULT_CONFIG.rules),
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
