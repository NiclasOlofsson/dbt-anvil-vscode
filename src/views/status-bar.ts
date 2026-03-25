import * as vscode from 'vscode';
import type { DbtExecutionService, DbtJobInfo } from '../dbt/execution-service';
import type { ILogger } from '../types/logger';

export class StatusBarManager implements vscode.Disposable {
	private readonly _item: vscode.StatusBarItem;
	private readonly _disposables: vscode.Disposable[] = [];
	private _activeJob: DbtJobInfo | null = null;
	private _queueSize = 0;
	private _errorCount = 0;

	constructor(
		service: DbtExecutionService,
		private readonly logger: ILogger,
	) {
		this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this._item.name = 'dbt Studio';

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

	setErrorCount(count: number): void {
		this._errorCount = count;
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

		if (this._errorCount > 0) {
			this._item.text = `$(error) dbt: ${this._errorCount} error${this._errorCount !== 1 ? 's' : ''}`;
			this._item.tooltip = 'Click to show dbt errors';
			this._item.command = 'workbench.action.showErrorsWarnings';
			return;
		}

		this._item.text = '$(check) dbt: Ready';
		this._item.tooltip = 'dbt Studio — ready';
		this._item.command = undefined;
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
