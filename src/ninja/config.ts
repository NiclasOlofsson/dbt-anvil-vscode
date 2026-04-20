import type { NinjaSeverity } from './rule';
import type { FormatPreset } from './presets';

export type CapitalisationPolicy = 'upper' | 'lower' | 'consistent';
export type CommaPosition = 'trailing' | 'leading';
export type OperatorPosition = 'trailing' | 'leading';
export type NotEqualStyle = '!=' | '<>';
export type UnionStyle = 'all' | 'distinct';

export interface NinjaConfig {
	enabled: boolean;
	format: {
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
		/** Indent JOIN clauses one level deeper than FROM (sqlfluff: indented_joins). */
		indentedJoins: boolean;
		/** Indent ON/USING one level deeper than its JOIN (sqlfluff: indented_using_on). */
		indentedOn: boolean;
		/** Indent THEN one level deeper than its WHEN (sqlfluff: indented_then). */
		indentedThen: boolean;
		/** Indent CTE body one extra level (sqlfluff: indented_ctes). */
		indentedCtes: boolean;
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
	format: { preset: 'sqlfmt' },
	rules: {},
	disabledRules: [],
	autoFix: {
		applyOnFormat: true,
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
		indentedJoins: false,
		indentedOn: true,
		indentedThen: true,
		indentedCtes: false,
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
