import type { NinjaConfig } from './config';

export type FormatPreset = 'sqlfmt' | 'dbt-labs' | 'custom';

/** Partial overrides that a preset applies on top of DEFAULT_CONFIG. */
export type PresetOverrides = Partial<Omit<NinjaConfig, 'enabled' | 'rules' | 'autoFix' | 'format' | 'capitalisation' | 'indentation' | 'layout' | 'convention' | 'structure'>> & {
	capitalisation?: Partial<NinjaConfig['capitalisation']>;
	indentation?: Partial<NinjaConfig['indentation']>;
	layout?: Partial<NinjaConfig['layout']>;
	convention?: Partial<NinjaConfig['convention']>;
	structure?: Partial<NinjaConfig['structure']>;
};

/**
 * sqlfmt-compatible defaults (https://sqlfmt.com):
 * - 88-char line length
 * - All keywords / functions lowercase
 * - Trailing commas
 * - Operators trailing
 */
const SQLFMT_PRESET: PresetOverrides = {
	maxLineLength: 88,
	capitalisation: {
		keywords: 'lower',
		functions: 'lower',
		literals: 'lower',
		types: 'lower',
	},
	layout: {
		commaPosition: 'trailing',
		operatorPosition: 'trailing',
	},
	convention: {
		explicitAs: true,
		explicitInnerJoin: true,
	},
};

/**
 * dbt Labs style guide defaults:
 * - 120-char line length (original default)
 * - Leading commas
 * - Operators leading
 */
const DBT_LABS_PRESET: PresetOverrides = {
	maxLineLength: 120,
	capitalisation: {
		keywords: 'lower',
		functions: 'lower',
		literals: 'lower',
		types: 'lower',
	},
	layout: {
		commaPosition: 'leading',
		operatorPosition: 'leading',
	},
};

export const PRESETS: Record<FormatPreset, PresetOverrides> = {
	sqlfmt: SQLFMT_PRESET,
	'dbt-labs': DBT_LABS_PRESET,
	custom: {},
};
