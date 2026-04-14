import type { NinjaSeverity } from './rule';

export type CapitalisationPolicy = 'upper' | 'lower' | 'consistent';
export type CommaPosition = 'trailing' | 'leading';
export type OperatorPosition = 'trailing' | 'leading';

export interface NinjaConfig {
	enabled: boolean;
	/** Per-rule severity overrides. Key = rule ID, value = severity or 'off'. */
	rules: Record<string, NinjaSeverity>;
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
	layout: {
		commaPosition: CommaPosition;
		operatorPosition: OperatorPosition;
	};
	structure: {
		allowStarInCte: boolean;
	};
}

export const DEFAULT_CONFIG: NinjaConfig = {
	enabled: true,
	rules: {},
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
	layout: {
		commaPosition: 'trailing',
		operatorPosition: 'trailing',
	},
	structure: {
		allowStarInCte: false,
	},
};
