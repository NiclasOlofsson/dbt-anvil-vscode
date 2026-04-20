import * as vscode from 'vscode';
import type { FixOp } from './fix-op';

/** Text edit fix — can be applied automatically or restricted to code actions only. */
export interface FixAction {
	type: typeof FixAction.TYPE;
	ops: FixOp[];
	/** When false, excluded from bulk/auto-fix ("Fix all", source.fixAll.ninja). Use for destructive edits like deleting a CTE. */
	autoFix: boolean;
}
export namespace FixAction {
	export const TYPE = 'fix' as const;
}

/** Snippet fix — inserts a template at a position, placing the cursor at a tab stop. Requires user input. */
export interface SnippetAction {
	type: typeof SnippetAction.TYPE;
	position: vscode.Position;
	snippet: string;
}
export namespace SnippetAction {
	export const TYPE = 'snippet' as const;
}

/** Discriminated union of all action types a violation can carry. */
export type NinjaAction = FixAction | SnippetAction;

/** A single style violation detected by a Ninja rule. */
export interface NinjaViolation {
	/** Rule ID, e.g. `ninja.cap.keywords`. */
	rule: string;
	/** Human-readable description. */
	message: string;
	/** Location in the document. */
	range: vscode.Range;
	/** The action available for this violation, if any. */
	action?: NinjaAction;
}
