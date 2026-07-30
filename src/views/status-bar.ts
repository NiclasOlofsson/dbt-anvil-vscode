import * as vscode from 'vscode';
import type { DbtExecutionService, DbtJobInfo } from '../dbt/execution-service';
import type { ILogger } from '../types/logger';

export class StatusBarManager implements vscode.Disposable {
	private readonly _item: vscode.StatusBarItem;
	private readonly _disposables: vscode.Disposable[] = [];
	private _activeJob: DbtJobInfo | null = null;
	private _queueSize = 0;
	private _ready = false;
	private _errorMessage: string | null = null;
	private _unavailable: { label: string; reason: string } | null = null;

	constructor(
		service: DbtExecutionService,
		private readonly logger: ILogger,
	) {
		this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this._item.name = 'dbt Anvil';

		this._disposables.push(
			service.onJobStarted(job => {
				this._activeJob = job;
				this._update();
			}),
			service.onJobCompleted(() => {
				this._activeJob = null;
				this._update();
			}),
			service.onJobFailed(() => {
				this._activeJob = null;
				this._update();
			}),
			service.onQueueChanged(size => {
				this._queueSize = size;
				this._update();
			}),
		);

		this._update();
		this._item.show();
	}

	setReady(): void {
		this._ready = true;
		this._update();
	}

	setError(message: string): void {
		this._errorMessage = message;
		this._update();
	}

	/**
	 * dbt Anvil cannot work on this workspace at all, for a reason the user
	 * resolves by changing what is open rather than by fixing their setup.
	 *
	 * Distinct from setError, whose "Setup Required" tells the user their Python
	 * or dbt install needs attention. Both exist so that activation never leaves
	 * the spinner running: it readies, it errors, or it says it is unavailable.
	 */
	setUnavailable(label: string, reason: string): void {
		this._unavailable = { label, reason };
		this._update();
	}

	private _update(): void {
		if (this._activeJob) {
			const origin = this._activeJob.origin === 'copilot' ? ' (Copilot)' : '';
			const queue = this._queueSize > 0 ? ` (+${this._queueSize} queued)` : '';
			this._item.text = `$(sync~spin) dbt: ${this._activeJob.label}${origin}${queue}`;
			this._item.tooltip = this._buildTooltip();
			this._item.command = undefined;
			return;
		}

		if (this._errorMessage) {
			this._item.text = '$(error) dbt: Setup Required';
			this._item.tooltip = this._errorMessage;
			this._item.command = 'dbt-anvil.statusBarMenu';
			return;
		}

		if (this._unavailable) {
			this._item.text = `$(warning) dbt: ${this._unavailable.label}`;
			this._item.tooltip = this._unavailable.reason;
			this._item.command = 'dbt-anvil.statusBarMenu';
			return;
		}

		if (!this._ready) {
			this._item.text = '$(sync~spin) dbt: Initializing';
			this._item.tooltip = 'dbt Anvil — loading manifest';
			this._item.command = undefined;
			return;
		}

		this._item.text = '$(check) dbt: Ready';
		this._item.tooltip = 'dbt Anvil — click for options';
		this._item.command = 'dbt-anvil.statusBarMenu';
	}

	private _buildTooltip(): string {
		const lines = [`Running: ${this._activeJob?.label ?? 'unknown'}`];
		if (this._queueSize > 0) {
			lines.push(`Queued: ${this._queueSize} job${this._queueSize !== 1 ? 's' : ''}`);
		}
		return lines.join('\n');
	}

	dispose(): void {
		for (const d of this._disposables) d.dispose();
		this._item.dispose();
	}
}
