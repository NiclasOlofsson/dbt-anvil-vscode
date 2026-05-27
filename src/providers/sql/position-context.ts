import { ParseService } from '../../services/parse-service';
import type { DocumentModel, MacroCallInfo, RefInfo, SourceInfo } from '../../services/parse-service';

type ResolvedToken = NonNullable<ReturnType<typeof ParseService.resolveAtPosition>>;

export type PositionContext =
	| { kind: 'ref'; ref: RefInfo }
	| { kind: 'source'; source: SourceInfo }
	| { kind: 'macro'; name: string; packageName?: string; call: MacroCallInfo }
	| { kind: 'token'; resolved: ResolvedToken }
	| null;

/**
 * Classify what is under the cursor in a SQL document, given an already-parsed
 * DocumentModel. Returns null when the cursor is not over a navigable token.
 *
 * Order of precedence:
 *  1. ref()  / source() — matched by the model's jinja span (most precise)
 *  2. macro call inside {{ }} or {% %} — matched by `model.macroCalls`
 *  3. AST token via ParseService.resolveAtPosition
 */
export function resolvePositionContext(
	model: DocumentModel,
	_line: string,
	position: { line: number; character: number },
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

	// AST token
	const resolved = ParseService.resolveAtPosition(model, position.line, position.character);
	if (resolved) return { kind: 'token', resolved };

	return null;
}
