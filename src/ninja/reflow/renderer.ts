/**
 * Pass 2 of the reflow engine: renders a TopLevelSegment[] tree to a
 * formatted SQL string.
 *
 * Layout rules:
 * - Clause keywords (SELECT, FROM, WHERE, …) start at `baseIndent`.
 * - Clause bodies are at `baseIndent + 1`.
 * - Lists try to fit on one line with the keyword; if they exceed
 *   `maxLineLength` they expand to one item per line.
 * - Paren groups follow the same inline-or-expand logic.
 * - Jinja tokens are emitted verbatim — never split or modified.
 * - CTE bodies use `baseIndent = 2` (name at 1, content at 2+).
 * - Set operators (UNION ALL etc.) appear on their own line.
 */

import type { NinjaConfig } from '../config';
import type {
	Segment, TopLevelSegment,
	ClauseSegment, CteSegment, WithSegment, StatementSegment,
	ListSegment, ParenSegment, SetOpSegment,
} from './segments';

export function render(segments: TopLevelSegment[], config: NinjaConfig): string {
	return new Renderer(config).renderTopLevel(segments);
}

class Renderer {
	private readonly indentUnit: string;
	private readonly maxLen: number;
	private readonly commaPos: 'trailing' | 'leading';

	constructor(private readonly config: NinjaConfig) {
		const sz = config.indentation.size;
		this.indentUnit = config.indentation.unit === 'tab' ? '\t' : ' '.repeat(sz);
		this.maxLen = config.maxLineLength;
		this.commaPos = config.layout.commaPosition;
	}

	private ind(level: number): string {
		return level > 0 ? this.indentUnit.repeat(level) : '';
	}

	// ── Top-level ─────────────────────────────────────────────────────────────

	renderTopLevel(segs: TopLevelSegment[]): string {
		const out: string[] = [];
		for (const seg of segs) {
			switch (seg.type) {
				case 'blank-line': out.push(''); break;
				case 'comment': out.push(seg.text); break;
				case 'with': out.push(this.renderWith(seg)); break;
				case 'statement': out.push(this.renderStatement(seg, 0)); break;
				case 'setop': out.push(this.renderSetOp(seg, 0)); break;
			}
		}
		return out.join('\n');
	}

	// ── WITH block ─────────────────────────────────────────────────────────────

	private renderWith(seg: WithSegment): string {
		const lines: string[] = ['with'];
		for (let i = 0; i < seg.ctes.length; i++) {
			lines.push(this.renderCte(seg.ctes[i], i === seg.ctes.length - 1));
		}
		if (seg.finalSelect.length > 0) {
			lines.push('');
			lines.push(...this.renderTopLevelList(seg.finalSelect as TopLevelSegment[], 0));
		}
		return lines.join('\n');
	}

	private renderCte(cte: CteSegment, isLast: boolean): string {
		const header = `${this.ind(1)}${cte.name} as (`;
		const footer = `${this.ind(1)})${isLast ? '' : ','}`;
		const bodyLines = this.renderTopLevelList(cte.body as TopLevelSegment[], 2);
		return [header, ...bodyLines, footer].join('\n');
	}

	private renderTopLevelList(segs: TopLevelSegment[], base: number): string[] {
		const lines: string[] = [];
		for (const seg of segs) {
			switch (seg.type) {
				case 'blank-line': lines.push(''); break;
				case 'comment': lines.push(this.ind(base) + seg.text); break;
				case 'with': lines.push(...this.renderWith(seg).split('\n')); break;
				case 'setop': lines.push(this.renderSetOp(seg, base)); break;
				case 'statement':
					lines.push(...this.renderStatement(seg, base).split('\n'));
					break;
			}
		}
		return lines;
	}

	// ── Statement ─────────────────────────────────────────────────────────────

	private renderStatement(seg: StatementSegment, base: number): string {
		return seg.clauses.map(c => this.renderClause(c, base)).join('\n');
	}

	// ── Set operator ──────────────────────────────────────────────────────────

	private renderSetOp(seg: SetOpSegment, base: number): string {
		return this.ind(base) + seg.text;
	}

	// ── Clause ────────────────────────────────────────────────────────────────

	private renderClause(clause: ClauseSegment, base: number): string {
		const kw = this.ind(base) + clause.keywordText;
		if (clause.body.length === 0) return kw;

		// Try single-line: "select a, b, c"
		const inlineBody = this.inlineSegs(clause.body);
		if (inlineBody !== null) {
			const candidate = kw + ' ' + inlineBody;
			if (candidate.length <= this.maxLen) return candidate;
		}

		// Vertical: keyword alone, body indented at base+1
		const bodyLines = this.expandSegs(clause.body, base + 1);
		return kw + '\n' + bodyLines.join('\n');
	}

	// ── Inline helpers ────────────────────────────────────────────────────────

	/**
	 * Try to render a segment array as a single space-joined string.
	 * Returns null if any segment forces a line break (comment, statement, etc.).
	 */
	private inlineSegs(segs: Segment[]): string | null {
		const parts: string[] = [];
		for (const seg of segs) {
			const t = this.inlineSeg(seg);
			if (t === null) return null;
			if (t !== '') parts.push(t);
		}
		return parts.join(' ');
	}

	private inlineSeg(seg: Segment): string | null {
		switch (seg.type) {
			case 'atom': return seg.text;
			case 'jinja': return seg.text;
			case 'setop': return seg.text;
			case 'comment': return null;
			case 'blank-line': return null;
			case 'list': return this.inlineList(seg);
			case 'paren': {
				const inner = this.inlineSegs(seg.body);
				if (inner === null) return null;
				return '(' + inner + ')';
			}
			// Nested clauses/statements/withs always force newlines.
			case 'clause':
			case 'statement':
			case 'with':
			case 'cte':
				return null;
		}
	}

	private inlineList(seg: ListSegment): string | null {
		const items: string[] = [];
		for (const item of seg.items) {
			const t = this.inlineSegs(item);
			if (t === null) return null;
			items.push(t);
		}
		return items.join(', ') + (seg.trailingComma ? ',' : '');
	}

	// ── Expand helpers ─────────────────────────────────────────────────────────

	/**
	 * Render a body segment array as an array of indented lines.
	 * Lists expand to one-item-per-line; everything else is grouped onto
	 * as few lines as possible (non-list bodies stay on one line at `indent`).
	 */
	private expandSegs(segs: Segment[], indent: number): string[] {
		const hasList = segs.some(s => s.type === 'list');

		if (!hasList) {
			// Non-list body: join all segments as one indented line.
			const text = segs
				.map(s => this.renderSeg(s, indent))
				.filter(t => t !== '')
				.join(' ');
			return text ? [this.ind(indent) + text] : [];
		}

		const lines: string[] = [];
		for (const seg of segs) {
			if (seg.type === 'list') {
				lines.push(...this.expandList(seg, indent));
			} else {
				const text = this.renderSeg(seg, indent);
				if (text !== '') lines.push(this.ind(indent) + text);
			}
		}
		return lines;
	}

	private expandList(seg: ListSegment, indent: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < seg.items.length; i++) {
			const isLast = i === seg.items.length - 1;
			const itemText = seg.items[i]
				.map(s => this.renderSeg(s, indent))
				.filter(t => t !== '')
				.join(' ');

			if (this.commaPos === 'trailing') {
				const comma = !isLast || seg.trailingComma ? ',' : '';
				lines.push(this.ind(indent) + itemText + comma);
			} else {
				// leading: first item has no prefix; subsequent items get ", "
				const prefix = i === 0 ? '' : ', ';
				lines.push(this.ind(indent) + prefix + itemText);
			}
		}
		return lines;
	}

	// ── Generic segment renderer ──────────────────────────────────────────────

	private renderSeg(seg: Segment, indent: number): string {
		switch (seg.type) {
			case 'atom': return seg.text;
			case 'jinja': return seg.text;
			case 'comment': return seg.text;
			case 'blank-line': return '';
			case 'setop': return seg.text;
			case 'list': {
				const inline = this.inlineList(seg);
				if (inline !== null) return inline;
				return this.expandList(seg, indent).join('\n');
			}
			case 'paren': {
				const inner = this.inlineSegs(seg.body);
				if (inner !== null) return '(' + inner + ')';
				const bodyLines = this.expandParenBody(seg.body, indent + 1);
				return '(\n' + bodyLines.join('\n') + '\n' + this.ind(indent) + ')';
			}
			case 'clause': return this.renderClause(seg, indent);
			case 'statement': return this.renderStatement(seg, indent);
			case 'with': return this.renderWith(seg);
			case 'cte': return this.renderCte(seg, true);
		}
	}

	private expandParenBody(body: Segment[], indent: number): string[] {
		const lines: string[] = [];
		for (const seg of body) {
			if (seg.type === 'list') {
				lines.push(...this.expandList(seg, indent));
			} else {
				const text = this.renderSeg(seg, indent);
				if (text !== '') lines.push(this.ind(indent) + text);
			}
		}
		return lines;
	}
}
