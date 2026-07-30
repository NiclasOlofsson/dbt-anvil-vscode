/** An insertion into a single line: `text` goes at column `character`. */
export interface NoqaInsertion {
	character: number;
	text: string;
}

const MARKER = '-- noqa';

/**
 * Build the edit that adds a `-- noqa` suppression for `ruleId` to one line.
 *
 * Mirrors `parseInlineSuppressions`: the marker is the *first* `-- noqa`
 * occurrence in the line, and everything after `-- noqa:` is the code list.
 *
 * Returns undefined when no edit would help: the line already suppresses every
 * rule, already lists this rule, or carries a `-- noqa` the engine does not read
 * as a marker (a second one further right would never be seen).
 */
export function buildNoqaInsertion(lineText: string, ruleId: string): NoqaInsertion | undefined {
	const character = lineText.trimEnd().length;
	const idx = lineText.indexOf(MARKER);

	if (idx === -1) {
		return { character, text: character === 0 ? `${MARKER}: ${ruleId}` : ` ${MARKER}: ${ruleId}` };
	}

	const rest = lineText.slice(idx + MARKER.length).trim();
	// Bare `-- noqa` (optionally followed by another comment) suppresses everything.
	if (rest === '' || rest.startsWith('--')) return undefined;
	// Anything other than a code list means the engine ignores this occurrence.
	if (!rest.startsWith(':')) return undefined;

	const codes = rest.slice(1).split(',').map(s => s.trim()).filter(Boolean);
	if (codes.includes(ruleId)) return undefined;

	return { character, text: codes.length > 0 ? `, ${ruleId}` : ` ${ruleId}` };
}
