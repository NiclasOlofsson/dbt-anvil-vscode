/**
 * resolvePositionContext: what's under the cursor in a parsed SQL document.
 * Focused here on the `function` kind (dbt 1.11+ user-defined functions) —
 * matched by the full `{{ function(...) }}` jinja span, same contract as
 * ref/source, checked after them and before a plain macro call.
 */
import { describe, expect, it } from 'vitest';
import { resolvePositionContext } from '../../../providers/sql/position-context';
import type { DocumentModel, FunctionInfo } from '../../../services/parse-service';

function baseModel(overrides: Partial<DocumentModel> = {}): DocumentModel {
	return {
		ctes: [],
		refs: [],
		sources: [],
		finalColumns: [],
		timing: { parseMs: 0, totalMs: 0 },
		...overrides,
	};
}

describe('resolvePositionContext — function', () => {
	// select {{ function('is_positive_int') }}(x)
	//        ^7 {{  ^10 function  ^20 name content  ^35 close-quote  ^40 after }}
	const fn: FunctionInfo = {
		name: 'is_positive_int', line: 0, col: 10, nameCol: 20, nameEndCol: 35, jinjaCol: 7, jinjaEndCol: 40,
	};
	const model = baseModel({ functions: [fn] });

	it('cursor inside the {{ function(...) }} span returns kind "function" with the FunctionInfo', () => {
		const ctx = resolvePositionContext(model, { line: 0, character: 15 }, 15);
		expect(ctx).toEqual({ kind: 'function', fn });
	});

	it('cursor at the jinja span boundaries is inside (start inclusive, end exclusive)', () => {
		expect(resolvePositionContext(model, { line: 0, character: 7 }, 7)).toEqual({ kind: 'function', fn });
		expect(resolvePositionContext(model, { line: 0, character: 39 }, 39)).toEqual({ kind: 'function', fn });
	});

	it('cursor outside the jinja span falls through (no ref/source/macro/sym match → null)', () => {
		expect(resolvePositionContext(model, { line: 0, character: 40 }, 40)).toBeNull();
		expect(resolvePositionContext(model, { line: 0, character: 6 }, 6)).toBeNull();
	});

	it('cursor on a different line falls through even if the column would match', () => {
		expect(resolvePositionContext(model, { line: 1, character: 15 }, 15)).toBeNull();
	});

	it('a document with no functions never reports kind "function"', () => {
		const ctx = resolvePositionContext(baseModel(), { line: 0, character: 15 }, 15);
		expect(ctx).toBeNull();
	});
});
