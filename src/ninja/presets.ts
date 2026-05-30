import type { NinjaConfig } from './config';

export type FormatPreset = 'sqlfmt' | 'dbt-labs' | 'dbt-studio' | 'custom';

/** Partial overrides that a preset applies on top of DEFAULT_CONFIG. */
export type PresetOverrides = Partial<Omit<NinjaConfig, 'enabled' | 'diagnostics' | 'rules' | 'autoFix' | 'format' | 'capitalisation' | 'indentation' | 'layout' | 'convention' | 'structure'>> & {
	capitalisation?: Partial<NinjaConfig['capitalisation']>;
	indentation?: Partial<NinjaConfig['indentation']>;
	layout?: Partial<Omit<NinjaConfig['layout'], 'alwaysWrap'>> & {
		alwaysWrap?: Partial<NinjaConfig['layout']['alwaysWrap']>;
	};
	convention?: Partial<NinjaConfig['convention']>;
	structure?: Partial<NinjaConfig['structure']>;
};

/**
 * sqlfmt-compatible defaults (https://sqlfmt.com/docs/style/):
 * - 88-char line length (sqlfmt's default)
 * - All keywords / functions lowercase
 * - Trailing commas
 * - Operators LEADING — sqlfmt's docs show `and two_field > another_field`
 *   with the AND at line start, contrary to what the comma position
 *   suggests. The two policies are independent in sqlfmt's style.
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
		operatorPosition: 'leading',
		alwaysWrap: {
			// sqlfmt prescribes vertical SELECT lists for multi-target queries
			// regardless of width — make the convention explicit in the preset.
			select: true,
		},
	},
	convention: {
		explicitAs: true,
		explicitInnerJoin: true,
	},
};

/**
 * dbt Labs style guide defaults (https://docs.getdbt.com/best-practices/how-we-style/2-how-we-style-our-sql):
 * - 80-char line length
 * - All keywords / functions lowercase
 * - Trailing commas (`field_1,\nfield_2,\nfield_3,`)
 * - Trailing AND/OR (`= 'abc' and\n(...)`)
 * - Explicit AS for aliases
 * - Explicit INNER JOIN (no bare JOIN)
 *
 * This reflects the CURRENT style guide on docs.getdbt.com. The legacy
 * style guide (which prescribed leading commas and 120-char lines) has
 * been retired by dbt Labs.
 */
const DBT_LABS_PRESET: PresetOverrides = {
	maxLineLength: 80,
	capitalisation: {
		keywords: 'lower',
		functions: 'lower',
		literals: 'lower',
		types: 'lower',
	},
	layout: {
		commaPosition: 'trailing',
		operatorPosition: 'trailing',
		alwaysWrap: {
			// dbt Labs style guide prescribes vertical SELECT lists.
			select: true,
		},
	},
	convention: {
		explicitAs: true,
		explicitInnerJoin: true,
	},
};

/**
 * dbt Studio house style: dbt-labs leading-comma/operator layout, plus
 * forced multi-line wrapping for GROUP BY, ORDER BY, the OVER window, CASE,
 * and WHERE/HAVING boolean chains. Matches the layout most dbt teams write
 * by hand — vertical clauses make diffs and review easier when columns or
 * predicates change.
 */
const DBT_STUDIO_PRESET: PresetOverrides = {
	maxLineLength: 120,
	capitalisation: {
		keywords: 'lower',
		functions: 'lower',
		literals: 'lower',
		types: 'lower',
	},
	layout: {
		commaPosition: 'trailing',
		operatorPosition: 'leading',
		alwaysWrap: {
			select: true,
			groupBy: true,
			orderBy: true,
			windowPartitionBy: true,
			windowOrderBy: true,
			case: true,
			where: true,
			having: true,
		},
	},
};

export const PRESETS: Record<FormatPreset, PresetOverrides> = {
	sqlfmt: SQLFMT_PRESET,
	'dbt-labs': DBT_LABS_PRESET,
	'dbt-studio': DBT_STUDIO_PRESET,
	custom: {},
};
