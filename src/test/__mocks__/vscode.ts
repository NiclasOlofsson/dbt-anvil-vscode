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
	public readonly start: Position;
	public readonly end: Position;

	constructor(startOrStartLine: Position | number, endOrStartChar: Position | number, endLine?: number, endChar?: number) {
		if (typeof startOrStartLine === 'number') {
			this.start = new Position(startOrStartLine, endOrStartChar as number);
			this.end = new Position(endLine!, endChar!);
		} else {
			this.start = startOrStartLine;
			this.end = endOrStartChar as Position;
		}
	}

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
	public readonly range: Range;
	constructor(
		public readonly uri: Uri,
		rangeOrPosition: Range | Position,
	) {
		this.range = rangeOrPosition instanceof Position
			? new Range(rangeOrPosition, rangeOrPosition)
			: rangeOrPosition;
	}
}

export class TextEdit {
	constructor(
		public readonly range: Range,
		public readonly newText: string,
	) {}

	static replace(range: Range, newText: string): TextEdit {
		return new TextEdit(range, newText);
	}

	static insert(position: Position, newText: string): TextEdit {
		return new TextEdit(new Range(position, position), newText);
	}

	static delete(range: Range): TextEdit {
		return new TextEdit(range, '');
	}
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

export class RelativePattern {
	constructor(
		public readonly base: string,
		public readonly pattern: string,
	) {}
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

export enum StatusBarAlignment {
	Left = 1,
	Right = 2,
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
		get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue ?? true),
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
	applyEdit: vi.fn().mockResolvedValue(true),
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
	visibleTextEditors: [] as TextEditor[],
	onDidChangeActiveTextEditor: vi.fn(),
	createWebviewPanel: vi.fn(),
	registerWebviewViewProvider: vi.fn(),
	withProgress: vi.fn(),
	createStatusBarItem: vi.fn(() => ({
		text: '',
		tooltip: '',
		command: undefined as string | undefined,
		alignment: StatusBarAlignment.Left,
		priority: 0,
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
	})),
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
	registerCodeLensProvider: vi.fn(),
	registerWorkspaceSymbolProvider: vi.fn(),
	registerSignatureHelpProvider: vi.fn(),
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

export enum SymbolKind {
	File = 0,
	Module = 1,
	Namespace = 2,
	Package = 3,
	Class = 4,
	Method = 5,
	Property = 6,
	Field = 7,
	Constructor = 8,
	Enum = 9,
	Interface = 10,
	Function = 11,
	Variable = 12,
	Constant = 13,
	String = 14,
	Number = 15,
	Boolean = 16,
	Array = 17,
	Object = 18,
	Key = 19,
	Null = 20,
	EnumMember = 21,
	Struct = 22,
	Event = 23,
	Operator = 24,
	TypeParameter = 25,
}

export class DocumentSymbol {
	children: DocumentSymbol[] = [];
	constructor(
		public name: string,
		public detail: string,
		public kind: SymbolKind,
		public range: Range,
		public selectionRange: Range,
	) {}
}

export class SymbolInformation {
	constructor(
		public name: string,
		public kind: SymbolKind,
		public containerName: string,
		public location: Location,
	) {}
}

export class CodeLens {
	command?: Command;
	constructor(
		public range: Range,
		command?: Command,
	) {
		this.command = command;
	}
}

export class CodeActionKind {
	static readonly Empty = new CodeActionKind('');
	static readonly QuickFix = new CodeActionKind('quickfix');
	static readonly Refactor = new CodeActionKind('refactor');
	static readonly RefactorExtract = new CodeActionKind('refactor.extract');
	static readonly RefactorInline = new CodeActionKind('refactor.inline');
	static readonly RefactorRewrite = new CodeActionKind('refactor.rewrite');
	static readonly Source = new CodeActionKind('source');
	static readonly SourceOrganizeImports = new CodeActionKind('source.organizeImports');
	static readonly SourceFixAll = new CodeActionKind('source.fixAll');

	constructor(public readonly value: string) {}

	append(part: string): CodeActionKind {
		return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
	}
}

export class CodeAction {
	command?: Command;
	isPreferred?: boolean;
	constructor(
		public title: string,
		public kind?: CodeActionKind,
	) {}
}

export class WorkspaceEdit {
	private _edits: Array<{ uri: Uri; range: Range; newText: string }> = [];
	private _fileOps: Array<{ type: string; oldUri?: Uri; newUri?: Uri }> = [];

	replace(uri: Uri, range: Range, newText: string): void {
		this._edits.push({ uri, range, newText });
	}

	renameFile(oldUri: Uri, newUri: Uri): void {
		this._fileOps.push({ type: 'rename', oldUri, newUri });
	}

	entries(): Array<[Uri, Array<{ range: Range; newText: string }>]> {
		const map = new Map<string, { uri: Uri; edits: Array<{ range: Range; newText: string }> }>();
		for (const edit of this._edits) {
			const key = edit.uri.toString();
			if (!map.has(key)) map.set(key, { uri: edit.uri, edits: [] });
			map.get(key)!.edits.push({ range: edit.range, newText: edit.newText });
		}
		return [...map.values()].map(v => [v.uri, v.edits]);
	}
}

export class SignatureInformation {
	parameters: ParameterInformation[] = [];
	constructor(
		public label: string,
		public documentation?: string,
	) {}
}

export class ParameterInformation {
	constructor(
		public label: string,
		public documentation?: string,
	) {}
}

export class SignatureHelp {
	signatures: SignatureInformation[] = [];
	activeSignature = 0;
	activeParameter = 0;
}

export class SnippetString {
	constructor(public value: string) {}
}

export class CallHierarchyItem {
	detail: string = '';
	uri: Uri;
	range: Range;
	selectionRange: Range;
	constructor(
		public kind: SymbolKind,
		public name: string,
		detail: string,
		uri: Uri,
		range: Range,
		selectionRange: Range,
	) {
		this.detail = detail;
		this.uri = uri;
		this.range = range;
		this.selectionRange = selectionRange;
	}
}

export class CallHierarchyIncomingCall {
	constructor(
		public from: CallHierarchyItem,
		public fromRanges: Range[],
	) {}
}

export class CallHierarchyOutgoingCall {
	constructor(
		public to: CallHierarchyItem,
		public fromRanges: Range[],
	) {}
}

// Shared emitter so tests can fire onDidTerminateDebugSession events.
export const _debugTerminateEmitter = new EventEmitter<{ type: string; name: string }>();

export const debug = {
	onDidTerminateDebugSession: _debugTerminateEmitter.event,
};
