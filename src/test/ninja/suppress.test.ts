import { describe, it, expect } from 'vitest';
import { buildNoqaInsertion } from '../../ninja/code-actions/suppress';
import { parseInlineSuppressions } from '../../ninja/config-loader';

const RULE = 'ninja.aliasing.require-table-alias';

/** Apply an insertion and hand the result to the engine's own parser. */
function suppressed(lineText: string, ruleId: string): Set<string> | 'all' | undefined {
	const insertion = buildNoqaInsertion(lineText, ruleId);
	if (!insertion) return undefined;
	const after = lineText.slice(0, insertion.character) + insertion.text + lineText.slice(insertion.character);
	return parseInlineSuppressions([after]).get(0);
}

describe('buildNoqaInsertion', () => {
	it('appends a marker to a line that has none, and the engine reads it back', () => {
		const line = '    select * from {{ ref(\'stg_customers\') }}';
		const insertion = buildNoqaInsertion(line, RULE)!;
		expect(insertion.character).toBe(line.length);
		expect(insertion.text).toBe(` -- noqa: ${RULE}`);
		expect(suppressed(line, RULE)).toEqual(new Set([RULE]));
	});

	it('inserts before trailing whitespace so the marker is not stranded past it', () => {
		const line = 'select 1   ';
		const insertion = buildNoqaInsertion(line, RULE)!;
		expect(insertion.character).toBe('select 1'.length);
	});

	it('skips the leading space on an empty line', () => {
		expect(buildNoqaInsertion('', RULE)).toEqual({ character: 0, text: `-- noqa: ${RULE}` });
	});

	it('adds the rule to an existing code list instead of a second marker', () => {
		const line = 'select 1 -- noqa: ninja.cap.keywords';
		expect(buildNoqaInsertion(line, RULE)!.text).toBe(`, ${RULE}`);
		expect(suppressed(line, RULE)).toEqual(new Set(['ninja.cap.keywords', RULE]));
	});

	it('fills in an empty code list without a leading comma', () => {
		const line = 'select 1 -- noqa:';
		expect(buildNoqaInsertion(line, RULE)!.text).toBe(` ${RULE}`);
		expect(suppressed(line, RULE)).toEqual(new Set([RULE]));
	});

	it('offers nothing when the rule is already listed', () => {
		expect(buildNoqaInsertion(`select 1 -- noqa: ${RULE}, ninja.cap.keywords`, RULE)).toBeUndefined();
	});

	it('offers nothing when a bare marker already suppresses every rule', () => {
		expect(buildNoqaInsertion('select 1 -- noqa', RULE)).toBeUndefined();
		expect(buildNoqaInsertion('select 1 -- noqa -- because reasons', RULE)).toBeUndefined();
	});

	it('offers nothing when a `-- noqa` prefix the engine ignores comes first', () => {
		// parseInlineSuppressions keys off the FIRST `-- noqa`, so a marker appended
		// after this one would never be read — better no action than a dead one.
		expect(buildNoqaInsertion('select 1 -- noqafied by hand', RULE)).toBeUndefined();
	});
});
