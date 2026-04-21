import type { CapitalisationPolicy, NinjaConfig } from '../config';
import type { DialectSymbols } from '../../ftl/sql-parser';

/**
 * Capitalisation applied by the reflow printer.
 *
 * Keyword / function / type classification comes ENTIRELY from
 * `DialectSymbols` — the authoritative sets sqlglot produces for the
 * active dialect. Production always has them (ParseService resolves
 * them once per dialect); tests that want to exercise recasing without
 * booting Pyodide build a stub `DialectSymbols` locally.
 *
 * Identifier casing is NOT part of reflow: it changes meaning under
 * quoting policies and belongs in the `cap-identifiers` surgical rule.
 */

/** Literal constants always treated as keywords for cap purposes. */
const LITERAL_TYPES = new Set(['null', 'true', 'false']);

/**
 * State for the `consistent` policy plus the resolved sets for keywords,
 * functions, and types. Threaded through the printer walk so each token
 * can be classified against the right dialect-aware sources.
 */
export interface CapitalisationState {
	keywordFirstSeen: Map<string, string>;
	literalFirstSeen: Map<string, string>;
	functionFirstSeen: Map<string, string>;
	typeFirstSeen: Map<string, string>;
	keywordTypes: ReadonlySet<string>;
	functionNames: ReadonlySet<string>;
	typeNames: ReadonlySet<string>;
}

/**
 * Build a fresh state. When `symbols` is absent the state degrades to
 * "never recase a keyword/function/type" — the printer still runs but
 * capitalisation policy silently no-ops. Production must always pass
 * symbols; tests supply a stub or skip recasing assertions.
 */
export function createCapitalisationState(symbols?: DialectSymbols): CapitalisationState {
	const empty: ReadonlySet<string> = new Set<string>();
	return {
		keywordFirstSeen: new Map(),
		literalFirstSeen: new Map(),
		functionFirstSeen: new Map(),
		typeFirstSeen: new Map(),
		keywordTypes: symbols?.keywordTokenTypes ?? empty,
		functionNames: symbols?.functions ?? empty,
		typeNames: symbols?.types ?? empty,
	};
}

/**
 * Apply capitalisation policy to a single token's text.
 *
 * The printer passes the NEXT token's type via `nextTokenType` so a VAR
 * followed by `L_PAREN` can be recognised as a function call. That's the
 * only way to tell `count(*)` (function) from `a.count` (qualified
 * identifier) without re-parsing.
 */
export function recaseToken(
	tokenType: string,
	literal: string,
	config: NinjaConfig,
	state: CapitalisationState,
	nextTokenType?: string,
): string {
	const typeKey = tokenType.toLowerCase();

	if (LITERAL_TYPES.has(typeKey)) {
		return apply(literal, config.capitalisation.literals, state.literalFirstSeen);
	}

	if (state.keywordTypes.has(typeKey)) {
		return apply(literal, config.capitalisation.keywords, state.keywordFirstSeen);
	}

	const wordLower = literal.toLowerCase();
	if ((typeKey === 'var' || typeKey === 'identifier')
		&& nextTokenType === 'L_PAREN'
		&& state.functionNames.has(wordLower)
	) {
		return apply(literal, config.capitalisation.functions, state.functionFirstSeen);
	}

	if ((typeKey === 'var' || typeKey === 'identifier')
		&& state.typeNames.has(wordLower)
	) {
		return apply(literal, config.capitalisation.types, state.typeFirstSeen);
	}

	return literal;
}

function apply(word: string, policy: CapitalisationPolicy, firstSeen: Map<string, string>): string {
	if (policy === 'upper') return word.toUpperCase();
	if (policy === 'lower') return word.toLowerCase();

	const key = word.toLowerCase();
	const seen = firstSeen.get(key);
	if (!seen) {
		firstSeen.set(key, word);
		return word;
	}
	return seen;
}
