import * as vscode from 'vscode';
import { EditorModel } from './editor-model';
import { renderEditor } from './editor-html';
import { getAllRuleMetadata } from '../engine';
import { inspectRuleSeverities, saveRuleSeverity, removeRuleSeverity, inspectAutoFixRules, saveAutoFixRule, removeAutoFixRule, saveConfigOption, inspectConfigOptions, removeConfigOption, getOverriddenOptionPaths, inspectDisabledRules, disableRule, enableRule, inspectFormatPreset, saveFormatPreset } from '../config-loader';
import { DEFAULT_CONFIG } from '../config';
import type { WorkspaceDiagnosticsScanner } from '../diagnostics/scanner';
import type { InboundMessage, ConfigScope } from './editor-types';
import type { NinjaSeverity } from '../rule';
import type { NinjaCategory } from '../categories';

/**
 * Rule editor panel.
 *
 * Editing model: **draft-buffered**. Inbound messages mutate the model
 * only — nothing hits `settings.json` until the user explicitly clicks
 * Save. Discard restores the model from `settings.json`. This replaces
 * the old 5-second debounce flow, where every flick of a dropdown raced
 * an invisible timer to settle config — the new flow is predictable and
 * gives the user a baseline to A/B against.
 *
 * Dirty tracking is per-field: each user mutation records which field
 * changed (`severity:ruleId`, `autoFix:ruleId`, `option:path`,
 * `disabled:ruleId`). On save we walk each dirty set and persist the
 * model's current value (or remove the entry if the model no longer
 * has one — that's how `resetRule` reaches `settings.json`).
 *
 * While the buffer is dirty, external `settings.json` changes are NOT
 * applied to the model — we preserve the draft so users don't lose
 * in-flight work. When the buffer is clean we reload as before.
 */
export class NinjaEditorPanel implements vscode.Disposable {
	static readonly viewType = 'dbt-anvil.ninjaRuleEditor';
	private static _instance: NinjaEditorPanel | undefined;

	private _panel: vscode.WebviewPanel | undefined;
	private readonly _model: EditorModel;
	private readonly _disposables: vscode.Disposable[] = [];
	private _scanner: WorkspaceDiagnosticsScanner | undefined;
	private _lastRuleCounts: Map<string, number> | undefined;
	private _writingConfig = false;

	// Dirty tracking. Each set holds the IDs / paths that the user has
	// mutated since the last save / discard. On save we walk each set
	// and emit the corresponding write or remove based on the model's
	// current value.
	private _dirtySeverity = new Set<string>();
	private _dirtyAutoFix = new Set<string>();
	private _dirtyOption = new Set<string>();
	private _dirtyDisabled = new Set<string>();
	private _dirtyPreset = false;

	private constructor() {
		this._model = new EditorModel(getAllRuleMetadata());
		this._reloadFromSettings();
		// Refresh view when the user edits settings.json directly — only when
		// the buffer is clean. If the user has unsaved edits, preserve the
		// draft and silently note that external changes happened (they will
		// be picked up when the user discards or after save+reload).
		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (this._writingConfig) return;
				if (!e.affectsConfiguration('dbt-anvil.ninja')) return;
				if (this._model.isDirty) return;
				this._reloadFromSettings();
				this._pushSnapshot();
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
			(msg: InboundMessage) => void this._handleMessage(msg),
			null,
			this._disposables,
		);

		if (this._lastRuleCounts) {
			this._model.applyViolationCounts(this._lastRuleCounts);
		}
		this._pushSnapshot();

		if (!this._lastRuleCounts || this._lastRuleCounts.size === 0) {
			void this._scanner?.scanAll();
		}
	}

	dispose(): void {
		// Unsaved edits at dispose time are discarded — same shape as closing
		// a dirty editor tab without saving. The user already had the chance
		// to click Save; we don't second-guess them at teardown.
		this._panel?.dispose();
		for (const d of this._disposables) d.dispose();
		this._disposables.length = 0;
		NinjaEditorPanel._instance = undefined;
	}

	// ── Message handling ──────────────────────────────────────

	private async _handleMessage(msg: InboundMessage): Promise<void> {
		switch (msg.type) {
			case 'switchScope':
				this._model.switchScope(msg.scope as ConfigScope);
				this._model.applyOptionOverrides(getOverriddenOptionPaths(this._allOptionPaths(), this._model.activeScope));
				this._pushSnapshot();
				break;
			case 'setSeverity':
				this._model.setSeverity(msg.ruleId, msg.severity as NinjaSeverity);
				this._dirtySeverity.add(msg.ruleId);
				this._pushSnapshot();
				break;
			case 'resetRule': {
				this._model.resetRule(msg.ruleId);
				// resetRule clears severity, autoFix, and per-rule option overrides.
				// Mark each affected field dirty so save() can emit removes.
				this._dirtySeverity.add(msg.ruleId);
				this._dirtyAutoFix.add(msg.ruleId);
				const rule = getAllRuleMetadata().find(r => r.id === msg.ruleId);
				for (const opt of rule?.configOptions ?? []) {
					this._dirtyOption.add(opt.settingPath);
				}
				this._pushSnapshot();
				break;
			}
			case 'resetAll': {
				// Mark every rule that currently has an override dirty BEFORE we
				// clear them — afterwards the model no longer remembers which
				// ones had overrides.
				const overrides = this._model.getOverrides(this._model.activeScope);
				for (const ruleId of overrides.keys()) this._dirtySeverity.add(ruleId);
				this._model.resetAll();
				this._pushSnapshot();
				break;
			}
			case 'save':
				await this._save();
				break;
			case 'discard':
				this._discard();
				break;
			case 'setPreset':
				this._model.setPreset(msg.preset);
				this._dirtyPreset = true;
				this._pushSnapshot();
				break;
			case 'resetToDefaults': {
				// Mark every currently-customized field dirty so save emits the
				// corresponding removes after the model is wiped.
				const allRules = getAllRuleMetadata();
				for (const ruleId of this._model.getOverrides(this._model.activeScope).keys()) {
					this._dirtySeverity.add(ruleId);
				}
				for (const rule of allRules) {
					// Mark every rule's autoFix path dirty — model.resetToDefaults
					// clears the merged map and we want save to emit a remove
					// for each scope-side entry that was set.
					this._dirtyAutoFix.add(rule.id);
					if (this._model.isDisabled(rule.id)) this._dirtyDisabled.add(rule.id);
					for (const opt of rule.configOptions ?? []) {
						this._dirtyOption.add(opt.settingPath);
					}
				}
				this._dirtyPreset = true;
				this._model.resetToDefaults(DEFAULT_CONFIG.format.preset);
				this._pushSnapshot();
				break;
			}
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
				this._dirtyAutoFix.add(msg.ruleId);
				this._pushSnapshot();
				break;
			case 'setSort':
				this._model.setSort(msg.column, msg.dir);
				this._pushSnapshot();
				break;
			case 'setRuleOption':
				this._model.applyOptionValues({ [msg.settingPath]: msg.value });
				this._dirtyOption.add(msg.settingPath);
				this._pushSnapshot();
				break;
			case 'setDisabled':
				this._model.setDisabled(msg.ruleId, msg.disabled);
				this._dirtyDisabled.add(msg.ruleId);
				this._pushSnapshot();
				break;
		}
	}

	// ── Persistence ───────────────────────────────────────────

	/**
	 * Write every dirty field to `settings.json` at the active scope, then
	 * reload the model so it reflects what was actually persisted (catches
	 * any normalisation the writer applies).
	 *
	 * For each field type, the rule is: model has a value → save; model
	 * doesn't → remove. That's how `resetRule` reaches settings — the
	 * model entry is gone, so save() emits the corresponding remove.
	 */
	private async _save(): Promise<void> {
		const scope = this._model.activeScope;
		this._writingConfig = true;
		try {
			// Severity: model.getOverrides(scope) is the source of truth.
			const overrides = this._model.getOverrides(scope);
			for (const ruleId of this._dirtySeverity) {
				const sev = overrides.get(ruleId);
				if (sev !== undefined) await saveRuleSeverity(ruleId, sev, scope);
				else await removeRuleSeverity(ruleId, scope);
			}

			// AutoFix: per-rule override map on the model.
			const autoFixSnapshot = this._currentAutoFixMap();
			for (const ruleId of this._dirtyAutoFix) {
				if (autoFixSnapshot.has(ruleId)) await saveAutoFixRule(ruleId, autoFixSnapshot.get(ruleId)!, scope);
				else await removeAutoFixRule(ruleId, scope);
			}

			// Disabled: merged set on the model. We treat the model's set as
			// authoritative for the active scope at save time.
			for (const ruleId of this._dirtyDisabled) {
				if (this._model.isDisabled(ruleId)) await disableRule(ruleId, scope);
				else await enableRule(ruleId, scope);
			}

			// Preset: a single setting, always saved/overwritten when dirty.
			if (this._dirtyPreset) {
				await saveFormatPreset(this._model.preset, scope);
			}

			// Options: written individually by settingPath.
			const overriddenPaths = getOverriddenOptionPaths(this._allOptionPaths(), scope);
			const optionSnapshot = this._currentOptionValues();
			for (const path of this._dirtyOption) {
				const value = optionSnapshot.get(path);
				// Save when the model has a draft value AND it was/should be a
				// scope override. Otherwise remove — covers resetRule which
				// clears the override.
				if (value !== undefined && overriddenPaths.has(path)) {
					await saveConfigOption(path, value, scope);
				} else if (value !== undefined && !overriddenPaths.has(path)) {
					// Newly added override during this draft.
					await saveConfigOption(path, value, scope);
				} else {
					await removeConfigOption(path, scope);
				}
			}
		} finally {
			this._writingConfig = false;
		}
		this._clearDirty();
		this._reloadFromSettings();
		this._pushSnapshot();
	}

	/**
	 * Drop unsaved edits and re-sync the model from `settings.json`.
	 */
	private _discard(): void {
		this._clearDirty();
		this._reloadFromSettings();
		this._pushSnapshot();
	}

	private _clearDirty(): void {
		this._dirtySeverity.clear();
		this._dirtyAutoFix.clear();
		this._dirtyOption.clear();
		this._dirtyDisabled.clear();
		this._dirtyPreset = false;
	}

	private _reloadFromSettings(): void {
		this._model.applyInspectedConfig(inspectRuleSeverities());
		this._model.applyAutoFixConfig(inspectAutoFixRules());
		this._model.applyDisabledRules(this._mergedDisabledRules());
		this._model.applyOptionValues(inspectConfigOptions(this._allOptionPaths()));
		this._model.applyOptionOverrides(getOverriddenOptionPaths(this._allOptionPaths(), this._model.activeScope));
		this._model.applyPreset(inspectFormatPreset());
		this._model.markClean();
	}

	// ── Helpers ───────────────────────────────────────────────

	/** Mirror of EditorModel's internal `_autoFixRules` for save lookups. */
	private _currentAutoFixMap(): Map<string, boolean> {
		const map = new Map<string, boolean>();
		for (const rule of getAllRuleMetadata()) {
			// The model exposes per-rule autoFix through the snapshot, but to
			// distinguish "explicit override" from "default true" we re-inspect
			// against the metadata's autoFixable default. The simpler approach:
			// only save when the model's current value differs from the rule's
			// built-in autoFix default.
			const snapshot = this._model.snapshot();
			const ruleState = snapshot.rules.find(r => r.rule.id === rule.id);
			if (!ruleState) continue;
			const defaultVal = rule.autoFixable ?? false;
			if (ruleState.autoFixEnabled !== defaultVal) {
				map.set(rule.id, ruleState.autoFixEnabled);
			}
		}
		return map;
	}

	private _currentOptionValues(): Map<string, import('../rule').RuleOptionValue> {
		const map = new Map<string, import('../rule').RuleOptionValue>();
		const snap = this._model.snapshot();
		for (const r of snap.rules) {
			for (const [path, val] of Object.entries(r.configOptionValues)) {
				map.set(path, val);
			}
		}
		return map;
	}

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
