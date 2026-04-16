import * as vscode from 'vscode';

/** Text edit fix — can be applied automatically or restricted to code actions only. */
export interface FixAction {
	type: 'fix';
	edits: vscode.TextEdit[];
	/** When false, excluded from bulk/auto-fix ("Fix all", source.fixAll.ninja). Use for destructive edits like deleting a CTE. */
	autoFix: boolean;
}

/** Snippet fix — inserts a template at a position, placing the cursor at a tab stop. Requires user input. */
export interface SnippetAction {
	type: 'snippet';
	position: vscode.Position;
	snippet: string;
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

	// Legacy flat fields — being migrated to `action`. Remove once all rules are updated.
	/** @deprecated Use `action` instead. */
	fix?: vscode.TextEdit[];
	/** @deprecated Use `action` instead. */
	noAutoFix?: true;
	/** @deprecated Use `action` instead. */
	snippetFix?: { position: vscode.Position; snippet: string };
}
