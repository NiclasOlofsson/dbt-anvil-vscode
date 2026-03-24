import * as fs from 'node:fs';
import { vi } from 'vitest';

export class Uri {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fragment: string;
	readonly fsPath: string;

	private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
		this.scheme = scheme;
		this.authority = authority;
		this.path = path;
		this.query = query;
		this.fragment = fragment;
		this.fsPath = path.replace(/\//g, process.platform === 'win32' ? '\\' : '/');
	}

	static file(path: string): Uri {
		return new Uri('file', '', path.replace(/\\/g, '/'), '', '');
	}

	static parse(value: string): Uri {
		const url = new URL(value);
		return new Uri(url.protocol.replace(':', ''), url.host, url.pathname, url.search.slice(1), url.hash.slice(1));
	}

	static joinPath(base: Uri, ...pathSegments: string[]): Uri {
		const joined = [base.path, ...pathSegments].join('/').replace(/\/+/g, '/');
		return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
	}

	toString(): string {
		return `${this.scheme}://${this.authority}${this.path}`;
	}

	with(change: Partial<{ scheme: string; authority: string; path: string; query: string; fragment: string }>): Uri {
		return new Uri(
			change.scheme ?? this.scheme,
			change.authority ?? this.authority,
			change.path ?? this.path,
			change.query ?? this.query,
			change.fragment ?? this.fragment,
		);
	}
}

export class Position {
	constructor(
		public readonly line: number,
		public readonly character: number,
	) {}

	isEqual(other: Position): boolean {
		return this.line === other.line && this.character === other.character;
	}

	isBefore(other: Position): boolean {
		return this.line < other.line || (this.line === other.line && this.character < other.character);
	}

	isAfter(other: Position): boolean {
		return this.line > other.line || (this.line === other.line && this.character > other.character);
	}
}

export class Range {
	constructor(
		public readonly start: Position,
		public readonly end: Position,
	) {}

	get isEmpty(): boolean {
		return this.start.isEqual(this.end);
	}

	contains(positionOrRange: Position | Range): boolean {
		if (positionOrRange instanceof Position) {
			return !positionOrRange.isBefore(this.start) && !positionOrRange.isAfter(this.end);
		}
		return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
	}
}

export class Location {
	constructor(
		public readonly uri: Uri,
		public readonly range: Range | Position,
	) {}
}

export class LanguageModelTextPart {
	constructor(public readonly value: string) {}
}

export class LanguageModelToolResult {
	constructor(public readonly content: LanguageModelTextPart[]) {}
}

export enum TreeItemCollapsibleState {
	None = 0,
	Collapsed = 1,
	Expanded = 2,
}

export class TreeItem {
	label?: string;
	id?: string;
	iconPath?: ThemeIcon | Uri | { light: Uri; dark: Uri };
	description?: string;
	tooltip?: string;
	command?: Command;
	contextValue?: string;
	collapsibleState?: TreeItemCollapsibleState;
	resourceUri?: Uri;

	constructor(
		label: string | Uri,
		collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
	) {
		if (label instanceof Uri) {
			this.resourceUri = label;
		} else {
			this.label = label;
		}
		this.collapsibleState = collapsibleState;
	}
}

export class ThemeIcon {
	static readonly File = new ThemeIcon('file');
	static readonly Folder = new ThemeIcon('folder');

	constructor(
		public readonly id: string,
		public readonly color?: ThemeColor,
	) {}
}

export class ThemeColor {
	constructor(public id: string) {}
}

export class FileDecoration {
	color?: ThemeColor;
	constructor(init?: { color?: ThemeColor }) {
		if (init) {
			this.color = init.color;
		}
	}
}

export enum DiagnosticSeverity {
	Error = 0,
	Warning = 1,
	Information = 2,
	Hint = 3,
}

export class Diagnostic {
	severity: DiagnosticSeverity;
	message: string;
	range: Range;
	source?: string;
	code?: string | number;

	constructor(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
		this.range = range;
		this.message = message;
		this.severity = severity;
	}
}

export class CompletionItem {
	label: string;
	kind?: CompletionItemKind;
	detail?: string;
	documentation?: string;
	insertText?: string;

	constructor(label: string, kind?: CompletionItemKind) {
		this.label = label;
		this.kind = kind;
	}
}

export enum CompletionItemKind {
	Text = 0,
	Method = 1,
	Function = 2,
	Constructor = 3,
	Field = 4,
	Variable = 5,
	Class = 6,
	Interface = 7,
	Module = 8,
	Property = 9,
	Unit = 10,
	Value = 11,
	Enum = 12,
	Keyword = 13,
	Snippet = 14,
	Color = 15,
	File = 16,
	Reference = 17,
	Folder = 18,
}

export class Hover {
	constructor(
		public contents: MarkdownString | string,
		public range?: Range,
	) {}
}

export class MarkdownString {
	value: string;
	isTrusted?: boolean;

	constructor(value = '') {
		this.value = value;
	}

	appendMarkdown(value: string): this {
		this.value += value;
		return this;
	}

	appendCodeblock(value: string, language?: string): this {
		this.value += `\`\`\`${language ?? ''}\n${value}\n\`\`\`\n`;
		return this;
	}
}

export enum ExtensionMode {
	Production = 1,
	Development = 2,
	Test = 3,
}

export class EventEmitter<T = void> {
	private listeners: Array<(e: T) => void> = [];
	fire = (arg: T): void => {
		for (const listener of this.listeners) {
			listener(arg);
		}
	};
	event = (listener: (e: T) => void): { dispose: () => void } => {
		this.listeners.push(listener);
		return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
	};
	dispose = vi.fn();
}

export const workspace = {
	openTextDocument: vi.fn(),
	createFileSystemWatcher: vi.fn(() => ({
		onDidChange: vi.fn(),
		onDidCreate: vi.fn(),
		onDidDelete: vi.fn(),
		dispose: vi.fn(),
	})),
	workspaceFolders: [] as WorkspaceFolder[],
	findFiles: vi.fn().mockResolvedValue([]),
	getConfiguration: vi.fn(() => ({
		get: vi.fn(),
		has: vi.fn(),
		update: vi.fn(),
	})),
	fs: {
		readFile: vi.fn(async (uri: Uri) => {
			const content = fs.readFileSync(uri.fsPath, 'utf-8');
			return new TextEncoder().encode(content);
		}),
		writeFile: vi.fn(),
		stat: vi.fn(),
	},
	onDidChangeTextDocument: vi.fn(),
	onDidSaveTextDocument: vi.fn(),
};

export const window = {
	createOutputChannel: vi.fn(() => ({
		appendLine: vi.fn(),
		append: vi.fn(),
		show: vi.fn(),
		dispose: vi.fn(),
		replace: vi.fn(),
	})),
	createLogOutputChannel: vi.fn(() => ({
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		show: vi.fn(),
		dispose: vi.fn(),
	})),
	showErrorMessage: vi.fn(),
	showWarningMessage: vi.fn(),
	showInformationMessage: vi.fn(),
	showQuickPick: vi.fn(),
	showInputBox: vi.fn(),
	activeTextEditor: undefined as TextEditor | undefined,
	onDidChangeActiveTextEditor: vi.fn(),
	createWebviewPanel: vi.fn(),
	registerWebviewViewProvider: vi.fn(),
	withProgress: vi.fn(),
};

export const commands = {
	registerCommand: vi.fn(),
	executeCommand: vi.fn(),
};

export const languages = {
	registerDefinitionProvider: vi.fn(),
	registerHoverProvider: vi.fn(),
	registerCompletionItemProvider: vi.fn(),
	registerReferenceProvider: vi.fn(),
	registerRenameProvider: vi.fn(),
	registerDocumentSymbolProvider: vi.fn(),
	registerCodeActionsProvider: vi.fn(),
	registerDocumentFormattingEditProvider: vi.fn(),
	createDiagnosticCollection: vi.fn(() => ({
		set: vi.fn(),
		delete: vi.fn(),
		clear: vi.fn(),
		dispose: vi.fn(),
	})),
	match: vi.fn(),
};

export const extensions = {
	getExtension: vi.fn(),
};

export const lm = {
	registerTool: vi.fn(),
	invokeTool: vi.fn(),
};

export enum ProgressLocation {
	SourceControl = 1,
	Window = 10,
	Notification = 15,
}

export enum ViewColumn {
	Active = -1,
	Beside = -2,
	One = 1,
	Two = 2,
	Three = 3,
}

export interface Command {
	title: string;
	command: string;
	arguments?: unknown[];
}

export interface WorkspaceFolder {
	uri: Uri;
	name: string;
	index: number;
}

export interface TextEditor {
	document: TextDocument;
	selection: Selection;
}

export interface TextDocument {
	uri: Uri;
	fileName: string;
	languageId: string;
	getText(range?: Range): string;
	lineAt(line: number): { text: string };
}

export class Selection extends Range {
	constructor(
		public readonly anchor: Position,
		public readonly active: Position,
	) {
		super(anchor, active);
	}
}

export const env = {
	openExternal: vi.fn(),
	clipboard: {
		writeText: vi.fn(),
		readText: vi.fn(),
	},
};

export class CancellationTokenSource {
	token = {
		isCancellationRequested: false,
		onCancellationRequested: vi.fn(),
	};
	cancel = vi.fn();
	dispose = vi.fn();
}
