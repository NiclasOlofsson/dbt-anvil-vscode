import * as vscode from 'vscode';

export enum LogLevel {
	TRACE = 0,
	DEBUG = 1,
	INFO = 2,
	WARN = 3,
	ERROR = 4,
}

export interface ILogger {
	trace(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	setLogLevel(level: LogLevel): void;
	getLogLevel(): LogLevel;
}

export class VSCodeLogger implements ILogger {
	constructor(
		private readonly outputChannel: vscode.LogOutputChannel,
		private readonly _extensionMode: vscode.ExtensionMode = vscode.ExtensionMode.Production,
	) {}

	setLogLevel(_level: LogLevel): void {
		// VS Code LogOutputChannel manages log levels natively
	}

	getLogLevel(): LogLevel {
		return LogLevel.INFO;
	}

	private format(message: string, ...args: unknown[]): string {
		if (args.length === 0) return message;
		return `${message} ${args.map(a => JSON.stringify(a)).join(' ')}`;
	}

	trace(message: string, ...args: unknown[]): void {
		this.outputChannel.trace(this.format(message, ...args));
	}

	debug(message: string, ...args: unknown[]): void {
		this.outputChannel.debug(this.format(message, ...args));
	}

	info(message: string, ...args: unknown[]): void {
		this.outputChannel.info(this.format(message, ...args));
	}

	warn(message: string, ...args: unknown[]): void {
		this.outputChannel.warn(this.format(message, ...args));
	}

	error(message: string, ...args: unknown[]): void {
		this.outputChannel.error(this.format(message, ...args));
	}
}
