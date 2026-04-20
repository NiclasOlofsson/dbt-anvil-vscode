import type { NinjaSeverity } from './rule';

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
	};
	/** Per-rule severity overrides. Key = rule ID, value = severity or 'off'. */
	rules: Record<string, NinjaSeverity>;
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
	};
}

export const DEFAULT_CONFIG: NinjaConfig = {
	enabled: true,
	format: { mode: 'off' },
	rules: {},
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
	},
};
