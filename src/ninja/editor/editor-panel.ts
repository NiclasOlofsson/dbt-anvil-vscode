import * as vscode from 'vscode';
import { EditorModel } from './editor-model';
import { renderEditor } from './editor-html';
import { getAllRuleMetadata } from '../engine';
import { inspectRuleSeverities, saveRuleSeverity, removeRuleSeverity, inspectAutoFixRules, saveAutoFixRule, removeAutoFixRule, saveConfigOption, inspectConfigOptions, removeConfigOption, getOverriddenOptionPaths, inspectDisabledRules, disableRule, enableRule } from '../config-loader';
import type { WorkspaceDiagnosticsScanner } from '../diagnostics/scanner';
import type { InboundMessage, ConfigScope, RuleOptionValue } from './editor-types';
import type { NinjaSeverity } from '../rule';
import type { NinjaCategory } from '../categories';

export class NinjaEditorPanel implements vscode.Disposable {
	static readonly viewType = 'dbt-studio.ninjaRuleEditor';
	private static _instance: NinjaEditorPanel | undefined;
	private static readonly DEFER_SAVE_MS = 5000;

	private _panel: vscode.WebviewPanel | undefined;
	private readonly _model: EditorModel;
	private readonly _disposables: vscode.Disposable[] = [];
	private _scanner: WorkspaceDiagnosticsScanner | undefined;
	private _lastRuleCounts: Map<string, number> | undefined;
	private _writingConfig = false;
	private _saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _flushingDeferredWrites = false;
	private readonly _pendingSeverityWrites = new Map<string, { scope: ConfigScope; ruleId: string; severity: NinjaSeverity }>();
	private readonly _pendingAutoFixWrites = new Map<string, { scope: ConfigScope; ruleId: string; enabled: boolean }>();
	private readonly _pendingOptionWrites = new Map<string, { scope: ConfigScope; settingPath: string; value: RuleOptionValue }>();

	private constructor() {
		this._model = new EditorModel(getAllRuleMetadata());
		this._model.applyInspectedConfig(inspectRuleSeverities());
		this._model.applyAutoFixConfig(inspectAutoFixRules());
		this._model.applyDisabledRules(this._mergedDisabledRules());
		this._model.applyOptionValues(inspectConfigOptions(this._allOptionPaths()));
		this._model.applyOptionOverrides(getOverriddenOptionPaths(this._allOptionPaths(), this._model.activeScope));
		// Refresh view when the user edits settings.json directly
		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (this._writingConfig) return;
				if (e.affectsConfiguration('dbt-studio.ninja')) {
					this._model.applyInspectedConfig(inspectRuleSeverities());
					this._model.applyAutoFixConfig(inspectAutoFixRules());
					this._model.applyDisabledRules(this._mergedDisabledRules());
					this._model.applyOptionValues(inspectConfigOptions(this._allOptionPaths()));
					this._model.applyOptionOverrides(getOverriddenOptionPaths(this._allOptionPaths(), this._model.activeScope));
					this._pushSnapshot();
				}
			}),
		);
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
			this._model.setScanning(scanner.isScanning);
			// Apply any counts the scanner already has (from a scan before the panel was opened)
			const existing = scanner.currentRuleCounts;
			if (existing.size > 0) {
				this._lastRuleCounts = existing;
				this._model.applyViolationCounts(existing);
			}
			this._disposables.push(
				scanner.onDidCountsChange(ruleCounts => {
					this._lastRuleCounts = ruleCounts;
					this._model.applyViolationCounts(ruleCounts);
					this._pushSnapshot();
				}),
				scanner.onDidScanningChange(scanning => {
					this._model.setScanning(scanning);
					this._pushSnapshot();
				}),
				scanner.onDidComplete(summary => {
					this._lastRuleCounts = summary.ruleCounts;
					this._model.applyViolationCounts(summary.ruleCounts);
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

		// Apply the last completed scan immediately.
		if (this._lastRuleCounts) {
			this._model.applyViolationCounts(this._lastRuleCounts);
		}
		this._pushSnapshot();

		// If no counts are available yet, kick off a scan so the editor populates.
		if (!this._lastRuleCounts || this._lastRuleCounts.size === 0) {
			void this._scanner?.scanAll();
		}
	}

	dispose(): void {
		if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
		void this._flushDeferredWrites();
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
				this._model.applyOptionOverrides(getOverriddenOptionPaths(this._allOptionPaths(), this._model.activeScope));
				this._pushSnapshot();
				break;
			case 'setSeverity':
				this._model.setSeverity(msg.ruleId, msg.severity as NinjaSeverity);
				this._queueSeveritySave(msg.ruleId, msg.severity as NinjaSeverity);
				this._pushSnapshot();
				break;
			case 'resetRule':
				this._model.resetRule(msg.ruleId);
				this._dropPendingRuleWrites(msg.ruleId, this._model.activeScope);
				void this._persistReset(msg.ruleId);
				break;
			case 'resetAll':
				this._model.resetAll();
				this._pushSnapshot();
				break;
			case 'scan':
				void this._scanner?.scanAll();
				break;
			case 'setCategory':
				this._model.setCategory(msg.category as NinjaCategory | 'all');
				this._pushSnapshot();
				break;
			case 'setSearch':
				this._model.setSearch(msg.query);
				this._pushSnapshot();
				break;
			case 'setAutoFix':
				this._model.setAutoFix(msg.ruleId, msg.enabled);
				this._queueAutoFixSave(msg.ruleId, msg.enabled);
				this._pushSnapshot();
				break;
			case 'setSort':
				this._model.setSort(msg.column, msg.dir);
				this._pushSnapshot();
				break;
			case 'setRuleOption':
				this._model.applyOptionValues({ [msg.settingPath]: msg.value });
				this._queueOptionSave(msg.settingPath, msg.value);
				this._pushSnapshot();
				break;
			case 'setDisabled':
				this._model.setDisabled(msg.ruleId, msg.disabled);
				void this._persistDisabled(msg.ruleId, msg.disabled);
				this._pushSnapshot();
				break;
		}
	}

	// ── Persistence ───────────────────────────────────────────

	private _queueSeveritySave(ruleId: string, severity: NinjaSeverity): void {
		const scope = this._model.activeScope;
		this._pendingSeverityWrites.set(`${scope}:${ruleId}`, { scope, ruleId, severity });
		this._scheduleDeferredSave();
	}

	private _queueAutoFixSave(ruleId: string, enabled: boolean): void {
		const scope = this._model.activeScope;
		this._pendingAutoFixWrites.set(`${scope}:${ruleId}`, { scope, ruleId, enabled });
		this._scheduleDeferredSave();
	}

	private _queueOptionSave(settingPath: string, value: RuleOptionValue): void {
		const scope = this._model.activeScope;
		this._pendingOptionWrites.set(`${scope}:${settingPath}`, { scope, settingPath, value });
		this._scheduleDeferredSave();
	}

	private _scheduleDeferredSave(): void {
		if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
		this._saveDebounceTimer = setTimeout(() => {
			this._saveDebounceTimer = undefined;
			void this._flushDeferredWrites();
		}, NinjaEditorPanel.DEFER_SAVE_MS);
	}

	private _hasPendingWrites(): boolean {
		return this._pendingSeverityWrites.size > 0
			|| this._pendingAutoFixWrites.size > 0
			|| this._pendingOptionWrites.size > 0;
	}

	private async _flushDeferredWrites(): Promise<void> {
		if (this._flushingDeferredWrites) return;
		this._flushingDeferredWrites = true;
		try {
			while (this._hasPendingWrites()) {
				const severityWrites = [...this._pendingSeverityWrites.values()];
				const autoFixWrites = [...this._pendingAutoFixWrites.values()];
				const optionWrites = [...this._pendingOptionWrites.values()];
				this._pendingSeverityWrites.clear();
				this._pendingAutoFixWrites.clear();
				this._pendingOptionWrites.clear();

				this._writingConfig = true;
				try {
					// Severity and autoFix writes each read-modify-write the whole map,
					// so they must be serialised within their own group; options target
					// distinct setting paths and are safe to parallelise. The three
					// groups are independent and can run concurrently.
					await Promise.all([
						(async () => {
							for (const write of severityWrites) {
								await saveRuleSeverity(write.ruleId, write.severity, write.scope);
							}
						})(),
						(async () => {
							for (const write of autoFixWrites) {
								await saveAutoFixRule(write.ruleId, write.enabled, write.scope);
							}
						})(),
						Promise.all(optionWrites.map(w => saveConfigOption(w.settingPath, w.value, w.scope))),
					]);
				} finally {
					this._writingConfig = false;
				}
			}

			this._model.applyInspectedConfig(inspectRuleSeverities());
			this._model.applyAutoFixConfig(inspectAutoFixRules());
			this._model.applyDisabledRules(this._mergedDisabledRules());
			this._model.applyOptionValues(inspectConfigOptions(this._allOptionPaths()));
			this._model.applyOptionOverrides(getOverriddenOptionPaths(this._allOptionPaths(), this._model.activeScope));
			this._pushSnapshot();
		} finally {
			this._flushingDeferredWrites = false;
		}
	}

	private _dropPendingRuleWrites(ruleId: string, scope: ConfigScope): void {
		this._pendingSeverityWrites.delete(`${scope}:${ruleId}`);
		this._pendingAutoFixWrites.delete(`${scope}:${ruleId}`);
		const rule = getAllRuleMetadata().find(r => r.id === ruleId);
		for (const opt of rule?.configOptions ?? []) {
			this._pendingOptionWrites.delete(`${scope}:${opt.settingPath}`);
		}
	}

	private async _persistDisabled(ruleId: string, disabled: boolean): Promise<void> {
		this._writingConfig = true;
		try {
			if (disabled) await disableRule(ruleId, this._model.activeScope);
			else await enableRule(ruleId, this._model.activeScope);
		} finally {
			this._writingConfig = false;
		}
		this._model.applyDisabledRules(this._mergedDisabledRules());
		this._pushSnapshot();
	}

	private async _persistReset(ruleId: string): Promise<void> {
		this._writingConfig = true;
		try {
			await removeRuleSeverity(ruleId, this._model.activeScope);
			await removeAutoFixRule(ruleId, this._model.activeScope);
			const rule = getAllRuleMetadata().find(r => r.id === ruleId);
			for (const opt of rule?.configOptions ?? []) {
				await removeConfigOption(opt.settingPath, this._model.activeScope);
			}
		} finally {
			this._writingConfig = false;
		}
		this._model.applyInspectedConfig(inspectRuleSeverities());
		this._model.applyAutoFixConfig(inspectAutoFixRules());
		this._model.applyDisabledRules(this._mergedDisabledRules());
		this._model.applyOptionValues(inspectConfigOptions(this._allOptionPaths()));
		this._model.applyOptionOverrides(getOverriddenOptionPaths(this._allOptionPaths(), this._model.activeScope));
		this._pushSnapshot();
	}

	// ── Render ────────────────────────────────────────────────

	private _mergedDisabledRules(): string[] {
		const { user, workspace } = inspectDisabledRules();
		return [...new Set([...user, ...workspace])];
	}

	private _allOptionPaths(): string[] {
		const paths = new Set<string>();
		for (const rule of getAllRuleMetadata()) {
			for (const opt of rule.configOptions ?? []) {
				paths.add(opt.settingPath);
			}
		}
		return [...paths];
	}

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
