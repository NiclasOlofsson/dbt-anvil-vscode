import * as vscode from 'vscode';
import type { NinjaConfig } from './config';

/**
 * Structured fix operation — explicit intent rather than raw TextEdit.
 *
 * Rules emit FixOps instead of vscode.TextEdit so the forward-walking
 * applier can reason about each operation's purpose. In particular,
 * `linebreak` declares "I am inserting a structural line break at indent
 * level N" — the applier resolves the actual indent text from config, and
 * the indent rule can recognise lines created by a linebreak op as already
 * correctly indented.
 */
export type FixOp =
	| { kind: 'replace'; range: vscode.Range; text: string }
	| { kind: 'insert'; position: vscode.Position; text: string }
	| { kind: 'delete'; range: vscode.Range }
	| { kind: 'linebreak'; position: vscode.Position; indent: number };

// ── Convenience constructors ───────────────────────────────────────────

export function replaceOp(range: vscode.Range, text: string): FixOp {
	return { kind: 'replace', range, text };
}

export function insertOp(position: vscode.Position, text: string): FixOp {
	return { kind: 'insert', position, text };
}

export function deleteOp(range: vscode.Range): FixOp {
	return { kind: 'delete', range };
}

export function linebreakOp(position: vscode.Position, indent: number): FixOp {
	return { kind: 'linebreak', position, indent };
}

// ── Conversion for VS Code APIs (code actions, workspace edits) ────────

export function opToTextEdit(op: FixOp, config: NinjaConfig): vscode.TextEdit {
	switch (op.kind) {
		case 'replace': return vscode.TextEdit.replace(op.range, op.text);
		case 'insert': return vscode.TextEdit.insert(op.position, op.text);
		case 'delete': return vscode.TextEdit.delete(op.range);
		case 'linebreak': {
			const unit = config.indentation.unit === 'tab' ? '\t' : ' '.repeat(config.indentation.size);
			return vscode.TextEdit.insert(op.position, '\n' + unit.repeat(op.indent));
		}
	}
}
