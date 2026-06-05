import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { DbtExecutionService } from './execution-service';
import { Priority } from './execution-service';
import type { IManifestSuppressor } from '../indexing/manifest-watcher';

/** Matches DB-writing dbt commands: run, build, seed, snapshot, clone, run-operation. */
const DB_WRITE_PATTERN = /\bdbt\b\s+(?:\S+\s+)*(?:run|build|seed|snapshot|clone|run-operation)\b/;

/** How many times we show a modal dialog before switching to non-modal. */
const MODAL_THRESHOLD = 2;

/** Minimum ms between handling the same terminal+command pair (deduplication). */
const INTERRUPT_COOLDOWN_MS = 3000;

interface InterruptEvent {
	timestamp: string;
	terminalName: string;
	command: string;
	action: 'interrupt' | 'yield';
	reason: string;
}

export class ExternalDbtMonitor implements vscode.Disposable {
	private readonly _trackedExecutions = new Set<vscode.TerminalShellExecution>();
	private readonly _recentlyHandled = new Map<string, number>();
	private readonly _subscriptions: vscode.Disposable[] = [];
	private _statusBarItem: vscode.StatusBarItem | null = null;

	constructor(
		private readonly projectDir: string,
		private readonly executionService: DbtExecutionService,
		private readonly watcher: IManifestSuppressor,
		private readonly logger: ILogger,
		private readonly context: vscode.ExtensionContext,
	) {}

	start(): void {
		this._subscriptions.push(
			vscode.window.onDidStartTerminalShellExecution(event => this._onStart(event)),
			vscode.window.onDidEndTerminalShellExecution(event => this._onEnd(event)),
		);
		this.logger.info('ExternalDbtMonitor: started');
	}

	private _isDbWriteCommand(command: string): boolean {
		return DB_WRITE_PATTERN.test(command);
	}

	private _isCwdInsideProject(cwd: vscode.Uri | undefined): boolean {
		if (!cwd) return false;
		const cwdPath = cwd.fsPath.replace(/\\/g, '/');
		const projectPath = this.projectDir.replace(/\\/g, '/');
		return cwdPath === projectPath || cwdPath.startsWith(projectPath + '/');
	}

	private _dedupeKey(terminalName: string, command: string): string {
		return `${terminalName}::${command}`;
	}

	private _onStart(event: vscode.TerminalShellExecutionStartEvent): void {
		const commandLine = event.execution.commandLine.value;

		if (!this._isDbWriteCommand(commandLine)) return;
		if (!this._isCwdInsideProject(event.execution.cwd)) return;

		const key = this._dedupeKey(event.terminal.name, commandLine);
		const lastHandled = this._recentlyHandled.get(key);
		if (lastHandled && Date.now() - lastHandled < INTERRUPT_COOLDOWN_MS) {
			this.logger.debug(`ExternalDbtMonitor: skipping duplicate event for "${key}"`);
			return;
		}
		this._recentlyHandled.set(key, Date.now());

		// Prune stale cooldown entries
		for (const [k, t] of this._recentlyHandled) {
			if (Date.now() - t > INTERRUPT_COOLDOWN_MS * 2) this._recentlyHandled.delete(k);
		}

		if (this.executionService.activeJobPriority === Priority.User) {
			this._handleInterrupt(event, commandLine);
		} else {
			this._handleYield(event, commandLine);
		}
	}

	private _handleInterrupt(event: vscode.TerminalShellExecutionStartEvent, commandLine: string): void {
		this.logger.warn(`ExternalDbtMonitor: interrupting terminal "${event.terminal.name}" — "${commandLine}" conflicts with active user job`);
		event.terminal.sendText('\x03', false);
		setTimeout(() => event.terminal.sendText('\x03', false), 200);
		this._trackEvent(event.terminal.name, commandLine, 'interrupt', 'dbt Anvil user job is active');
		this._showInterruptNotification(event.terminal.name);
		this.logger.info(`[ExternalDbtMonitor] INTERRUPT: terminal="${event.terminal.name}" command="${commandLine}"`);
	}

	private _handleYield(event: vscode.TerminalShellExecutionStartEvent, commandLine: string): void {
		this.logger.info(`ExternalDbtMonitor: yielding to terminal "${event.terminal.name}" — "${commandLine}"`);
		this.watcher.suppress();
		this.executionService.suspend();
		this._trackedExecutions.add(event.execution);
		this._showStatusBar();
		this._trackEvent(event.terminal.name, commandLine, 'yield', 'no conflicting extension job');
		this.logger.info(`[ExternalDbtMonitor] YIELD: terminal="${event.terminal.name}" command="${commandLine}"`);
	}

	private _onEnd(event: vscode.TerminalShellExecutionEndEvent): void {
		if (!this._trackedExecutions.has(event.execution)) return;
		this._trackedExecutions.delete(event.execution);

		this.executionService.resume();
		this.watcher.resume();
		this.watcher.triggerRebuild();

		if (this._trackedExecutions.size === 0) {
			this._hideStatusBar();
		}

		this.logger.info(`ExternalDbtMonitor: terminal dbt command ended in "${event.terminal.name}" — resumed extension and triggered manifest rebuild`);
	}

	private _showInterruptNotification(terminalName: string): void {
		const modalShownCount = this.context.workspaceState.get<number>('dbtAnvil.interrupt.modalShownCount', 0);
		const message = `dbt Anvil stopped a "${terminalName}" terminal command because a user-initiated dbt operation is already running.`;
		if (modalShownCount < MODAL_THRESHOLD) {
			void vscode.window.showWarningMessage(message, { modal: true }, 'OK');
			void this.context.workspaceState.update('dbtAnvil.interrupt.modalShownCount', modalShownCount + 1);
		} else {
			void vscode.window.showWarningMessage(message);
		}
	}

	private _trackEvent(terminalName: string, command: string, action: 'interrupt' | 'yield', reason: string): void {
		const count = this.context.workspaceState.get<number>('dbtAnvil.interrupt.count', 0);
		void this.context.workspaceState.update('dbtAnvil.interrupt.count', count + 1);
		void this.context.workspaceState.update('dbtAnvil.interrupt.lastAt', new Date().toISOString());
		const history = this.context.workspaceState.get<InterruptEvent[]>('dbtAnvil.interrupt.history', []);
		history.push({ timestamp: new Date().toISOString(), terminalName, command, action, reason });
		if (history.length > 20) history.splice(0, history.length - 20);
		void this.context.workspaceState.update('dbtAnvil.interrupt.history', history);
	}

	private _showStatusBar(): void {
		if (!this._statusBarItem) {
			this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		}
		this._statusBarItem.text = '$(loading~spin) dbt running in terminal';
		this._statusBarItem.tooltip = 'dbt Anvil is waiting for the terminal dbt command to finish before resuming queued operations.';
		this._statusBarItem.show();
	}

	private _hideStatusBar(): void {
		this._statusBarItem?.hide();
	}

	dispose(): void {
		for (const sub of this._subscriptions) sub.dispose();
		this._statusBarItem?.dispose();
		this._statusBarItem = null;
		this._trackedExecutions.clear();
	}
}
