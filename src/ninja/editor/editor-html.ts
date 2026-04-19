import { SEVERITY_OPTIONS, type EditorSnapshot, type RuleState, type RuleOptionValue, type SortColumn } from './editor-types';
import type { NinjaCategory } from '../categories';
import type { RuleConfigOptionSpec } from '../rule';

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
	const allCls = s.activeCategory === 'all' ? 'active' : '';
	const totalCount = [...s.allCategoryCounts.values()].reduce((a, b) => a + b, 0);
	let html = `<nav class="sidebar">
	<button class="cat-btn cat-root ${allCls}" data-cat="all">Ninja Rules <span class="badge">${totalCount}</span></button>`;
	for (const [cat, count] of s.allCategoryCounts) {
		const cls = s.activeCategory === cat ? 'active' : '';
		html += `\n\t<button class="cat-btn cat-child ${cls}" data-cat="${cat}">${catLabel(cat)} <span class="badge">${count}</span></button>`;
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
	const { totalRules, activeRules, violations } = s.summary;
	return `<div class="summary">
	<span>${activeRules} of ${totalRules} rules active</span>
	<span class="summary-sep">·</span>
	<span>${fmtNum(violations)} violations</span>
	${s.isScanning ? '<span class="scanning">Scanning…</span>' : ''}
</div>`;
}

function ruleList(s: EditorSnapshot): string {
	if (s.rules.length === 0) {
		return `<div class="rule-list">${ruleHeader(s)}<div class="empty">No rules match the current filter.</div></div>`;
	}
	return `<div class="rule-list">${ruleHeader(s)}${s.rules.map(ruleRow).join('')}</div>`;
}

function ruleHeader(s: EditorSnapshot): string {
	function h(col: SortColumn, label: string): string {
		const isActive = s.sortColumn === col;
		const icon = isActive ? (s.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
		const cls = isActive ? ' sort-active' : '';
		return `<button class="sort-btn${cls}" data-col="${col}">${esc(label)}${icon}</button>`;
	}
	return `<div class="rule-header" data-active-col="${escAttr(s.sortColumn ?? '')}" data-active-dir="${s.sortDir}">
	<div class="col-id col-hcell">${h('id', 'Rule ID')}<div class="col-resize" data-col="id"></div></div>
	<div class="col-desc col-hcell">${h('description', 'Description')}</div>
	<div class="col-opts col-hcell"><span class="col-head-text">Options</span><div class="col-resize" data-col="opts"></div></div>
	<div class="col-fix col-hcell"><span class="col-head-text">Fix / Auto</span><div class="col-resize" data-col="fix"></div></div>
	<div class="col-counts col-hcell">${h('counts', 'Violations')}<div class="col-resize" data-col="counts"></div></div>
	<div class="col-sev col-hcell">${h('severity', 'Severity')}<div class="col-resize" data-col="sev"></div></div>
	<div class="col-reset col-hcell"></div>
</div>`;
}

function ruleRow(rs: RuleState): string {
	const modCls = rs.isModified ? ' modified' : '';
	const sev = rs.scopeInfo.effectiveSeverity;
	const kinds = rs.rule.actionKinds ?? (rs.rule.fixable ? ['fix'] : []);
	const badgeText = kinds.includes('snippet') ? 'snippet' : kinds.includes('fix') ? 'fix' : '';
	const hasBadge = badgeText !== '';
	const badgeDisabledCls = (rs.rule.autoFixable && !rs.autoFixEnabled) ? ' disabled' : '';
	const fixCell = hasBadge
		? `<span class="fix-badge${badgeDisabledCls}" title="${badgeText === 'snippet' ? 'Inserts a snippet' : 'Has auto-fix action'}">${badgeText}</span>`
			+ (rs.rule.autoFixable
				? `<select class="autofix-select" data-rule="${escAttr(rs.rule.id)}" title="Auto-fix for this rule"><option value="true"${rs.autoFixEnabled ? ' selected' : ''}>enabled</option><option value="false"${!rs.autoFixEnabled ? ' selected' : ''}>disabled</option></select>`
				: '')
		: '';
	return `<div class="rule-row${modCls}" data-rule="${escAttr(rs.rule.id)}">
	<div class="col-id">
		<span class="rule-id sev-${sev}">${esc(rs.rule.id)}</span>
	</div>
	<div class="col-desc">
		<span class="rule-desc">${esc(rs.rule.description)}</span>
	</div>
	<div class="col-opts">
		${optsCell(rs)}
	</div>
	<div class="col-fix">
		${fixCell}
	</div>
	<div class="col-counts">
		<span class="counts">${fmtNum(rs.violationCount)}</span>
	</div>
	<div class="col-sev">
		<select class="sev-select" data-rule="${escAttr(rs.rule.id)}">
			${sevOptions(sev)}
		</select>
	</div>
	<div class="col-reset">
		<button class="reset-btn${rs.isModified ? '' : ' hidden'}" data-rule="${escAttr(rs.rule.id)}" title="Reset to inherited value">↺</button>
	</div>
</div>`;
}

function optsCell(rs: RuleState): string {
	const opts = rs.rule.configOptions;
	if (!opts || opts.length === 0) return '';
	if (opts.length === 1) {
		return optControl(opts[0], rs.configOptionValues[opts[0].settingPath]);
	}
	// Multiple options: side-by-side; only label number inputs (enums describe themselves)
	const parts = opts.map(opt => {
		const control = optControl(opt, rs.configOptionValues[opt.settingPath]);
		if (opt.type === 'number') {
			return `<div class="opt-row"><span class="opt-label">${esc(opt.label)}:</span>${control}</div>`;
		}
		return control;
	});
	return `<div class="opt-multi">${parts.join('')}</div>`;
}

function optControl(opt: RuleConfigOptionSpec, curVal: RuleOptionValue | undefined): string {
	if (opt.type === 'enum') {
		const choices = opt.choices ?? [];
		const options = choices.map(c => {
			const sel = c === String(curVal ?? '') ? ' selected' : '';
			return `<option value="${escAttr(c)}"${sel}>${esc(c)}</option>`;
		}).join('');
		return `<select class="opt-select" data-path="${escAttr(opt.settingPath)}" title="${escAttr(opt.label)}">${options}</select>`;
	}
	if (opt.type === 'bool') {
		const isFalse = curVal === false || curVal === 'false';
		return `<select class="opt-select" data-path="${escAttr(opt.settingPath)}" title="${escAttr(opt.label)}"><option value="true"${!isFalse ? ' selected' : ''}>true</option><option value="false"${isFalse ? ' selected' : ''}>false</option></select>`;
	}
	// number
	const numVal = curVal !== undefined ? String(curVal) : '';
	const minAttr = opt.min !== undefined ? ` min="${opt.min}"` : '';
	const maxAttr = opt.max !== undefined ? ` max="${opt.max}"` : '';
	return `<input type="number" class="opt-number" data-path="${escAttr(opt.settingPath)}" title="${escAttr(opt.label)}"${minAttr}${maxAttr} value="${escAttr(numVal)}">`;
}

function sevOptions(current: string): string {
	return SEVERITY_OPTIONS.map(o => `<option value="${o}"${o === current ? ' selected' : ''}>${o}</option>`).join('');
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
	padding: 5px 12px;
	cursor: pointer;
	text-align: left;
	font-size: inherit;
}
.cat-btn:hover { background: var(--vscode-list-hoverBackground); }
.cat-btn.active {
	background: var(--vscode-list-activeSelectionBackground);
	color: var(--vscode-list-activeSelectionForeground);
}
.cat-root {
	font-weight: 600;
	padding: 7px 12px;
	border-bottom: 1px solid var(--vscode-panel-border, #444);
	margin-bottom: 2px;
}
.cat-child {
	padding: 4px 12px 4px 22px;
	font-size: var(--vscode-font-size, 13px);
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
.rule-header {
	display: grid;
	grid-template-columns: var(--cw-id, 200px) 1fr var(--cw-opts, 150px) var(--cw-fix, 160px) var(--cw-counts, 90px) var(--cw-sev, 90px) 28px;
	align-items: center;
	padding: 4px 12px;
	gap: 0 8px;
	position: sticky;
	top: 0;
	z-index: 1;
	background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
	border-bottom: 1px solid var(--vscode-panel-border, #444);
	font-size: 11px;
}
.col-hcell {
	position: relative;
	display: flex;
	align-items: center;
	overflow: hidden;
}
.sort-btn {
	background: none;
	border: none;
	color: var(--vscode-foreground);
	opacity: 0.65;
	cursor: pointer;
	font-size: 11px;
	font-weight: 600;
	padding: 2px 14px 2px 0;
	text-align: left;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.sort-btn:hover { opacity: 1; }
.sort-btn.sort-active {
	opacity: 1;
	color: var(--vscode-focusBorder, #007fd4);
}
.col-head-text {
	font-size: 11px;
	font-weight: 600;
	opacity: 0.65;
}
.col-resize {
	position: absolute;
	right: 0;
	top: 0;
	bottom: 0;
	width: 5px;
	cursor: col-resize;
	z-index: 2;
}
.col-resize:hover, .col-resize:active {
	background: var(--vscode-focusBorder, #007fd4);
	opacity: 0.4;
}
.rule-row {
	display: grid;
	grid-template-columns: var(--cw-id, 200px) 1fr var(--cw-opts, 150px) var(--cw-fix, 160px) var(--cw-counts, 90px) var(--cw-sev, 90px) 28px;
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
/* Severity squiggles on rule ID — wavy underline.
   padding-bottom is required because overflow:hidden on .rule-id clips decorations
   that extend below the baseline; padding expands the box to include them. */
.rule-id.sev-error {
	text-decoration-line: underline;
	text-decoration-style: wavy;
	text-decoration-color: var(--vscode-editorError-foreground, #f14c4c);
	text-underline-offset: 2px;
	padding-bottom: 3px;
}
.rule-id.sev-warning {
	text-decoration-line: underline;
	text-decoration-style: wavy;
	text-decoration-color: var(--vscode-editorWarning-foreground, #cca700);
	text-underline-offset: 2px;
	padding-bottom: 3px;
}
.rule-id.sev-info {
	text-decoration-line: underline;
	text-decoration-style: wavy;
	text-decoration-color: var(--vscode-editorInfo-foreground, #3794ff);
	text-underline-offset: 2px;
	padding-bottom: 3px;
}
.rule-id.sev-hint {
	text-decoration-line: underline;
	text-decoration-style: dotted;
	text-decoration-color: var(--vscode-editorHint-border, #888);
	text-underline-offset: 2px;
	padding-bottom: 3px;
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
.col-opts {
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 4px;
	overflow: hidden;
	flex-wrap: wrap;
}
.opt-multi {
	display: flex;
	align-items: center;
	gap: 6px;
}
.opt-row {
	display: flex;
	align-items: center;
	gap: 4px;
	min-width: 0;
}
.opt-label {
	font-size: 10px;
	opacity: 0.6;
	white-space: nowrap;
	flex-shrink: 0;
}
.opt-select {
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, transparent);
	padding: 1px 3px;
	border-radius: 2px;
	font-size: 11px;
	cursor: pointer;
	min-width: 0;
	flex: 1;
	max-width: 100px;
}
.opt-select:focus {
	border-color: var(--vscode-focusBorder);
	outline: none;
}
.opt-number {
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	padding: 1px 3px;
	border-radius: 2px;
	font-size: 11px;
	width: 60px;
	min-width: 0;
}
.opt-number:focus {
	border-color: var(--vscode-focusBorder);
	outline: none;
}
.col-fix {
	display: flex;
	align-items: center;
	gap: 4px;
	flex-wrap: nowrap;
}
.fix-badge {
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 10px;
	padding: 1px 5px;
	border-radius: 3px;
	background: var(--vscode-badge-background, #4d4d4d);
	color: var(--vscode-badge-foreground, #fff);
	opacity: 0.75;
	white-space: nowrap;
	flex-shrink: 0;
}
.fix-badge.disabled {
	opacity: 0.3;
	filter: grayscale(1);
}
.autofix-select {
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, transparent);
	padding: 1px 3px;
	border-radius: 2px;
	font-size: 11px;
	cursor: pointer;
	max-width: 80px;
}
.autofix-select:focus {
	border-color: var(--vscode-focusBorder);
	outline: none;
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

	// Column width state — persisted via vscode.getState() across re-renders
	const savedState = vscode.getState() ?? {};
	const colVarMap = { id: '--cw-id', opts: '--cw-opts', fix: '--cw-fix', counts: '--cw-counts', sev: '--cw-sev' };
	const defaultW = { id: 200, opts: 150, fix: 160, counts: 90, sev: 90 };
	const colWidths = { ...defaultW, ...(savedState.colWidths ?? {}) };
	for (const [col, w] of Object.entries(colWidths)) {
		if (colVarMap[col]) document.documentElement.style.setProperty(colVarMap[col], w + 'px');
	}

	// Scroll position restore — prevents jump on re-render
	const ruleList = document.querySelector('.rule-list');
	if (ruleList) {
		ruleList.scrollTop = savedState.scrollTop ?? 0;
		ruleList.addEventListener('scroll', () => {
			vscode.setState({ ...(vscode.getState() ?? {}), scrollTop: ruleList.scrollTop });
		});
	}

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

	// Search input — restore focus + caret if it was active before re-render
	const searchInput = document.querySelector('.search-input');
	if (searchInput) {
		if (savedState.searchFocused) {
			searchInput.focus();
			const pos = savedState.searchCaret ?? searchInput.value.length;
			searchInput.setSelectionRange(pos, pos);
		}
		searchInput.addEventListener('focus', () => {
			vscode.setState({ ...(vscode.getState() ?? {}), searchFocused: true });
		});
		searchInput.addEventListener('blur', () => {
			vscode.setState({ ...(vscode.getState() ?? {}), searchFocused: false });
		});
		let debounce;
		searchInput.addEventListener('input', () => {
			vscode.setState({ ...(vscode.getState() ?? {}), searchCaret: searchInput.selectionStart });
			clearTimeout(debounce);
			debounce = setTimeout(() => {
				const q = searchInput.value;
				if (q.length === 0 || q.length >= 3) {
					vscode.postMessage({ type: 'setSearch', query: q });
				}
			}, 150);
		});
	}

	// Column sort — click cycles: unsorted → asc → desc → unsorted
	document.querySelectorAll('.sort-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			const col = btn.dataset.col;
			const header = document.querySelector('.rule-header');
			const activeCol = header ? header.dataset.activeCol : '';
			const activeDir = header ? header.dataset.activeDir : 'asc';
			let column, dir;
			if (activeCol === col && activeDir === 'asc') { column = col; dir = 'desc'; }
			else if (activeCol === col && activeDir === 'desc') { column = null; dir = 'asc'; }
			else { column = col; dir = 'asc'; }
			vscode.postMessage({ type: 'setSort', column: column, dir: dir });
		});
	});

	// Column resize drag
	let resizingCol = null;
	let resizeStartX = 0;
	let resizeStartW = 0;

	document.querySelectorAll('.col-resize').forEach(handle => {
		handle.addEventListener('mousedown', e => {
			resizingCol = handle.dataset.col;
			resizeStartX = e.clientX;
			resizeStartW = colWidths[resizingCol] ?? defaultW[resizingCol] ?? 90;
			e.preventDefault();
		});
	});

	document.addEventListener('mousemove', e => {
		if (!resizingCol) return;
		const delta = e.clientX - resizeStartX;
		const newW = Math.max(60, resizeStartW + delta);
		colWidths[resizingCol] = newW;
		const varName = colVarMap[resizingCol];
		if (varName) document.documentElement.style.setProperty(varName, newW + 'px');
	});

	document.addEventListener('mouseup', () => {
		if (!resizingCol) return;
		const newState = { ...(vscode.getState() ?? {}), colWidths: { ...colWidths } };
		vscode.setState(newState);
		resizingCol = null;
	});

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

	// Auto-fix toggles
	document.querySelectorAll('.autofix-select').forEach(sel => {
		sel.addEventListener('change', () => {
			vscode.postMessage({ type: 'setAutoFix', ruleId: sel.dataset.rule, enabled: sel.value === 'true' });
		});
	});

	// Config option selects
	document.querySelectorAll('.opt-select').forEach(sel => {
		sel.addEventListener('change', () => {
			vscode.postMessage({ type: 'setRuleOption', settingPath: sel.dataset.path, value: sel.value });
		});
	});

	// Config option number inputs
	document.querySelectorAll('.opt-number').forEach(inp => {
		inp.addEventListener('change', () => {
			const num = parseInt(inp.value, 10);
			if (!isNaN(num)) vscode.postMessage({ type: 'setRuleOption', settingPath: inp.dataset.path, value: num });
		});
	});

})();
`;
