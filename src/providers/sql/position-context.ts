import { ParseService } from '../../services/parse-service';
import type { DocumentModel, FunctionInfo, MacroCallInfo, RefInfo, SourceInfo } from '../../services/parse-service';
import type { Sym } from '../../ftl/sqllens/api';

export type PositionContext =
	| { kind: 'ref'; ref: RefInfo }
	| { kind: 'source'; source: SourceInfo }
	| { kind: 'function'; fn: FunctionInfo }
	| { kind: 'macro'; name: string; packageName?: string; call: MacroCallInfo }
	/**
	 * `sym` is the smallest-span symbol covering the cursor. `partIndex` is set
	 * only for a `kind: 'column'` symbol with `partSpans` (a dotted reference,
	 * e.g. `o.order_id`) — which part the cursor is actually on: any index
	 * before the last means the cursor is on a QUALIFIER part (the old
	 * PositionResolution's `table_qualifier` kind), the last index means it's
	 * on the column name itself (the old `column` kind). Absent for a
	 * single-part reference or a non-column symbol.
	 */
	| { kind: 'sym'; sym: Sym; partIndex?: number }
	| null;

/**
 * Classify what is under the cursor in a SQL document, given an already-parsed
 * DocumentModel. Returns null when the cursor is not over a navigable token.
 * `offset` is the cursor's absolute char offset (`document.offsetAt(position)`)
 * — the coordinate the Sym hit-testing speaks natively.
 *
 * Order of precedence:
 *  1. ref()  / source() — matched by the model's jinja span (most precise)
 *  2. macro call inside {{ }} or {% %} — matched by `model.macroCalls`
 *  3. Sym via ParseService.symAtPosition (sqllens's native symbol model)
 */
export function resolvePositionContext(
	model: DocumentModel,
	position: { line: number; character: number },
	offset: number,
): PositionContext {
	// ref — full {{ ref('...') }} jinja span
	const ref = model.refs.find(r =>
		r.line === position.line &&
		r.jinjaCol !== undefined && r.jinjaEndCol !== undefined &&
		position.character >= r.jinjaCol && position.character < r.jinjaEndCol,
	);
	if (ref) return { kind: 'ref', ref };

	// source — full {{ source('...', '...') }} jinja span
	const source = model.sources.find(s =>
		s.line === position.line &&
		s.jinjaCol !== undefined && s.jinjaEndCol !== undefined &&
		position.character >= s.jinjaCol && position.character < s.jinjaEndCol,
	);
	if (source) return { kind: 'source', source };

	// function — full {{ function('...') }} jinja span
	const fn = (model.functions ?? []).find(f =>
		f.line === position.line &&
		f.jinjaCol !== undefined && f.jinjaEndCol !== undefined &&
		position.character >= f.jinjaCol && position.character < f.jinjaEndCol,
	);
	if (fn) return { kind: 'function', fn };

	// macro call — match cursor against the bare identifier span, or the
	// `package.` qualifier when present. Multi-line tags work because
	// each span is recorded in absolute line/col coordinates.
	const call = (model.macroCalls ?? []).find(mc => {
		if (mc.line === position.line &&
			position.character >= mc.col && position.character <= mc.endCol) return true;
		if (mc.packageCol !== undefined && mc.packageEndCol !== undefined &&
			mc.line === position.line &&
			position.character >= mc.packageCol && position.character <= mc.packageEndCol) return true;
		return false;
	});
	if (call) {
		return {
			kind: 'macro',
			name: call.name,
			...(call.packageName ? { packageName: call.packageName } : {}),
			call,
		};
	}

	// Sym
	const sym = ParseService.symAtPosition(model, offset);
	if (sym) {
		const partIndex = ParseService.partIndexAtPosition(sym, offset);
		return { kind: 'sym', sym, ...(partIndex !== undefined ? { partIndex } : {}) };
	}

	return null;
}
