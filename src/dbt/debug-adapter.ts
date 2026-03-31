import * as vscode from 'vscode';
import type { QueryRunner } from './query-runner';
import type { DbtPathResolver } from './dbt-path-resolver';
import type { ILogger } from '../types/logger';
import { splitStatements, findStatementAtOffset } from './statement-splitter';

interface DapMessage {
	seq: number;
	type: string;
	command?: string;
	arguments?: Record<string, unknown>;
	request_seq?: number;
}

/**
 * Minimal inline DAP adapter that runs ad-hoc SQL queries via QueryRunner.
 *
 * No breakpoints, no stepping — just launch → execute → terminate.
 * Wired into VS Code via DebugAdapterInlineImplementation so F5 runs SQL.
 */
export class SqlDebugAdapter implements vscode.DebugAdapter {
	private _seq = 1;
	private _threadName = 'SQL';
	private readonly _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage = this._onDidSendMessage.event;

	constructor(
		private readonly _queryRunner: QueryRunner,
		private readonly _pathResolver: DbtPathResolver,
		private readonly _logger: ILogger,
	) {}

	handleMessage(message: vscode.DebugProtocolMessage): void {
		const msg = message as unknown as DapMessage;
		switch (msg.command) {
			case 'initialize':
				this._send({
					type: 'response',
					command: 'initialize',
					request_seq: msg.seq,
					success: true,
					body: {
						supportsConfigurationDoneRequest: true,
						supportsCancelRequest: false,
						supportsTerminateRequest: true,
						supportsBreakpointLocationsRequest: false,
					},
				});
				this._send({ type: 'event', event: 'initialized' });
				break;

			case 'configurationDone':
				this._send({ type: 'response', command: 'configurationDone', request_seq: msg.seq, success: true });
				break;

			case 'launch':
				this._send({ type: 'response', command: 'launch', request_seq: msg.seq, success: true });
				void this._executeLaunch(msg.arguments ?? {});
				break;

			case 'disconnect':
			case 'terminate':
				this._queryRunner.cancel();
				this._send({ type: 'response', command: msg.command, request_seq: msg.seq, success: true });
				break;

			case 'threads':
				this._send({
					type: 'response',
					command: 'threads',
					request_seq: msg.seq,
					success: true,
					body: { threads: [{ id: 1, name: 'SQL' }] },
				});
				break;

			default:
				this._send({
					type: 'response',
					command: msg.command ?? 'unknown',
					request_seq: msg.seq,
					success: false,
					message: `Unsupported request: ${msg.command}`,
				});
		}
	}

	private async _executeLaunch(args: Record<string, unknown>): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'jinja-sql') {
			this._output('No active dbt SQL file.\n');
			this._terminate();
			return;
		}

		const category = this._pathResolver.classifyFile(editor.document.fileName);
		if (category === 'model' || category === 'snapshot' || category === 'seed') {
			this._output('Use the Run / Compile CodeLens to execute model files.\n');
			this._terminate();
			return;
		}

		const defaultLimit = vscode.workspace.getConfiguration('dbt-studio').get<number>('queryEditor.defaultLimit', 500);
		const limit = typeof args.limit === 'number' ? args.limit : defaultLimit;
		const scope = args.scope === 'all' ? 'all' as const : 'cursor' as const;
		const resultLocation = typeof args.resultLocation === 'string' ? args.resultLocation : undefined;

		const fileName = editor.document.fileName.split(/[\\/]/).pop() ?? 'query';
		if (scope === 'all') {
			this._threadName = `${fileName} — all statements`;
		} else {
			const fullText = editor.document.getText();
			const offset = editor.document.offsetAt(editor.selection.active);
			const stmts = splitStatements(fullText);
			const stmt = !editor.selection.isEmpty
				? { sql: editor.document.getText(editor.selection) }
				: findStatementAtOffset(stmts, offset);
			const preview = stmt?.sql.replace(/\s+/g, ' ').trim().slice(0, 80) ?? fileName;
			this._threadName = preview.length < (stmt?.sql.replace(/\s+/g, ' ').trim().length ?? 0) ? `${preview}…` : preview;
		}

		this._logger.info(`Debug adapter: launching (scope=${scope}, limit=${limit})`);
		this._send({ type: 'event', event: 'thread', body: { threadId: 1, reason: 'started' } });

		try {
			await this._queryRunner.executeWithConfig(editor, { limit, scope, resultLocation });
		} catch (err) {
			this._output(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
		}

		this._terminate();
	}

	private _output(text: string): void {
		this._send({ type: 'event', event: 'output', body: { category: 'console', output: text } });
	}

	private _terminate(): void {
		this._send({ type: 'event', event: 'terminated' });
	}

	private _send(msg: Record<string, unknown>): void {
		msg.seq = this._seq++;
		this._onDidSendMessage.fire(msg as unknown as vscode.DebugProtocolMessage);
	}

	dispose(): void {
		this._onDidSendMessage.dispose();
	}
}
