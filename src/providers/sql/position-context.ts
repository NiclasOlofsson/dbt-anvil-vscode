import { ParseService } from '../../services/parse-service';
import type { DocumentModel, RefInfo, SourceInfo } from '../../services/parse-service';

export const JINJA_BUILTINS = new Set([
	'ref', 'source', 'config', 'set', 'if', 'for', 'block', 'macro', 'call',
]);

type ResolvedToken = NonNullable<ReturnType<typeof ParseService.resolveAtPosition>>;

export type PositionContext =
	| { kind: 'ref'; ref: RefInfo }
	| { kind: 'source'; source: SourceInfo }
	| { kind: 'macro'; name: string }
	| { kind: 'token'; resolved: ResolvedToken }
	| null;

/**
 * Classify what is under the cursor in a SQL document, given an already-parsed
 * DocumentModel. Returns null when the cursor is not over a navigable token.
 *
 * Order of precedence:
 *  1. ref()  / source() — matched by the model's jinja span (most precise)
 *  2. macro call inside {{ }} — regex (model doesn't track these)
 *  3. AST token via ParseService.resolveAtPosition
 */
export function resolvePositionContext(
	model: DocumentModel,
	line: string,
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

	// macro call — regex (model doesn't track these; AST misclassifies as column)
	const macroRe = /\{\{[^}]*?\b([a-zA-Z_]\w*)\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = macroRe.exec(line)) !== null) {
		const nameStart = m.index + m[0].length - m[1].length - 1;
		const nameEnd = nameStart + m[1].length;
		if (position.character >= nameStart && position.character <= nameEnd) {
			if (!JINJA_BUILTINS.has(m[1])) {
				return { kind: 'macro', name: m[1] };
			}
		}
	}

	// AST token
	const resolved = ParseService.resolveAtPosition(model, position.line, position.character);
	if (resolved) return { kind: 'token', resolved };

	return null;
}
