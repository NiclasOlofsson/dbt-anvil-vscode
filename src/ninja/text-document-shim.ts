import * as vscode from 'vscode';

/**
 * Minimal vscode.TextDocument shim for workspace diagnostics scanning.
 * Constructed from raw file content so we can run the ninja engine
 * without calling vscode.workspace.openTextDocument(), which is slow.
 */
export class TextDocumentShim implements vscode.TextDocument {
	readonly uri: vscode.Uri;
	readonly fileName: string;
	readonly isUntitled = false;
	readonly languageId = 'jinja-sql';
	readonly version = 1;
	readonly isDirty = false;
	readonly isClosed = false;
	readonly eol = vscode.EndOfLine.LF;
	readonly lineCount: number;
	readonly encoding = 'utf8';

	private readonly _lines: string[];
	private readonly _lineOffsets: number[];
	private readonly _content: string;

	constructor(uri: vscode.Uri, content: string) {
		this.uri = uri;
		this.fileName = uri.fsPath;
		this._content = content;
		this._lines = content.split('\n');
		this.lineCount = this._lines.length;

		// Build cumulative line-start offsets for positionAt / offsetAt
		this._lineOffsets = new Array<number>(this._lines.length);
		this._lineOffsets[0] = 0;
		for (let i = 1; i < this._lines.length; i++) {
			this._lineOffsets[i] = this._lineOffsets[i - 1] + this._lines[i - 1].length + 1;
		}
	}

	getText(range?: vscode.Range): string {
		if (!range) return this._content;
		const start = this.offsetAt(range.start);
		const end = this.offsetAt(range.end);
		return this._content.slice(start, end);
	}

	lineAt(lineOrPos: number | vscode.Position): vscode.TextLine {
		const n = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
		const text = this._lines[n] ?? '';
		const firstNws = text.search(/\S/);
		return {
			lineNumber: n,
			text,
			range: new vscode.Range(n, 0, n, text.length),
			rangeIncludingLineBreak: new vscode.Range(n, 0, n + 1, 0),
			firstNonWhitespaceCharacterIndex: firstNws === -1 ? text.length : firstNws,
			isEmptyOrWhitespace: firstNws === -1,
		};
	}

	offsetAt(position: vscode.Position): number {
		return (this._lineOffsets[position.line] ?? 0) + position.character;
	}

	positionAt(offset: number): vscode.Position {
		let lo = 0;
		let hi = this._lines.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this._lineOffsets[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return new vscode.Position(lo, offset - this._lineOffsets[lo]);
	}

	getWordRangeAtPosition(_position: vscode.Position, _regex?: RegExp): vscode.Range | undefined {
		return undefined;
	}

	validateRange(range: vscode.Range): vscode.Range {
		return range;
	}

	validatePosition(position: vscode.Position): vscode.Position {
		return position;
	}

	save(): Thenable<boolean> {
		return Promise.resolve(false);
	}
}
