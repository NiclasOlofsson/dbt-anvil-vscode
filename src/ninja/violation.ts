import * as vscode from 'vscode';

/** A single style violation detected by a Ninja rule. */
export interface NinjaViolation {
	/** Rule ID, e.g. `ninja.cap.keywords`. */
	rule: string;
	/** Human-readable description. */
	message: string;
	/** Location in the document. */
	range: vscode.Range;
	/** Auto-fix edits (omit when not fixable). */
	fix?: vscode.TextEdit[];
}
