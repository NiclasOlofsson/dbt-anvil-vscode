import type * as vscode from 'vscode';
import { FixAction, type NinjaViolation } from '../violation';
import { DEFAULT_RULE_PRIORITY, getRulePriority } from '../engine';
import type { FixOp } from '../fix-op';

/**
 * One rule's `FixAction` collapsed into offset-space. The whole group is
 * applied or dropped together — rules like `convention.operator-position`
 * emit paired ops that are only semantically valid as a unit.
 */
export interface FixGroup {
	rule: string;
	priority: number;
	/** Sequence index of the source violation; lower = earlier rule output. */
	seq: number;
	/** Inclusive start offset (min over the group's ops). */
	start: number;
	/** Exclusive end offset (max over the group's ops). */
	end: number;
	ops: FixOp[];
}

/** Diagnostic emitted when a fix group is dropped during arbitration. */
export interface DroppedFix {
	rule: string;
	reason: 'overlap-loser';
	winnerRule: string;
}

/** Output of `planEdits` — surviving groups sorted ascending, plus what was dropped. */
export interface PlannedEdits {
	groups: FixGroup[];
	dropped: DroppedFix[];
}

export interface PlanEditsOptions {
	/**
	 * Rule-id → priority override. Defaults to `getRulePriority` from the
	 * engine. Test code can pass a stub here; runtime callers should leave it
	 * undefined.
	 */
	priorityFor?: (ruleId: string) => number;
}

/**
 * Plan a safe, non-overlapping batch of edits from a list of violations.
 *
 * Inputs are violations that the caller has already filtered by autoFix
 * policy. The planner is responsible for:
 *   1. Collapsing each violation's FixAction into one atomic group keyed by
 *      offset (paired insert+delete edits stay together).
 *   2. Detecting overlapping groups across rules.
 *   3. Arbitrating overlaps by `(priority asc, seq asc)` — lower priority
 *      wins; on ties, the earlier-emitted group wins. Losers are dropped and
 *      will re-fire on the next pass once the winner has converged.
 *   4. Sorting surviving edits by start offset descending so sequential
 *      apply does not invalidate later ranges.
 *
 * Convergence note: the loser-drops-and-retries strategy guarantees the
 * formatter converges in a bounded number of passes (typically 1–2). It is
 * not "merge edits" — merging two rules' edits is a correctness hazard.
 */
export function planEdits(
	violations: NinjaViolation[],
	document: vscode.TextDocument,
	options: PlanEditsOptions = {},
): PlannedEdits {
	const priorityFor = options.priorityFor ?? getRulePriority;
	const groups: FixGroup[] = [];

	let seq = 0;
	for (const v of violations) {
		if (v.action?.type !== FixAction.TYPE) continue;
		if (v.action.ops.length === 0) continue;

		let start = Number.POSITIVE_INFINITY;
		let end = Number.NEGATIVE_INFINITY;
		for (const op of v.action.ops) {
			let s: number;
			let en: number;
			if (op.kind === 'insert' || op.kind === 'linebreak') {
				s = en = document.offsetAt(op.position);
			} else {
				s = document.offsetAt(op.range.start);
				en = document.offsetAt(op.range.end);
			}
			if (s < start) start = s;
			if (en > end) end = en;
		}

		groups.push({
			rule: v.rule,
			priority: priorityFor(v.rule) ?? DEFAULT_RULE_PRIORITY,
			seq: seq++,
			start,
			end,
			ops: v.action.ops,
		});
	}

	const { kept, dropped } = arbitrateOverlaps(groups);

	// Sort ascending — the Rewriter-based applier walks forward.
	kept.sort((a, b) => a.start - b.start);

	return { groups: kept, dropped };
}

/**
 * Sweep groups in offset order; whenever the next group's [start,end) overlaps
 * the current "active" group, drop the higher-priority (or later-seq) loser.
 *
 * Pure-insertion edits (start === end) are treated as overlapping only when
 * they share the same offset as another group's range — touching insertions
 * at distinct offsets are safe.
 */
function arbitrateOverlaps(groups: FixGroup[]): { kept: FixGroup[]; dropped: DroppedFix[] } {
	if (groups.length === 0) return { kept: [], dropped: [] };

	const sorted = [...groups].sort((a, b) => (a.start - b.start) || (a.seq - b.seq));
	const kept: FixGroup[] = [];
	const dropped: DroppedFix[] = [];

	for (const next of sorted) {
		const conflict = findConflict(kept, next);
		if (!conflict) {
			kept.push(next);
			continue;
		}
		const winner = pickWinner(conflict, next);
		const loser = winner === conflict ? next : conflict;
		dropped.push({ rule: loser.rule, reason: 'overlap-loser', winnerRule: winner.rule });
		if (winner === next) {
			// Replace the previous winner in `kept`.
			const idx = kept.indexOf(conflict);
			if (idx >= 0) kept.splice(idx, 1);
			kept.push(next);
		}
	}
	return { kept, dropped };
}

/** Return any kept group that overlaps the candidate, or undefined. */
function findConflict(kept: FixGroup[], next: FixGroup): FixGroup | undefined {
	for (const k of kept) if (rangesOverlap(k, next)) return k;
	return undefined;
}

/**
 * Two ranges overlap when their open intervals intersect. Pure insertions
 * (start === end) are degenerate points: an insertion at offset X conflicts
 * with a non-empty group containing X, but two insertions at the same offset
 * also conflict (their relative order would be undefined and could corrupt
 * the result).
 */
function rangesOverlap(a: FixGroup, b: FixGroup): boolean {
	const aPoint = a.start === a.end;
	const bPoint = b.start === b.end;
	if (aPoint && bPoint) return a.start === b.start;
	if (aPoint) return a.start > b.start && a.start < b.end;
	if (bPoint) return b.start > a.start && b.start < a.end;
	return a.start < b.end && b.start < a.end;
}

function pickWinner(a: FixGroup, b: FixGroup): FixGroup {
	if (a.priority !== b.priority) return a.priority < b.priority ? a : b;
	return a.seq <= b.seq ? a : b;
}
