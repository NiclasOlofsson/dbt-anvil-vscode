import type { NinjaSeverity } from './rule';
import type { FormatPreset } from './presets';

export type CapitalisationPolicy = 'upper' | 'lower' | 'consistent';
export type CommaPosition = 'trailing' | 'leading';
export type OperatorPosition = 'trailing' | 'leading';
export type NotEqualStyle = '!=' | '<>';
export type UnionStyle = 'all' | 'distinct';
export type FormatMode = 'off' | 'fix-all' | 'full';

export interface NinjaConfig {
	enabled: boolean;
	format: {
		/** Controls what happens when the user invokes Format Document. */
		mode: FormatMode;
		/** Named style preset. When set, provides defaults for unset config keys. */
		preset: FormatPreset;
	};
	/** Per-rule severity overrides. Key = rule ID, value = severity level. */
	rules: Record<string, NinjaSeverity>;
	/** Rule IDs that are completely disabled — no diagnostic, no autofix. */
	disabledRules: string[];
	autoFix: {
		applyOnFormat: boolean;
		applyOnFixAll: boolean;
		/** Per-rule auto-fix overrides. Key = rule ID, value = true/false. Absent = use rule's built-in autoFix flag. */
		rules: Record<string, boolean>;
	};
	capitalisation: {
		keywords: CapitalisationPolicy;
		functions: CapitalisationPolicy;
		literals: CapitalisationPolicy;
		types: CapitalisationPolicy;
	};
	indentation: {
		unit: 'space' | 'tab';
		size: number;
	};
	maxLineLength: number;
	maxBlankLines: number;
	layout: {
		commaPosition: CommaPosition;
		operatorPosition: OperatorPosition;
	};
	structure: {
		allowStarInCte: boolean;
	};
	convention: {
		notEqual: NotEqualStyle;
		unionStyle: UnionStyle;
		/** Require AS keyword for all table aliases, e.g. `FROM orders AS o`. */
		explicitAs: boolean;
		/** Require INNER keyword for inner joins, e.g. `INNER JOIN` not bare `JOIN`. */
		explicitInnerJoin: boolean;
	};
}

export const DEFAULT_CONFIG: NinjaConfig = {
	enabled: true,
	format: { mode: 'off', preset: 'sqlfmt' },
	rules: {},
	disabledRules: [],
	autoFix: {
		applyOnFormat: false,
		applyOnFixAll: false,
		rules: {},
	},
	capitalisation: {
		keywords: 'lower',
		functions: 'lower',
		literals: 'lower',
		types: 'lower',
	},
	indentation: {
		unit: 'space',
		size: 4,
	},
	maxLineLength: 120,
	maxBlankLines: 2,
	layout: {
		commaPosition: 'trailing',
		operatorPosition: 'leading',
	},
	structure: {
		allowStarInCte: false,
	},
	convention: {
		notEqual: '!=',
		unionStyle: 'all',
		explicitAs: true,
		explicitInnerJoin: true,
	},
};
