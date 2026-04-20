/**
 * Top-level entry point for the reflow formatter (Layer 3).
 *
 * Ties together the segmenter (token stream → segment tree) and the
 * renderer (segment tree → formatted string). The caller is responsible
 * for turning the returned string into a single full-document TextEdit.
 *
 * Returns the original source unchanged when there are no SQL tokens
 * (e.g. pure-jinja files, empty documents).
 */

import * as vscode from 'vscode';
import type { DocumentModel } from '../../services/parse-service';
import type { NinjaConfig } from '../config';
import { segment } from './segmenter';
import { render } from './renderer';

/**
 * Format a SQL document using the reflow engine.
 *
 * @param document  The live VS Code document (source text + position utilities).
 * @param model     Parsed document model — must contain `ninjaSqlTokens`.
 * @param config    Current Ninja config (indent size, max line length, comma position, …).
 * @returns         A single `TextEdit` replacing the whole document, or an empty
 *                  array when the document is already correctly formatted or has no tokens.
 */
export function formatDocument(
	document: vscode.TextDocument,
	model: DocumentModel,
	config: NinjaConfig,
): vscode.TextEdit[] {
	const tokens = model.ninjaSqlTokens;
	if (!tokens || tokens.length === 0) return [];

	const source = document.getText();
	const tree = segment(tokens, source);
	if (tree.length === 0) return [];

	let formatted = render(tree, config);

	// Normalise trailing newline — always end with exactly one.
	formatted = formatted.trimEnd() + '\n';

	if (formatted === source) return [];

	// Replace the whole document with one edit (avoids all range-overlap issues).
	const fullRange = new vscode.Range(
		new vscode.Position(0, 0),
		document.positionAt(source.length),
	);
	return [vscode.TextEdit.replace(fullRange, formatted)];
}
