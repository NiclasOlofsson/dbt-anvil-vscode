import type { NinjaConfig } from '../config';

/**
 * Indentation decisions derived from {@link NinjaConfig}. A small, pure module
 * so the printer can ask questions like "how many spaces is one level?" or
 * "should JOIN be indented deeper than FROM?" without re-implementing the
 * config precedence every time.
 */
export interface IndentPolicy {
	/** Text representing a single level of indent (e.g. `    ` or `\t`). */
	readonly unit: string;
	/** Whether JOINs are indented one level deeper than FROM. */
	readonly indentedJoins: boolean;
	/** Whether ON/USING are indented one level deeper than their JOIN. */
	readonly indentedOn: boolean;
	/** Whether THEN is indented one level deeper than its WHEN. */
	readonly indentedThen: boolean;
	/** Whether CTE bodies are indented one extra level. */
	readonly indentedCtes: boolean;

	/** Build N levels of indent. */
	at(level: number): string;
}

export function createIndentPolicy(config: NinjaConfig): IndentPolicy {
	const { indentation } = config;
	const unit = indentation.unit === 'tab' ? '\t' : ' '.repeat(indentation.size);
	return {
		unit,
		indentedJoins: indentation.indentedJoins,
		indentedOn: indentation.indentedOn,
		indentedThen: indentation.indentedThen,
		indentedCtes: indentation.indentedCtes,
		at(level) {
			return level <= 0 ? '' : unit.repeat(level);
		},
	};
}
