import * as vscode from 'vscode';
import { EditorModel } from './editor-model';
import { renderEditor } from './editor-html';
import { getAllRuleMetadata } from '../engine';
import { inspectRuleSeverities, saveRuleSeverity, removeRuleSeverity } from '../config-loader';
import { DEFAULT_CONFIG } from '../config';
import type { WorkspaceDiagnosticsScanner } from '../workspace-diagnostics-scanner';
import type { InboundMessage, ConfigScope } from './editor-types';
import type { NinjaSeverity } from '../rule';
import type { NinjaCategory } from '../categories';

export class NinjaEditorPanel implements vscode.Disposable {
	static readonly viewType = 'dbt-studio.ninjaRuleEditor';
	private static _instance: NinjaEditorPanel | undefined;

	private _panel: vscode.WebviewPanel | undefined;
	private readonly _model: EditorModel;
	private readonly _disposables: vscode.Disposable[] = [];
	private _scanner: WorkspaceDiagnosticsScanner | undefined;
	private _lastRuleCounts: Map<string, number> | undefined;
	private _lastBaselineCounts: Map<string, number> | undefined;

	private constructor() {
		this._model = new EditorModel(getAllRuleMetadata());
		this._model.applyInspectedConfig(inspectRuleSeverities());
	}

	static getInstance(): NinjaEditorPanel {
		if (!NinjaEditorPanel._instance) {
			NinjaEditorPanel._instance = new NinjaEditorPanel();
		}
		return NinjaEditorPanel._instance;
	}

	setScanner(scanner: WorkspaceDiagnosticsScanner | undefined): void {
		this._scanner = scanner;
		if (scanner) {
			this._disposables.push(
				scanner.onDidComplete(summary => {
					this._lastRuleCounts = summary.ruleCounts;
					this._model.applyConfiguredCounts(summary.ruleCounts);
					this._pushSnapshot();
				}),
			);
		}
	}

	async open(): Promise<void> {
		if (this._panel) {
			this._panel.reveal();
			return;
		}

		this._panel = vscode.window.createWebviewPanel(
			NinjaEditorPanel.viewType,
			'Ninja Rule Editor',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		this._panel.onDidDispose(() => {
			this._panel = undefined;
		}, null, this._disposables);

		this._panel.webview.onDidReceiveMessage(
			(msg: InboundMessage) => this._handleMessage(msg),
			null,
			this._disposables,
		);

		// Apply the last completed scan immediately — no new scan triggered on open.
		if (this._lastRuleCounts) {
			this._model.applyConfiguredCounts(this._lastRuleCounts);
		}
		if (this._lastBaselineCounts) {
			this._model.applyBaselineCounts(this._lastBaselineCounts);
		}
		this._pushSnapshot();
	}

	dispose(): void {
		this._panel?.dispose();
		for (const d of this._disposables) d.dispose();
		this._disposables.length = 0;
		NinjaEditorPanel._instance = undefined;
	}

	// ── Message handling ──────────────────────────────────────

	private _handleMessage(msg: InboundMessage): void {
		switch (msg.type) {
			case 'switchScope':
				this._model.switchScope(msg.scope as ConfigScope);
				this._pushSnapshot();
				break;
			case 'setSeverity':
				this._model.setSeverity(msg.ruleId, msg.severity as NinjaSeverity);
				void this._persistAndRefresh(msg.ruleId, msg.severity as NinjaSeverity);
				break;
			case 'resetRule':
				this._model.resetRule(msg.ruleId);
				void this._persistReset(msg.ruleId);
				break;
			case 'resetAll':
				this._model.resetAll();
				this._pushSnapshot();
				break;
			case 'scan':
				void this._scanner?.scanAll();
				void this._scanner?.scan({ ...DEFAULT_CONFIG, enabled: true, rules: {} }).then(counts => {
					this._lastBaselineCounts = counts;
					this._model.applyBaselineCounts(counts);
					this._pushSnapshot();
				});
				break;
			case 'setCategory':
				this._model.setCategory(msg.category as NinjaCategory | 'all');
				this._pushSnapshot();
				break;
			case 'setSearch':
				this._model.setSearch(msg.query);
				this._pushSnapshot();
				break;
		}
	}

	// ── Persistence ───────────────────────────────────────────

	private async _persistAndRefresh(ruleId: string, severity: NinjaSeverity): Promise<void> {
		await saveRuleSeverity(ruleId, severity, this._model.activeScope);
		this._model.applyInspectedConfig(inspectRuleSeverities());
		this._pushSnapshot();
	}

	private async _persistReset(ruleId: string): Promise<void> {
		await removeRuleSeverity(ruleId, this._model.activeScope);
		this._model.applyInspectedConfig(inspectRuleSeverities());
		this._pushSnapshot();
	}

	// ── Render ────────────────────────────────────────────────

	private _pushSnapshot(): void {
		if (!this._panel) return;
		const nonce = getNonce();
		this._panel.webview.html = renderEditor(this._model.snapshot(), nonce);
	}
}

function getNonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
