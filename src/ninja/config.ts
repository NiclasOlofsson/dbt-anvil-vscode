import type { NinjaSeverity } from './rule';
import type { FormatPreset } from './presets';

export type CapitalisationPolicy = 'upper' | 'lower' | 'consistent';

/**
 * Identifier style policy for introduced identifiers (column aliases, CTE
 * names, table aliases). `off` disables the rule entirely.
 *
 * The four "real" styles all describe the visible shape of the identifier;
 * `lower`/`upper` are no-separator variants. See `src/ninja/identifier-style.ts`
 * for the structural definitions.
 */
export type IdentifierStylePolicy =
	| 'off'
	| 'snake_case'
	| 'camelCase'
	| 'PascalCase'
	| 'lower'
	| 'upper';

export interface IdentifierCapitalisation {
	/** Target style for introduced identifiers. `off` disables the check. */
	style: IdentifierStylePolicy;
	/**
	 * Acronyms that may appear as a single uppercase run inside camelCase or
	 * PascalCase identifiers (e.g. `URL`, `ID`). Matched case-insensitively.
	 * Used both to forgive acronym runs during detection and to preserve
	 * them during conversion.
	 */
	acronyms: string[];
	/**
	 * Optional whole-word tokens used to segment all-lowercase identifiers
	 * that lack visible markers (e.g. `customerid` → `customer + id` when
	 * `id` is in the list). Detection-only — does not affect conversion of
	 * identifiers that already have visible markers.
	 */
	words: string[];
}
export type CommaPosition = 'trailing' | 'leading';
export type OperatorPosition = 'trailing' | 'leading';
export type NotEqualStyle = '!=' | '<>';
export type UnionStyle = 'all' | 'distinct';

export interface AlwaysWrapPolicy {
	/** SELECT lists: multi-target → each target on own line. */
	select: boolean;
	/** Top-level GROUP BY targets each on own line. */
	groupBy: boolean;
	/** Top-level ORDER BY targets each on own line. */
	orderBy: boolean;
	/** PARTITION BY inside an OVER(...) window on own line. */
	windowPartitionBy: boolean;
	/** ORDER BY inside an OVER(...) window on own line. */
	windowOrderBy: boolean;
	/** CASE: each WHEN/THEN/ELSE on own line. */
	case: boolean;
	/** WHERE keyword on own line, predicates indented (including the first). */
	where: boolean;
	/** HAVING keyword on own line, predicates indented (including the first). */
	having: boolean;
}

export interface NinjaConfig {
	enabled: boolean;
	/**
	 * Sub-gate for the Problems panel only. Formatting and code actions are
	 * unaffected by this flag — use `enabled: false` to turn the whole
	 * subsystem off.
	 */
	diagnostics: {
		enabled: boolean;
	};
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
		identifiers: IdentifierCapitalisation;
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
		/**
		 * Per-clause "always wrap" toggles. When `true`, the clause emits one
		 * item per line whenever it has 2+ items — regardless of whether the
		 * collapsed form would fit within `maxLineLength`. Single-item clauses
		 * stay inline.
		 *
		 * Default: all `false` (width-gated wrapping only).
		 */
		alwaysWrap: AlwaysWrapPolicy;
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
	diagnostics: { enabled: true },
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
		identifiers: {
			// Default `off` — picking a style policy is opinionated and
			// should be an explicit team choice, not something the tool
			// imposes silently. Presets that target specific style worlds
			// (snake_case for dbt) can flip this on.
			style: 'off',
			acronyms: ['ID', 'URL', 'XML', 'SQL', 'JSON', 'API', 'UUID', 'CSV', 'HTTP', 'DB'],
			words: [],
		},
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
		alwaysWrap: {
			// SELECT is the historical default — sqlfmt/dbt-labs both prescribe
			// "always wrap multi-target SELECTs", and the prior printer hard-
			// wired that behavior. Keeping the default `true` preserves it
			// while making the toggle a user-facing knob. The remaining flags
			// default `false` (opt-in vertical layout per clause).
			select: true,
			groupBy: false,
			orderBy: false,
			windowPartitionBy: false,
			windowOrderBy: false,
			case: false,
			where: false,
			having: false,
		},
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
