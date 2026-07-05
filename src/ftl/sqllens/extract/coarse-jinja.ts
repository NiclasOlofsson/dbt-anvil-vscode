/**
 * Coarse per-tag jinja tokens — the ninja engine's currency (`text` runs between
 * whole `expression` / `tag` / `comment` tags) — derived from the fine-grained
 * jinja stream every `DocumentModel` carries (sqllens-fed on the native path).
 *
 * Replaces `src/dbt/jinja-tokenizer.ts`'s own source scan. Its semantics are
 * preserved exactly where they are load-bearing:
 *   - a tag OPENING inside a `--` line comment is not a tag (it stays text), so
 *     rules never flag jinja on commented-out lines;
 *   - `content` strips exactly the 2-char delimiters, keeping whitespace-control
 *     dashes (`{{- x -}}` → `- x -`);
 *   - adjacent tags produce no empty text token between them.
 * Known divergence (unrepresentable in the fine stream, which never emits
 * them): unterminated tags at EOF stay text here, where the old scanner emitted
 * a truncated tag token. That only occurs mid-keystroke on broken sources.
 */
import type { JinjaToken as FineJinjaToken } from '../../jinja-tokenizer';
import { parseTemplated, toSqllensDialect } from '../api';
import { jinjaTokensFromStream } from './jinja-stream';

export type JinjaTokenType = 'text' | 'expression' | 'tag' | 'comment';

export interface JinjaToken {
	type: JinjaTokenType;
	/** Inner content with delimiters stripped, whitespace-control dashes included if present. */
	content: string;
	/** Original source text including delimiters. */
	raw: string;
	/** Inclusive start offset in the source string. */
	start: number;
	/** Exclusive end offset in the source string. */
	end: number;
}

const OPEN_TYPES = {
	jinja_expression_open: 'expression',
	jinja_block_open: 'tag',
	jinja_comment_open: 'comment',
} as const;

/**
 * Group the fine-grained stream into coarse per-tag tokens. Every `*_open` fine
 * token carries `tagEnd`, so each whole tag is one O(1) lookup; the runs between
 * accepted tags become `text` tokens. The sequential `--` scan reproduces the
 * old scanner's line-comment skip: a `--` reached in text mode swallows every
 * tag opening before the next newline.
 */
export function coarseJinjaTokens(fine: readonly FineJinjaToken[], source: string): JinjaToken[] {
	interface Tag { type: JinjaTokenType; start: number; end: number }
	const tags: Tag[] = [];
	for (const tok of fine) {
		const type = OPEN_TYPES[tok.type as keyof typeof OPEN_TYPES];
		if (type !== undefined && tok.tagEnd !== undefined) {
			tags.push({ type, start: tok.start, end: tok.tagEnd });
		}
	}

	const out: JinjaToken[] = [];
	let textStart = 0;
	const flushText = (end: number): void => {
		if (end > textStart) {
			const content = source.slice(textStart, end);
			out.push({ type: 'text', content, raw: content, start: textStart, end });
		}
		textStart = end;
	};

	let i = 0; // sequential scan cursor, needed only for the `--` skip semantics
	let t = 0;
	while (t < tags.length) {
		const tag = tags[t];
		if (tag.start < i) { // opened inside a skipped line comment — stays text
			t++;
			continue;
		}
		if (source[i] === '-' && source[i + 1] === '-') {
			const nl = source.indexOf('\n', i);
			i = nl === -1 ? source.length : nl + 1;
			continue;
		}
		if (i < tag.start) {
			i++;
			continue;
		}
		flushText(tag.start);
		out.push({
			type: tag.type,
			content: source.slice(tag.start + 2, tag.end - 2),
			raw: source.slice(tag.start, tag.end),
			start: tag.start,
			end: tag.end,
		});
		textStart = tag.end;
		i = tag.end;
		t++;
	}
	flushText(source.length);
	return out;
}

/**
 * Coarse tokens straight from source text — the no-model path (parse failed or
 * unavailable). Runs sqllens's templated front end for the fine stream first;
 * jinja segmentation is dialect-independent, so the default dialect suffices.
 */
export function coarseJinjaTokensFromText(source: string): JinjaToken[] {
	const templated = parseTemplated(source, toSqllensDialect(undefined));
	return coarseJinjaTokens(jinjaTokensFromStream(templated.tokens, templated.tags, source), source);
}
