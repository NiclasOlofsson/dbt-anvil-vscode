/**
 * Position-tracking buffer for multi-pass formatting.
 *
 * Layer 1 of the formatter ships the planner — `planEdits` returns a
 * non-overlapping batch that the host (VS Code) applies atomically. That is
 * sufficient for "fix-all" mode, where every edit is rooted in the original
 * document offsets.
 *
 * The reflow engine (Layer 3) needs more: it walks the original token stream
 * and, as it emits replacement text, must answer "what is the current range
 * of the token I originally saw at offset X?" — because earlier passes may
 * have already shifted the surrounding text. `Rewriter` is that primitive.
 *
 * Internally it stores an immutable original buffer plus a sorted list of
 * applied edits in original-offset space. `mapOffset` walks that list to
 * translate an original offset into a current-buffer offset; `apply` records
 * a new edit and updates the cumulative shift cache.
 */

interface AppliedEdit {
	/** Inclusive start in the *original* buffer. */
	origStart: number;
	/** Exclusive end in the *original* buffer. */
	origEnd: number;
	newText: string;
	/** Cumulative delta after this edit (newLen - origLen, summed left-to-right). */
	cumulativeDelta: number;
}

export class Rewriter {
	private readonly _original: string;
	private _edits: AppliedEdit[] = [];

	constructor(original: string) {
		this._original = original;
	}

	/** Original text, unchanged regardless of applied edits. */
	get original(): string { return this._original; }

	/**
	 * Replace the original range `[origStart, origEnd)` with `newText`.
	 * Throws if the new edit overlaps any previously applied edit — callers
	 * should run the planner first to guarantee non-overlap.
	 */
	apply(origStart: number, origEnd: number, newText: string): void {
		if (origStart < 0 || origEnd > this._original.length || origStart > origEnd) {
			throw new RangeError(`Rewriter.apply: invalid range [${origStart}, ${origEnd}) for buffer of length ${this._original.length}`);
		}
		// Find insert position; reject overlap.
		let i = 0;
		for (; i < this._edits.length; i++) {
			const e = this._edits[i];
			if (origStart < e.origEnd && origEnd > e.origStart) {
				throw new Error(`Rewriter.apply: overlap with prior edit [${e.origStart}, ${e.origEnd})`);
			}
			if (e.origStart >= origEnd) break;
		}
		const prevDelta = i === 0 ? 0 : this._edits[i - 1].cumulativeDelta;
		const newEdit: AppliedEdit = {
			origStart,
			origEnd,
			newText,
			cumulativeDelta: prevDelta + (newText.length - (origEnd - origStart)),
		};
		this._edits.splice(i, 0, newEdit);
		// Recompute cumulativeDelta forwards from the insert point.
		let running = prevDelta;
		for (let j = i; j < this._edits.length; j++) {
			const e = this._edits[j];
			running += e.newText.length - (e.origEnd - e.origStart);
			e.cumulativeDelta = running;
		}
	}

	/**
	 * Map an offset in the original buffer to its position in the rewritten
	 * buffer. If the offset falls inside a replaced range, the result is the
	 * start of the replacement (callers walking original tokens then have a
	 * stable anchor).
	 */
	mapOffset(origOffset: number): number {
		let delta = 0;
		for (const e of this._edits) {
			if (origOffset < e.origStart) break;
			if (origOffset < e.origEnd) {
				// Inside a replaced range — anchor to the start of the replacement.
				return e.origStart + delta;
			}
			delta = e.cumulativeDelta;
		}
		return origOffset + delta;
	}

	/** Materialize the rewritten text. */
	render(): string {
		if (this._edits.length === 0) return this._original;
		const out: string[] = [];
		let cursor = 0;
		for (const e of this._edits) {
			if (e.origStart > cursor) out.push(this._original.slice(cursor, e.origStart));
			out.push(e.newText);
			cursor = e.origEnd;
		}
		if (cursor < this._original.length) out.push(this._original.slice(cursor));
		return out.join('');
	}
}
