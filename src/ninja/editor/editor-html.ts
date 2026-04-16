import type { EditorSnapshot, RuleState } from './editor-types';
import type { NinjaCategory } from '../categories';

// ── Public API ──────────────────────────────────────────────────────

export function renderEditor(snapshot: EditorSnapshot, nonce: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ninja Rule Editor</title>
<style>${CSS}</style>
</head>
<body>
${scopeTabs(snapshot)}
<div class="container">
	${sidebar(snapshot)}
	<div class="main">
		${searchBar(snapshot)}
		${summaryBar(snapshot)}
		${ruleList(snapshot)}
	</div>
</div>
<script nonce="${nonce}">${CLIENT_JS}</script>
</body>
</html>`;
}

// ── Fragments ───────────────────────────────────────────────────────

function scopeTabs(s: EditorSnapshot): string {
	const userCls = s.activeScope === 'user' ? 'active' : '';
	const wsCls = s.activeScope === 'workspace' ? 'active' : '';
	return `<div class="scope-tabs">
	<button class="scope-tab ${userCls}" data-scope="user">User</button>
	<button class="scope-tab ${wsCls}" data-scope="workspace">Workspace</button>
	${s.isDirty ? '<span class="dirty-dot" title="Unsaved changes">●</span>' : ''}
</div>`;
}

function sidebar(s: EditorSnapshot): string {
	const cats = categoryCounts(s.rules);
	const allCls = s.activeCategory === 'all' ? 'active' : '';
	let html = `<nav class="sidebar">
	<button class="cat-btn ${allCls}" data-cat="all">All <span class="badge">${s.rules.length}</span></button>`;
	for (const [cat, count] of cats) {
		const cls = s.activeCategory === cat ? 'active' : '';
		html += `\n\t<button class="cat-btn ${cls}" data-cat="${cat}">${catLabel(cat)} <span class="badge">${count}</span></button>`;
	}
	html += '\n</nav>';
	return html;
}

function searchBar(s: EditorSnapshot): string {
	return `<div class="search-bar">
	<input type="text" class="search-input" placeholder="Filter rules…"
		value="${escAttr(s.searchQuery)}" />
</div>`;
}

function summaryBar(s: EditorSnapshot): string {
	const { totalRules, activeRules, configuredViolations, baselineViolations } = s.summary;
	return `<div class="summary">
	<span>${activeRules} of ${totalRules} rules active</span>
	<span class="summary-sep">·</span>
	<span>${fmtNum(configuredViolations)} / ${fmtNum(baselineViolations)} violations</span>
	${s.isScanning ? '<span class="scanning">Scanning…</span>' : ''}
</div>`;
}

function ruleList(s: EditorSnapshot): string {
	if (s.rules.length === 0) {
		return '<div class="empty">No rules match the current filter.</div>';
	}
	return `<div class="rule-list">${s.rules.map(ruleRow).join('')}</div>`;
}

function ruleRow(rs: RuleState): string {
	const modCls = rs.isModified ? ' modified' : '';
	const sev = rs.scopeInfo.effectiveSeverity;
	return `<div class="rule-row${modCls}" data-rule="${rs.rule.id}">
	<div class="col-id">
		<span class="rule-id">${esc(rs.rule.id)}</span>
	</div>
	<div class="col-desc">
		<span class="rule-desc">${esc(rs.rule.description)}</span>
	</div>
	<div class="col-counts">
		<span class="counts" title="configured / baseline">${fmtNum(rs.configuredCount)} / ${fmtNum(rs.baselineCount)}</span>
	</div>
	<div class="col-sev">
		<select class="sev-select" data-rule="${rs.rule.id}">
			${sevOptions(sev)}
		</select>
	</div>
	<div class="col-reset">
		<button class="reset-btn${rs.isModified ? '' : ' hidden'}" data-rule="${rs.rule.id}" title="Reset to inherited value">↺</button>
	</div>
</div>`;
}

function sevOptions(current: string): string {
	const opts = ['error', 'warning', 'info', 'hint', 'off'];
	return opts.map(o => `<option value="${o}"${o === current ? ' selected' : ''}>${o}</option>`).join('');
}

// ── Helpers ─────────────────────────────────────────────────────────

function categoryCounts(rules: RuleState[]): Map<NinjaCategory, number> {
	const m = new Map<NinjaCategory, number>();
	for (const r of rules) {
		m.set(r.rule.category, (m.get(r.rule.category) ?? 0) + 1);
	}
	return m;
}

function catLabel(cat: NinjaCategory): string {
	return cat.charAt(0).toUpperCase() + cat.slice(1);
}

function fmtNum(n: number): string {
	return n.toLocaleString('en-US');
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
	return esc(s).replace(/"/g, '&quot;');
}

// ── CSS ─────────────────────────────────────────────────────────────

const CSS = /* css */`
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
	font-family: var(--vscode-font-family, system-ui, sans-serif);
	font-size: var(--vscode-font-size, 13px);
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
}

/* Scope tabs */
.scope-tabs {
	display: flex;
	align-items: center;
	gap: 0;
	border-bottom: 1px solid var(--vscode-panel-border, #444);
	background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
	padding: 0 12px;
}
.scope-tab {
	background: none;
	border: none;
	color: var(--vscode-foreground);
	padding: 8px 16px;
	cursor: pointer;
	border-bottom: 2px solid transparent;
	opacity: 0.7;
	font-size: inherit;
}
.scope-tab:hover { opacity: 1; }
.scope-tab.active {
	opacity: 1;
	border-bottom-color: var(--vscode-focusBorder, #007fd4);
}
.dirty-dot {
	color: var(--vscode-notificationsInfoIcon-foreground, #3794ff);
	margin-left: 8px;
	font-size: 16px;
}

/* Layout */
.container {
	display: flex;
	height: calc(100vh - 37px);
	overflow: hidden;
}

/* Sidebar */
.sidebar {
	display: flex;
	flex-direction: column;
	width: 180px;
	min-width: 140px;
	padding: 8px 0;
	border-right: 1px solid var(--vscode-panel-border, #444);
	overflow-y: auto;
}
.cat-btn {
	display: flex;
	justify-content: space-between;
	align-items: center;
	background: none;
	border: none;
	color: var(--vscode-foreground);
	padding: 6px 12px;
	cursor: pointer;
	text-align: left;
	font-size: inherit;
}
.cat-btn:hover { background: var(--vscode-list-hoverBackground); }
.cat-btn.active {
	background: var(--vscode-list-activeSelectionBackground);
	color: var(--vscode-list-activeSelectionForeground);
}
.badge {
	font-size: 11px;
	opacity: 0.7;
	min-width: 20px;
	text-align: right;
}

/* Main */
.main {
	flex: 1;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

/* Search */
.search-bar {
	padding: 8px 12px;
	border-bottom: 1px solid var(--vscode-panel-border, #444);
}
.search-input {
	width: 100%;
	padding: 4px 8px;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	border-radius: 2px;
	font-size: inherit;
	outline: none;
}
.search-input:focus {
	border-color: var(--vscode-focusBorder);
}

/* Summary */
.summary {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 12px;
	font-size: 12px;
	opacity: 0.8;
	border-bottom: 1px solid var(--vscode-panel-border, #444);
}
.summary-sep { opacity: 0.4; }
.scanning {
	color: var(--vscode-notificationsInfoIcon-foreground, #3794ff);
	font-style: italic;
}

/* Rule list */
.rule-list {
	flex: 1;
	overflow-y: auto;
	padding: 4px 0;
}
.rule-row {
	display: grid;
	grid-template-columns: 200px 1fr 90px 90px 28px;
	align-items: center;
	padding: 4px 12px;
	border-left: 3px solid transparent;
	min-height: 30px;
	gap: 0 8px;
}
.rule-row:hover {
	background: var(--vscode-list-hoverBackground);
}
.rule-row.modified {
	border-left-color: var(--vscode-focusBorder, #007fd4);
}
.col-id {
	overflow: hidden;
}
.rule-id {
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 12px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	display: block;
}
.col-desc {
	overflow: hidden;
}
.rule-desc {
	opacity: 0.7;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	display: block;
}
.col-counts {
	text-align: right;
}
.counts {
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 12px;
	opacity: 0.6;
	white-space: nowrap;
}
.col-sev {}
.col-reset {
	display: flex;
	align-items: center;
	justify-content: center;
}

/* Severity dropdown */
.sev-select {
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, transparent);
	padding: 2px 4px;
	border-radius: 2px;
	font-size: inherit;
	cursor: pointer;
	min-width: 80px;
}
.sev-select:focus {
	border-color: var(--vscode-focusBorder);
	outline: none;
}

/* Reset button */
.reset-btn {
	background: none;
	border: none;
	color: var(--vscode-foreground);
	cursor: pointer;
	font-size: 16px;
	padding: 2px 4px;
	opacity: 0.6;
	line-height: 1;
}
.reset-btn:hover { opacity: 1; }
.reset-btn.hidden { visibility: hidden; }

/* Empty */
.empty {
	padding: 24px;
	text-align: center;
	opacity: 0.6;
}
`;

// ── Client-side JS ──────────────────────────────────────────────────

const CLIENT_JS = /* js */`
(function() {
	const vscode = acquireVsCodeApi();

	// Scope tabs
	document.querySelectorAll('.scope-tab').forEach(btn => {
		btn.addEventListener('click', () => {
			vscode.postMessage({ type: 'switchScope', scope: btn.dataset.scope });
		});
	});

	// Category nav
	document.querySelectorAll('.cat-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			vscode.postMessage({ type: 'setCategory', category: btn.dataset.cat });
		});
	});

	// Search input
	const searchInput = document.querySelector('.search-input');
	if (searchInput) {
		let debounce;
		searchInput.addEventListener('input', () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => {
				vscode.postMessage({ type: 'setSearch', query: searchInput.value });
			}, 150);
		});
	}

	// Severity dropdowns
	document.querySelectorAll('.sev-select').forEach(sel => {
		sel.addEventListener('change', () => {
			vscode.postMessage({ type: 'setSeverity', ruleId: sel.dataset.rule, severity: sel.value });
		});
	});

	// Reset buttons
	document.querySelectorAll('.reset-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			vscode.postMessage({ type: 'resetRule', ruleId: btn.dataset.rule });
		});
	});

})();
`;
