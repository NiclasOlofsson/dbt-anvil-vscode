/**
 * capture-demo.mjs
 *
 * Launches VS Code with the dbt Anvil extension loaded against the nba-monte-carlo
 * sample project, drives through 14 feature segments via Playwright Electron mode,
 * and saves screenshots to temp_auto/demo-frames/.
 *
 * Usage:
 *   npm run demo:capture
 *
 * Prerequisites:
 *   1. npm run compile (or the watch task must be running)
 *   2. cd samples/nba-monte-carlo && uv run dbt parse --profiles-dir .
 */

import { _electron as electron } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const sampleProject = process.env.DEMO_PROJECT || path.join(repoRoot, 'samples', 'nba-monte-carlo');
const framesDir = path.join(repoRoot, 'temp_auto', 'demo-frames');
const videoDir = path.join(repoRoot, 'temp_auto', 'demo-video');
const userDataDir = path.join(repoRoot, 'temp_auto', 'demo-userdata');
const recordingOut = path.join(repoRoot, 'temp_auto', 'demo-recording.json');

// --step <segment-id>  run only that one segment; omit for a full capture
// e.g.  npm run demo:capture -- --step profiler
const stepArgIdx = process.argv.indexOf('--step');
const stepFilter = stepArgIdx !== -1 ? process.argv[stepArgIdx + 1] : null;
const shouldRun = (id) => !stepFilter || stepFilter === id;

// VS Code Insiders executable. Resolves from the current user's home; override
// with the VSCODE_EXE env var (e.g. for a system-wide or non-standard install).
const VSCODE_EXE = process.env.VSCODE_EXE
	|| path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe');

// Logical screen size. The window is maximized to fill it and the video is recorded
// at this size, then the render scales the result down to the configured output
// (1080p/720p). Querying it keeps the capture correct on any machine/DPI instead of
// assuming 1920x1080, which a HiDPI laptop's logical resolution can't actually fit.
let SCREEN = { width: 1920, height: 1080 };
try {
	const out = execSync(
		`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Width; [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Height"`,
		{ encoding: 'utf8', windowsHide: true },
	);
	const nums = out.match(/\d+/g);
	if (nums && nums.length >= 2) {
		SCREEN = { width: parseInt(nums[0], 10), height: parseInt(nums[1], 10) };
	}
} catch {
	// keep the 1920x1080 fallback
}

// Delay between keystrokes when typing via keyboard.type(). 1ms = effectively instant
// but still fires individual key events (needed for VS Code quick-open fuzzy matching).
const TYPE_DELAY = { delay: 1 };

// Model paths that make great demo targets
const MODEL = {
	enriched: path.join(sampleProject, 'models', 'nba', 'analysis', 'reg_season_actuals_enriched.sql'),
	season: path.join(sampleProject, 'models', 'nba', 'analysis', 'season_summary.sql'),
	preds: path.join(sampleProject, 'models', 'nba', 'analysis', 'reg_season_predictions.sql'),
};

// Ensure output directories exist — wipe frames and video dirs first so stale files don't accumulate
// Only wipe on a full run; preserve them when testing a single step
if (!stepFilter) {
	if (fs.existsSync(framesDir)) {
		for (const f of fs.readdirSync(framesDir)) fs.unlinkSync(path.join(framesDir, f));
	}
	if (fs.existsSync(videoDir)) {
		for (const f of fs.readdirSync(videoDir)) fs.unlinkSync(path.join(videoDir, f));
	}
}
fs.mkdirSync(framesDir, { recursive: true });
fs.mkdirSync(videoDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });

// Clear any persisted profiler results so the PROFILE RESULTS panel starts EMPTY.
// The extension loads profile-results.json on activation and shows it; leaving stale
// results from a previous capture means the profiler segment swaps old→new instead of
// building from nothing. Delete it before launch so the viewer watches it fill in.
(function clearPersistedProfilerResults() {
	const wsStorage = path.join(userDataDir, 'User', 'workspaceStorage');
	if (!fs.existsSync(wsStorage)) return;
	for (const hash of fs.readdirSync(wsStorage)) {
		const f = path.join(wsStorage, hash, 'nickeolofsson.dbt-anvil', 'profile-results.json');
		if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`[profiler] cleared persisted results: ${path.relative(repoRoot, f)}`); }
	}
})();

// Pre-populate VS Code settings to prevent auto-update dialogs and installers
const vscSettingsDir = path.join(userDataDir, 'User');
fs.mkdirSync(vscSettingsDir, { recursive: true });
const vscSettingsPath = path.join(vscSettingsDir, 'settings.json');
const existingSettings = fs.existsSync(vscSettingsPath)
	? JSON.parse(fs.readFileSync(vscSettingsPath, 'utf8'))
	: {};
existingSettings['update.mode'] = 'none';
existingSettings['extensions.autoCheckUpdates'] = false;
existingSettings['extensions.autoUpdate'] = false;
// Keep the demo frames clean: no Chat panel in the secondary side bar, no chat
// button in the title-bar command center. VS Code Insiders otherwise auto-opens it.
existingSettings['chat.commandCenter.enabled'] = false;
existingSettings['workbench.secondarySideBar.defaultVisibility'] = 'hidden';
fs.writeFileSync(vscSettingsPath, JSON.stringify(existingSettings, null, 2));

let screenshotN = 0;
const frames = [];
const events = [];
const segmentStarts = new Map();
let sessionStartMs = Date.now();
let videoStartOffsetMs = 0;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Inject a semi-transparent green border/fill over the given CSS selector so the
 * viewer's eye is drawn to the right part of the screen in the screenshot.
 * Call removeHighlight(win) immediately after the screenshot.
 */
async function injectHighlightStyle(win) {
	await win.evaluate(() => {
		if (document.getElementById('__demo-hl-style__')) return;
		const style = document.createElement('style');
		style.id = '__demo-hl-style__';
		style.textContent = [
			'@keyframes __demo-shimmer__ {',
			'  0%   { background: rgba(50, 210, 120, 0.05); }',
			'  50%  { background: rgba(50, 210, 120, 0.20); }',
			'  100% { background: rgba(50, 210, 120, 0.05); }',
			'}',
		].join('\n');
		document.head.appendChild(style);
	});
}

async function flashHighlight(win, selector) {
	await injectHighlightStyle(win);
	await win.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return;
		const r = el.getBoundingClientRect();
		const ov = document.createElement('div');
		ov.id = '__demo-hl__';
		Object.assign(ov.style, {
			position: 'fixed',
			left: `${r.left}px`,
			top: `${r.top}px`,
			width: `${r.width}px`,
			height: `${r.height}px`,
			background: 'rgba(50, 210, 120, 0.10)',
			border: '2px solid rgba(50, 210, 120, 0.65)',
			borderRadius: '4px',
			pointerEvents: 'none',
			zIndex: '99999',
			boxSizing: 'border-box',
			animation: '__demo-shimmer__ 1.2s ease-in-out infinite',
		});
		document.body.appendChild(ov);
	}, selector);
}

/**
 * Highlight a specific collapsible pane by its visible title instead of the whole sidebar.
 * Falls back to the provided container selector if the pane cannot be found.
 */
async function flashPaneHighlight(win, titleText, containerSelector = '.part.sidebar') {
	await injectHighlightStyle(win);
	const highlighted = await win.evaluate(({ title, containerSel }) => {
		const container = document.querySelector(containerSel);
		if (!container) return false;

		const headers = container.querySelectorAll('.pane-header .title');
		for (const headerTitle of headers) {
			if (headerTitle.textContent?.trim().toUpperCase() !== title.toUpperCase()) continue;
			const pane = headerTitle.closest('.pane');
			const target = pane ?? headerTitle.closest('.pane-header') ?? container;
			const r = target.getBoundingClientRect();
			const ov = document.createElement('div');
			ov.id = '__demo-hl__';
			Object.assign(ov.style, {
				position: 'fixed',
				left: `${r.left}px`,
				top: `${r.top}px`,
				width: `${r.width}px`,
				height: `${r.height}px`,
				background: 'rgba(50, 210, 120, 0.10)',
				border: '2px solid rgba(50, 210, 120, 0.65)',
				borderRadius: '4px',
				pointerEvents: 'none',
				zIndex: '99999',
				boxSizing: 'border-box',
				animation: '__demo-shimmer__ 1.2s ease-in-out infinite',
			});
			document.body.appendChild(ov);
			return true;
		}

		return false;
	}, { title: titleText, containerSel: containerSelector });

	if (!highlighted) await flashHighlight(win, containerSelector);
}

async function removeHighlight(win) {
	await win.evaluate(() => {
		const el = document.getElementById('__demo-hl__');
		if (el) el.remove();
	});
}

/**
 * Find the Playwright Frame that contains a specific DOM element.
 * Used to interact with VS Code WebviewView content (lineage graph, etc.).
 */
async function findWebviewFrame(win, uniqueSelector) {
	for (const frame of win.frames()) {
		try {
			const found = await frame.evaluate(
				(sel) => !!document.querySelector(sel),
				uniqueSelector,
			);
			if (found) return frame;
		} catch { /* cross-origin or destroyed frame */ }
	}
	return null;
}

async function screenshot(win, name, caption, durationMs = 3000) {
	screenshotN++;
	const num = String(screenshotN).padStart(2, '0');
	const filename = `${num}-${name}.png`;
	const filePath = path.join(framesDir, filename);
	await win.screenshot({ path: filePath });
	const tMs = Date.now() - sessionStartMs;
	frames.push({
		name,
		file: `temp_auto/demo-frames/${filename}`,
		caption,
		durationMs,
		tMs,
	});
	logEvent('frame.captured', { frame: name, file: filename, durationMs });
	console.log(`  ✓ ${num} ${name}`);
}

function logEvent(name, data = {}) {
	events.push({
		tMs: Date.now() - sessionStartMs,
		name,
		...data,
	});
}

/**
 * Inject a white flash, wait for the compositor to actually paint it, then log
 * 'X.sync' and 'X.demo'. The generator scans the recording for the flash's PTS to
 * drift-correct this segment's clip. The old version held the flash for a bare 80ms
 * with no paint guarantee, so when the renderer was busy the overlay was added and
 * removed without a single frame ever showing it — 5/17 flashes never landed and
 * silently lost per-segment drift correction. Force a paint (double rAF) and hold
 * ~150ms (≥3 frames @25fps) so a white frame reliably registers in the video.
 */
async function syncAndLogDemo(win, eventName) {
	const syncName = eventName.replace(/\.demo$/, '.sync');
	await win.evaluate(() => new Promise((resolve) => {
		const d = document.createElement('div');
		d.id = '__seg-sync__';
		d.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483647;pointer-events:none;';
		document.body.appendChild(d);
		requestAnimationFrame(() => requestAnimationFrame(resolve));
	}));
	logEvent(syncName);
	await win.waitForTimeout(150);
	await win.evaluate(() => document.getElementById('__seg-sync__')?.remove());
	await win.waitForTimeout(400);
	logEvent(eventName);
}

function markSegmentStart(segment) {
	segmentStarts.set(segment, Date.now() - sessionStartMs);
	logEvent('segment.start', { segment });
}

function markSegmentEnd(segment) {
	const endMs = Date.now() - sessionStartMs;
	const startMs = segmentStarts.get(segment) ?? endMs;
	logEvent('segment.end', { segment, durationMs: Math.max(0, endMs - startMs) });
}

async function runCommand(win, command) {
	await win.keyboard.press('Control+Shift+P');
	const input = win.locator('.quick-input-widget input');
	await input.waitFor({ state: 'visible', timeout: 3000 });
	await win.keyboard.type(command, TYPE_DELAY);
	await win.waitForSelector('.quick-input-list .monaco-list-row', { timeout: 3000 }).catch(() => { });
	await win.keyboard.press('Enter');
	// Wait for the command palette overlay to fully dismiss before continuing
	await win.waitForSelector('.quick-input-widget', { state: 'hidden', timeout: 3000 }).catch(() => { });
}

async function openFile(win, filename) {
	await win.keyboard.press('Control+P');
	const input = win.locator('.quick-input-widget input');
	await input.waitFor({ state: 'visible', timeout: 3000 });
	await input.click();   // focus the quick-open input (not the editor) before typing
	await input.fill('');  // clear leftover text reliably — Ctrl+A can race the focus
	await win.keyboard.type(filename, TYPE_DELAY);
	// Select the EXACT file, not a fuzzy superset. 'season_summary.sql' is a substring of
	// 'reg_season_summary.sql', and recency can rank the superset first — so a naive
	// "top row includes the stem" check opens the wrong file. Find the row whose basename
	// equals the requested filename and arrow to it before pressing Enter.
	await win.waitForSelector('.quick-input-list .monaco-list-row', { timeout: 5000 }).catch(() => { });
	const stem = filename.replace(/\.[^.]+$/, '');
	let rowIdx = -1;
	for (let i = 0; i < 20 && rowIdx < 0; i++) {
		rowIdx = await win.evaluate((fname) => {
			const rows = [...document.querySelectorAll('.quick-input-list .monaco-list-row')];
			for (let r = 0; r < rows.length; r++) {
				const name = (rows[r].querySelector('.label-name')?.textContent || '').trim();
				if (name.toLowerCase() === fname.toLowerCase()) return r;
			}
			return -1;
		}, filename);
		if (rowIdx < 0) await win.waitForTimeout(150);
	}
	for (let k = 0; k < Math.max(0, rowIdx); k++) await win.keyboard.press('ArrowDown');
	await win.keyboard.press('Enter');
	// Wait for editor to be visible and stabilise
	await win.waitForSelector('.monaco-editor .view-lines', { timeout: 10000 });
	// Wait for the quick-input to fully dismiss before continuing
	await win.waitForSelector('.quick-input-widget', { state: 'hidden', timeout: 2000 }).catch(() => { });
	// Wait until the intended file is actually the active editor (its tab is active) rather
	// than a blanket ~6s sleep — the editor is interactive as soon as its content is laid
	// out. Falls through to the short settle after 8s if the tab selector ever changes.
	await win.waitForFunction((s) => {
		const tab = document.querySelector('.tabs-container .tab.active .tab-label, .title .label-name');
		return !!tab && (tab.textContent || '').toLowerCase().includes(s);
	}, stem.toLowerCase(), { timeout: 8000 }).catch(() => { });
	await win.waitForTimeout(300);
	// Reset to line 1 col 1 so horizontal scroll starts at the leftmost position.
	// VS Code remembers cursor/scroll per file; Ctrl+Home guarantees col 0 is visible
	// before any subsequent goToLine call positions the cursor.
	await win.keyboard.press('Control+Home');
	await win.waitForTimeout(400);
}

async function goToLine(win, line, col = 1) {
	await win.keyboard.press('Control+G');
	const input = win.locator('.quick-input-widget input');
	await input.waitFor({ state: 'visible', timeout: 3000 });
	await win.keyboard.type(`${line}:${col}`, TYPE_DELAY);
	await win.keyboard.press('Enter');
	// Wait for the quick-input to fully dismiss before continuing
	await win.waitForSelector('.quick-input-widget', { state: 'hidden', timeout: 2000 }).catch(() => { });
	await win.waitForTimeout(200);
}

async function closeEditor(win) {
	// Revert any unsaved changes before closing — avoids the 'Save changes?' dialog
	try {
		await runCommand(win, 'File: Revert File');
	} catch { /* file may be new/untitled, ignore */ }
	await win.keyboard.press('Control+W');
	await win.waitForTimeout(400);
}

async function pressEscape(win) {
	await win.keyboard.press('Escape');
	await win.waitForTimeout(300);
}

/**
 * Wait until the dbt Anvil status bar shows "dbt: Ready" (no active job).
 * The status bar text is either "$(sync~spin) dbt: <label>" while busy
 * or "$(check) dbt: Ready" when idle.
 */
async function waitForReady(win, timeout = 60000) {
	await win.waitForFunction(
		() => {
			for (const item of document.querySelectorAll('.statusbar-item')) {
				// Check textContent, aria-label and title — VS Code uses all three
				const text = (item.textContent || '')
					+ (item.getAttribute('aria-label') || '')
					+ (item.title || '');
				if (text.includes('dbt:') && text.includes('Ready')) return true;
			}
			return false;
		},
		undefined,
		{ timeout },
	);
}

// ─── Panel / tree helpers ─────────────────────────────────────────────────────

/**
 * Expand or collapse a dbt Anvil sidebar panel by its visible title text.
 * Uses Playwright locator .click() so real mouse events reach VS Code's handlers
 * (synthetic DOM clicks via evaluate() are ignored by the sidebar).
 */
async function setPanelExpanded(win, titleText, expanded) {
	// Scope to .part.sidebar only — excludes hidden Output/Panel pane-headers
	const headers = win.locator('.part.sidebar .pane-header:not(.hidden)');
	const n = await headers.count();
	for (let i = 0; i < n; i++) {
		const h = headers.nth(i);
		const text = await h.locator('.title').textContent().catch(() => '');
		if (text.trim().toUpperCase() !== titleText.toUpperCase()) continue;
		const ariaExpanded = await h.getAttribute('aria-expanded');
		const isExpanded = ariaExpanded === 'true';
		if (isExpanded !== expanded) {
			await h.click();
			await win.waitForTimeout(350);
		}
		return;
	}
	console.warn(`  ⚠ setPanelExpanded: panel "${titleText}" not found`);
}

/** Collapse a single sidebar panel by title. */
async function collapsePanel(win, title) { return setPanelExpanded(win, title, false); }

/** Expand a single sidebar panel by title. */
async function expandPanel(win, title) { return setPanelExpanded(win, title, true); }

/**
 * Toggle all expandable tree rows inside a container to a target state.
 * Uses real Playwright clicks instead of synthetic DOM clicks because VS Code's
 * tree widgets don't reliably react to evaluate(() => el.click()).
 */
async function setAllTreeItemsExpanded(win, expanded, containerSelector = '.part.sidebar', maxPasses = 6) {
	const targetValue = expanded ? 'false' : 'true';
	for (let pass = 0; pass < maxPasses; pass++) {
		const rowLocator = win.locator(`${containerSelector} .monaco-list-row[aria-expanded="${targetValue}"]`);
		const rowHandles = await rowLocator.elementHandles();
		if (rowHandles.length === 0) return;

		const orderedRows = expanded ? rowHandles : [...rowHandles].reverse();
		for (const row of orderedRows) {
			const twistie = await row.$('.monaco-tl-twistie, .expand-collapse-button, .codicon.codicon-chevron-right, .codicon.codicon-chevron-down');
			// Short timeout: a non-actionable row must fail fast. Playwright's 30s default
			// per click would let a handful of stale rows hang the whole capture past its
			// own timeout (this is what killed the document-symbols segment).
			if (twistie) await twistie.click({ timeout: 1500 }).catch(() => row.click({ timeout: 1500 }).catch(() => { }));
			else await row.click({ timeout: 1500 }).catch(() => { });
		}

		await win.waitForTimeout(400);
	}
}

/**
 * Collapse every sidebar panel except the one matching keepTitle (case-insensitive),
 * then ensure that panel is expanded.
 */
async function collapsePanelsExcept(win, keepTitle) {
	// Scope to .part.sidebar only — excludes hidden Output/Panel pane-headers
	const headers = win.locator('.part.sidebar .pane-header:not(.hidden)');
	const n = await headers.count();
	// Debug: log what we find so failures are diagnosable
	const found = [];
	for (let i = 0; i < n; i++) {
		const h = headers.nth(i);
		const text = await h.locator('.title').textContent().catch(() => '');
		const ariaExpanded = await h.getAttribute('aria-expanded');
		found.push(`"${text.trim()}" (expanded=${ariaExpanded})`);
		const titleUpper = text.trim().toUpperCase();
		const isExpanded = ariaExpanded === 'true';
		if (titleUpper === keepTitle.toUpperCase()) {
			if (!isExpanded) { await h.click(); await win.waitForTimeout(350); }
		} else {
			if (isExpanded) { await h.click(); await win.waitForTimeout(350); }
		}
	}
	console.log(`  panels found: ${found.join(', ')}`);
}

/**
 * Expand all collapsed tree rows inside containerSelector.
 * Repeats up to maxPasses until no collapsed rows remain.
 * Use this to make full Profile Results / Test Results trees visible.
 */
async function expandAllTreeItems(win, containerSelector = '.part.sidebar', maxPasses = 6) {
	return setAllTreeItemsExpanded(win, true, containerSelector, maxPasses);
}

/**
 * Open the dbt Anvil activity-bar container and wait until its sidebar panes appear.
 * This is more reliable than assuming the currently visible sidebar belongs to dbt Anvil.
 */
async function openDbtAnvilSidebar(win, timeout = 15000) {
	const iconSelectors = [
		'.activitybar .action-label[aria-label="dbt Anvil"]',
		'.activitybar li[aria-label="dbt Anvil"]',
		'.activitybar [title="dbt Anvil"]',
		'.composite-bar .action-label[aria-label="dbt Anvil"]',
		'.composite-bar [title="dbt Anvil"]',
	];

	const paneTitleLocator = win.locator('.part.sidebar .pane-header .title');
	const paneMatcher = /MODEL EXPLORER|TEST EXPLORER|TEST RESULTS|PROFILE RESULTS/i;
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		for (const sel of iconSelectors) {
			try {
				const icon = win.locator(sel).first();
				if (!(await icon.isVisible({ timeout: 1000 }))) continue;
				await icon.click();
				await win.waitForTimeout(350);

				const titles = await paneTitleLocator.allTextContents().catch(() => []);
				if (titles.some((title) => paneMatcher.test(title))) {
					return;
				}
			} catch { /* try next selector */ }
		}

		await win.waitForTimeout(500);
	}

	throw new Error('Could not open dbt Anvil sidebar');
}

// ─── Wait for extension to be fully ready ────────────────────────────────────
//
// Strategy:
//   1. Poll for the dbt Anvil activity bar icon (proves the extension registered)
//   2. Click it to open the sidebar
//   3. Wait for the Model Explorer to show tree items (proves the manifest was
//      loaded and the index was built — everything else is guaranteed ready)

// ─── Cursor & mouse helpers ──────────────────────────────────────────────────

/** Inject a visible circular cursor overlay that follows real mousemove events. */
async function initCustomCursor(win) {
	await win.evaluate(() => {
		if (document.getElementById('__demo-cursor__')) return;
		const cur = document.createElement('div');
		cur.id = '__demo-cursor__';
		Object.assign(cur.style, {
			position: 'fixed',
			width: '18px',
			height: '18px',
			borderRadius: '50%',
			background: 'rgba(255,255,255,0.88)',
			border: '2px solid rgba(0,0,0,0.55)',
			boxShadow: '0 1px 5px rgba(0,0,0,0.45)',
			pointerEvents: 'none',
			zIndex: '9999999',
			transform: 'translate(-50%,-50%)',
			// Start at screen centre so the first moveMouse() animates from a natural position
			left: (window.innerWidth / 2) + 'px',
			top: (window.innerHeight / 2) + 'px',
		});
		document.body.appendChild(cur);
		document.addEventListener('mousemove', (e) => {
			cur.style.left = e.clientX + 'px';
			cur.style.top = e.clientY + 'px';
		});
	});
}

async function removeCursor(win) {
	await win.evaluate(() => document.getElementById('__demo-cursor__')?.remove());
}

/**
 * Reset VS Code to the base demo layout:
 *   - Primary sidebar = dbt Anvil, only MODEL EXPLORER panel expanded
 *   - All editor tabs closed (middle column empty)
 *   - Bottom panel closed
 *   - Secondary sidebar (right column) closed
 *
 * This is the home state every segment starts from. Segments that need a
 * different panel (e.g. PROFILE RESULTS) expand it in their own PRE-DEMO setup.
 */
async function resetLayout(win) {
	// Close every open editor tab
	await runCommand(win, 'View: Close All Editors');
	// Close the bottom panel if it is open
	const panelOpen = await win.locator('.part.panel').isVisible({ timeout: 500 }).catch(() => false);
	if (panelOpen) {
		await win.keyboard.press('Control+J');
		// Wait for the panel animation to finish — Ctrl+J is a raw keypress with no palette confirmation
		await win.waitForSelector('.part.panel', { state: 'hidden', timeout: 2000 }).catch(() => { });
	}
	// The secondary side bar (built-in Chat) is kept hidden via the profile setting
	// workbench.secondarySideBar.defaultVisibility=hidden. Do NOT run a close command
	// here: when the bar is already hidden there is no "Close Secondary Side Bar" entry,
	// so the palette fuzzy-match falls through to "Toggle …", which reopens it.
	// Open dbt Anvil sidebar then collapse everything except MODEL EXPLORER
	await openDbtAnvilSidebar(win);
	await collapsePanelsExcept(win, 'MODEL EXPLORER');
}

/**
 * Return the screen {x, y} of a monaco editor token at the given line/column.
 * Returns null if the editor or position is not in the visible viewport.
 */
async function getTokenScreenPos(win, line, col) {
	return win.evaluate(({ l, c }) => {
		// Try window.monaco first (available in some VS Code builds)
		let editor = null;
		const monacoEditors = window.monaco?.editor?.getEditors?.() ?? [];
		editor = monacoEditors.find(e => e.getModel?.()) ?? monacoEditors[0] ?? null;

		if (editor) {
			const pos = editor.getScrolledVisiblePosition({ lineNumber: l, column: c });
			const rect = editor.getDomNode()?.getBoundingClientRect();
			if (pos && rect) return { x: Math.round(rect.left + pos.left), y: Math.round(rect.top + pos.top) };
		}

		// Reliable fallback: the Monaco cursor DOM element is absolutely positioned
		// at the caret location. Call goToLine(line, col) before this to place it.
		const cursor = document.querySelector('.monaco-editor .cursor');
		if (cursor) {
			const r = cursor.getBoundingClientRect();
			if (r.width > 0 || r.height > 0) {
				return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
			}
		}
		return null;
	}, { l: line, c: col });
}

async function moveMouse(win, x, y, steps = 20) {
	// Animate the cursor overlay visually (no real pointer events during the sweep
	// to avoid triggering unexpected hovers/focus changes across other UI elements).
	const cur = await win.evaluate(() => {
		const el = document.getElementById('__demo-cursor__');
		if (!el) return null;
		return { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
	});
	const fromX = cur?.x ?? x;
	const fromY = cur?.y ?? y;
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const ix = Math.round(fromX + (x - fromX) * t);
		const iy = Math.round(fromY + (y - fromY) * t);
		await win.evaluate(({ px, py }) => {
			const el = document.getElementById('__demo-cursor__');
			if (el) { el.style.left = px + 'px'; el.style.top = py + 'px'; }
		}, { px: ix, py: iy });
		await win.waitForTimeout(16); // ~60 fps
	}
	// Move the real pointer only once, at the final destination.
	await win.mouse.move(x, y);
}

// ─────────────────────────────────────────────────────────────────────────────

async function waitForExtensionReady(win) {
	console.log('Waiting for dbt Anvil activity bar icon...');

	const iconSelectors = [
		'.activitybar .action-label[aria-label="dbt Anvil"]',
		'.activitybar li[aria-label="dbt Anvil"]',
		'.activitybar [title="dbt Anvil"]',
		'.composite-bar .action-label[aria-label="dbt Anvil"]',
		'.composite-bar [title="dbt Anvil"]',
	];

	let foundSelector = null;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline && !foundSelector) {
		for (const sel of iconSelectors) {
			try {
				const el = win.locator(sel).first();
				if (await el.isVisible({ timeout: 1500 })) {
					foundSelector = sel;
					break;
				}
			} catch { /* try next */ }
		}
		if (!foundSelector) await win.waitForTimeout(2000);
	}

	if (!foundSelector) {
		console.warn('  Could not find activity bar icon — dumping visible aria-labels for debugging:');
		const labels = await win.$$eval('[aria-label]', els =>
			els.map(e => e.getAttribute('aria-label')).filter(Boolean).slice(0, 40)
		);
		console.warn(' ', labels.join(', '));
		console.warn('  Proceeding without clicking sidebar...');
	} else {
		console.log(`  Found icon via: ${foundSelector}`);
		await openDbtAnvilSidebar(win, 15000);
	}

	// Wait for the Model Explorer tree to populate with model items.
	// This is the definitive signal that the manifest is indexed and the
	// compile cache is warm — all hover/completion/definition features are ready.
	console.log('Waiting for Model Explorer to populate (manifest indexing)...');
	try {
		await win.waitForSelector(
			'.monaco-list-row[aria-label]',
			{ timeout: 120_000 },
		);
		const count = await win.locator('.monaco-list-row').count();
		console.log(`  Extension ready — ${count} items visible in tree.\n`);
	} catch {
		console.warn('  Model Explorer did not populate within 120s — proceeding anyway.\n');
	}
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
	sessionStartMs = Date.now();
	logEvent('session.start');
	console.log('\n=== dbt Anvil Demo Capture ===\n');
	console.log('Launching VS Code Insiders...');

	// VS Code Insiders checks for "updating_version" + "new_Code - Insiders.exe" on launch
	// and immediately exits to run the NSIS installer if present. Park these files for the
	// duration of the capture session and restore them in the finally block.
	// NOTE: The hash-named staging dirs (e.g. d63819fd8f/) are NOT renamed — they are
	// locked by the update service and can't be moved; parking the version file is enough.
	const vscodeDir = path.dirname(VSCODE_EXE);
	const parked = []; // { from, to }
	const parkFile = (filename) => {
		const from = path.join(vscodeDir, filename);
		// Skip already-parked files (e.g. from a previous crashed run)
		if (fs.existsSync(from + '.demo-bak')) return;
		if (fs.existsSync(from)) {
			fs.renameSync(from, from + '.demo-bak');
			parked.push({ from, to: from + '.demo-bak' });
		}
	};
	parkFile('updating_version');
	parkFile('new_Code - Insiders.exe');
	parkFile('new_Sessions - Insiders.exe');
	parkFile('new_Code - Insiders.VisualElementsManifest.xml');
	if (parked.length > 0) {
		console.log(`  (deferred VS Code auto-update: parked ${parked.length} item(s))`);
	}

	let app;
	let recordedVideoPath = null;
	let windowSize = null;
	// VS Code's integrated terminal injects env vars that break a spawned VS Code:
	// ELECTRON_RUN_AS_NODE makes it run as plain Node (rejects every flag as a
	// "bad option"), and the VSCODE_* hooks can tie the child to the parent instance.
	// Strip them so the capture works even when launched from inside VS Code.
	const sanitizedEnv = { ...process.env };
	delete sanitizedEnv.ELECTRON_RUN_AS_NODE;
	for (const k of Object.keys(sanitizedEnv)) {
		if (k.startsWith('VSCODE_') || k.startsWith('ELECTRON_') || k === 'CHROME_CRASHPAD_PIPE_NAME' || k === 'DISPLAY' || k === 'NODE_OPTIONS') { delete sanitizedEnv[k]; }
	}
	try {
		app = await electron.launch({
			executablePath: VSCODE_EXE,
			env: sanitizedEnv,
			args: [
				'--extensionDevelopmentPath=' + repoRoot,
				'--user-data-dir=' + userDataDir,
				'--disable-extensions',
				'--disable-workspace-trust',
				'--skip-release-notes',
				'--skip-welcome',
				`--window-size=${SCREEN.width},${SCREEN.height}`,
				sampleProject,
			],
			timeout: 60000,
			recordVideo: {
				dir: videoDir,
				size: { width: SCREEN.width, height: SCREEN.height },
			},
		});

		// Get the main workbench window
		// VS Code can surface a transient/blank window before the workbench, and
		// firstWindow() may latch onto the wrong one. Poll every open window for the
		// one that actually hosts the workbench.
		let win = null;
		const wbDeadline = Date.now() + 60000;
		while (Date.now() < wbDeadline && !win) {
			for (const w of app.windows()) {
				if (await w.locator('.monaco-workbench').count().catch(() => 0)) { win = w; break; }
			}
			if (!win) { await app.waitForEvent('window', { timeout: 2000 }).catch(() => { }); }
		}
		if (!win) { throw new Error('No VS Code window exposed .monaco-workbench within 60s'); }
		// Record how many ms elapsed before the first window appeared — the Playwright
		// video recording starts approximately here, so all seek times must be offset
		// by this amount to align event timestamps with the video file's timeline.
		videoStartOffsetMs = Date.now() - sessionStartMs;
		const recordedVideo = win.video();

		// Wait for workbench chrome to appear
		await win.waitForSelector('.monaco-workbench', { timeout: 45000 });
		// Maximize the window. On Windows the actual height is less than the recording
		// height (1080) because the taskbar is outside the BrowserWindow client area.
		const browserWindow = await app.browserWindow(win);
		await browserWindow.evaluate(bw => bw.maximize());
		await win.waitForTimeout(500);

		// Global sync flash: a full-white overlay that anchors the whole recording's
		// wall-clock→video offset. The renderer finds it in one linear showinfo pass. Force
		// a paint (double rAF) before logging and hold ~150ms so it reliably lands in the
		// video even if the renderer is busy at startup (see syncAndLogDemo for the same fix).
		await win.evaluate(() => new Promise((resolve) => {
			const el = document.createElement('div');
			el.id = '__demo-sync-flash__';
			Object.assign(el.style, {
				position: 'fixed', inset: '0',
				background: 'white',
				zIndex: '999999999',
				pointerEvents: 'none',
			});
			document.body.appendChild(el);
			requestAnimationFrame(() => requestAnimationFrame(resolve));
		}));
		logEvent('sync.flash');
		await win.waitForTimeout(150);
		await win.evaluate(() => document.getElementById('__demo-sync-flash__')?.remove());
		await win.waitForTimeout(100);
		const windowSize = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
		console.log(`VS Code loaded. Window: ${windowSize.width}×${windowSize.height}`);

		// Block until the extension is fully activated and the manifest is indexed
		await waitForExtensionReady(win);

		// Close bottom panel, output panel and dismiss all notifications
		try { await win.keyboard.press('Control+J'); await win.waitForTimeout(400); } catch { /* already closed */ }
		try { await runCommand(win, 'Notifications: Clear All Notifications'); } catch { /* none */ }
		try {
			// Close any floating notification toasts directly
			const closeButtons = win.locator('.notification-toast .codicon-notifications-clear');
			const count = await closeButtons.count();
			for (let i = 0; i < count; i++) await closeButtons.nth(i).click().catch(() => { });
		} catch { /* none */ }
		await win.waitForTimeout(400);

		if (stepFilter) console.log(`Running single step: "${stepFilter}" — skipping all others\n`);
		else console.log('Starting capture segments:\n');

		// ── Warm-up: pre-fill describe cache ─────────────────────────────────────
		// Open models bottom-up (leaf dependencies first) so that by the time we
		// open a model, its dependencies are already cached and describe is fast.
		// Skip if the persisted column-store already has enough entries (≥ warmup
		// file count) — avoids a multi-minute wait on repeated capture runs.
		const warmupFiles = [
			// Layer 0: raw/seed-adjacent (no dbt deps)
			'nba_teams.sql',
			'nba_raw_results.sql',
			'nba_raw_schedule.sql',
			'nba_raw_team_ratings.sql',
			'nba_random_num_gen.sql',
			// Layer 1: built on raws
			'nba_latest_results.sql',
			'nba_results_log.sql',
			'nba_schedules.sql',
			'nba_reg_season_actuals.sql',
			'nba_latest_elo.sql',
			'nba_results_by_team.sql',
			'nba_ratings.sql',
			// Layer 2
			'initialize_seeding.sql',
			'nba_elo_rollforward.sql',
			'nba_vegas_wins.sql',
			'reg_season_end.sql',
			// Layer 3
			'reg_season_simulator.sql',
			'reg_season_summary.sql',
			'playoff_sim_r1.sql',
			// Layer 4
			'playoff_sim_r2.sql',
			'playoff_sim_r3.sql',
			'playoff_sim_r4.sql',
			'playoff_summary.sql',
			// Top-level demo models
			'reg_season_actuals_enriched.sql',
			'reg_season_predictions.sql',
			'season_summary.sql',
		];

		// Check if describe cache is already warm by scanning the persisted
		// column-store.json in the demo user-data dir.
		function findColumnStore() {
			const wsStorage = path.join(userDataDir, 'User', 'workspaceStorage');
			if (!fs.existsSync(wsStorage)) return null;
			for (const hash of fs.readdirSync(wsStorage)) {
				const candidate = path.join(wsStorage, hash, 'nickeolofsson.dbt-anvil', 'column-store.json');
				if (fs.existsSync(candidate)) return candidate;
			}
			return null;
		}

		const columnStorePath = findColumnStore();
		let cacheWarm = false;
		if (columnStorePath) {
			try {
				const stored = JSON.parse(fs.readFileSync(columnStorePath, 'utf8'));
				const count = Object.keys(stored.columns ?? {}).length;
				cacheWarm = stored.version === 2 && count >= warmupFiles.length;
				console.log(`[warm-up] Column store found: ${count} entries (version ${stored.version}) — ${cacheWarm ? 'SKIPPING warm-up' : 'needs warm-up'}`);
			} catch {
				console.log('[warm-up] Column store unreadable — running warm-up');
			}
		} else {
			console.log('[warm-up] No column store found — running warm-up');
		}

		if (!cacheWarm && !stepFilter) {
			console.log('[warm-up] Filling describe cache (bottom-up)...');
			for (const f of warmupFiles) {
				// Non-fatal: a slow cold-cache enrichment must not abort the whole capture.
				// Segments enrich on demand and the cache persists for the next run.
				await openFile(win, f).catch(() => { });
				await waitForReady(win, 90000).catch(() => { });
			}
			await waitForReady(win, 120000).catch(() => { });
		}

		if (!stepFilter) {
			// Check for diagnostics errors — none allowed before proceeding.
			// A locked DuckDB or stale cache will show errors here; fail fast.
			console.log('  Checking for diagnostics errors...');
			const errorMarkers = await win.evaluate(() => {
				// monaco.editor.getModelMarkers({severity: MarkerSeverity.Error}) via globals
				const monaco = window.monaco;
				if (!monaco) return [];
				return monaco.editor.getModelMarkers({ severities: monaco.MarkerSeverity.Error })
					.map(m => `${m.resource?.path ?? '?'}:${m.startLineNumber} — ${m.message}`);
			}).catch(() => []);
			if (errorMarkers.length > 0) {
				console.error('\n  ✖ Errors found during warm-up — aborting capture:');
				for (const msg of errorMarkers) console.error(`    ${msg}`);
				throw new Error(`Warm-up found ${errorMarkers.length} error(s) — fix before capturing demo`);
			}
			console.log('  cache warm — no errors — proceeding\n');
		} // diagnostics check

		// ── 01: Model Explorer ────────────────────────────────────────────────────
		console.log('[01] Model Explorer');
		markSegmentStart('model-explorer');
		if (shouldRun('model-explorer')) try {
			// PRE-DEMO
			await resetLayout(win);
			// Expand top-level folders (Models, Sources) — single pass avoids over-expanding
			await setAllTreeItemsExpanded(win, true, '.part.sidebar', 1);
			// DEMO
			await syncAndLogDemo(win, 'model-explorer.demo');
			await flashPaneHighlight(win, 'MODEL EXPLORER');
			await screenshot(win, 'model-explorer', 'Model Explorer — Models · Sources · By Tag', 3500);
			logEvent('model-explorer.post-demo');
			// POST-DEMO
			await removeHighlight(win);
		} catch (e) {
			console.warn(`  ⚠ model-explorer: ${e.message}`);
		}
		markSegmentEnd('model-explorer');

		// ── 02: CodeLens ─────────────────────────────────────────────────────────
		console.log('[02] CodeLens');
		markSegmentStart('codelens');
		if (shouldRun('codelens')) try {
			// PRE-DEMO
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await goToLine(win, 1);
			await waitForReady(win, 30000);
			await win.waitForSelector('.codelens-decoration a', { timeout: 20000 });
			// DEMO
			await syncAndLogDemo(win, 'codelens.demo');
			await flashHighlight(win, '.editor-actions');
			await screenshot(win, 'codelens', 'CodeLens — Run · Build · Test · Compile · Profile', 3000);
			logEvent('codelens.post-demo');
			// POST-DEMO
			await removeHighlight(win);
		} catch (e) {
			console.warn(`  ⚠ codelens: ${e.message}`);
		}
		markSegmentEnd('codelens');

		// ── 03: Hover on ref() ───────────────────────────────────────────────────
		console.log('[03] Hover on ref()');
		markSegmentStart('hover-ref');
		if (shouldRun('hover-ref')) try {
			// PRE-DEMO: reset layout, open file, position editor cursor — no video yet
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await waitForReady(win, 60000);
			await goToLine(win, 6, 30);
			// Inject cursor overlay (starts at screen centre) and animate to token
			await initCustomCursor(win);
			const posHoverRef = await getTokenScreenPos(win, 6, 30);
			if (!posHoverRef) throw new Error('getTokenScreenPos returned null for line 6 col 30');
			console.log(`  hover-ref token pos: ${posHoverRef.x},${posHoverRef.y}`);
			// DEMO: cursor sweep is part of the demo
			await syncAndLogDemo(win, 'hover-ref.demo');
			await moveMouse(win, posHoverRef.x, posHoverRef.y, 30);
			await win.mouse.move(posHoverRef.x, posHoverRef.y);
			await win.waitForSelector('.monaco-hover', { state: 'visible', timeout: 15000 });
			await win.waitForTimeout(1200);
			await screenshot(win, 'hover-ref', 'Hover — model preview with columns & description', 3500);
			logEvent('hover-ref.post-demo');
			// POST-DEMO: cleanup (outside video clip window)
			await pressEscape(win);
			await removeCursor(win);
		} catch (e) {
			console.warn(`  ⚠ hover-ref: ${e.message}`);
		}
		markSegmentEnd('hover-ref');

		// ── 04: Hover on column name ─────────────────────────────────────────────
		console.log('[04] Hover on column');
		markSegmentStart('hover-column');
		if (shouldRun('hover-column')) try {
			// PRE-DEMO
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await waitForReady(win, 30000);
			await goToLine(win, 89, 16);
			await initCustomCursor(win);
			const posHoverCol = await getTokenScreenPos(win, 89, 16);
			if (!posHoverCol) throw new Error('getTokenScreenPos returned null for line 89 col 16');
			console.log(`  hover-column token pos: ${posHoverCol.x},${posHoverCol.y}`);
			// DEMO: cursor sweep is part of the demo
			await syncAndLogDemo(win, 'hover-column.demo');
			await moveMouse(win, posHoverCol.x, posHoverCol.y, 30);
			await win.mouse.move(posHoverCol.x, posHoverCol.y);
			await win.waitForSelector('.monaco-hover', { state: 'visible', timeout: 15000 });
			await win.waitForTimeout(1200);
			await screenshot(win, 'hover-column', 'Column Intelligence — type, origin CTE & lineage', 3500);
			logEvent('hover-column.post-demo');
			// POST-DEMO
			await pressEscape(win);
			await removeCursor(win);
		} catch (e) {
			console.warn(`  ⚠ hover-column: ${e.message}`);
		}
		markSegmentEnd('hover-column');

		// ── 05: Completion inside ref('...') ─────────────────────────────────────
		console.log('[05] Completion');
		markSegmentStart('completion');
		if (shouldRun('completion')) try {
			// PRE-DEMO
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await win.keyboard.press('Control+End');
			await win.waitForTimeout(400);
			await initCustomCursor(win);
			// DEMO — cursor starts at screen centre, typing will happen at end of file
			await syncAndLogDemo(win, 'completion.demo');
			await win.keyboard.press('Enter');
			await win.keyboard.type("{{ ref('", TYPE_DELAY);
			await win.waitForTimeout(600);
			const suggestVisible = await win.locator('.editor-widget.suggest-widget').isVisible().catch(() => false);
			if (!suggestVisible) {
				await win.keyboard.press('Control+Space');
				await win.waitForTimeout(800);
			}
			await win.waitForSelector('.editor-widget.suggest-widget', { timeout: 8000 });
			await win.waitForTimeout(600);
			await screenshot(win, 'completion', 'Completion — all models available inside ref()', 3500);
			logEvent('completion.post-demo');
			// POST-DEMO
			await pressEscape(win);
			await runCommand(win, 'File: Revert File');
			await win.waitForTimeout(400);
			await removeCursor(win);
		} catch (e) {
			console.warn(`  ⚠ completion: ${e.message}`);
		}
		markSegmentEnd('completion');

		// ── 06: Rename Symbol (moved here so video plays before diagnostics) ─────
		console.log('[06] Rename Symbol');
		markSegmentStart('rename-symbol');
		if (shouldRun('rename-symbol')) try {
			// PRE-DEMO
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await goToLine(win, 4, 5);
			await initCustomCursor(win);
			// Animate cursor from centre to the CTE name token
			const posRename = await getTokenScreenPos(win, 4, 5);
			// DEMO: cursor sweep is part of the demo
			await syncAndLogDemo(win, 'rename-symbol.demo');
			if (posRename) await moveMouse(win, posRename.x, posRename.y, 30);
			await win.keyboard.press('F2');
			const renameInput = win.locator('.rename-box input, .rename-box .rename-input').first();
			await renameInput.waitFor({ state: 'attached', timeout: 8000 });
			await win.evaluate(() => {
				const inp = document.querySelector('.rename-box input, .rename-box .rename-input');
				if (inp) inp.focus();
			});
			await win.keyboard.press('Control+A');
			await win.waitForTimeout(200);
			// Type the new name so viewers see the rename in action
			await win.keyboard.type('cte_recent_wins', { delay: 60 });
			await win.waitForTimeout(500);
			await win.keyboard.press('Enter');
			await win.waitForTimeout(900);
			await screenshot(win, 'rename-symbol', 'Rename Symbol — renames CTE across all references', 3000);
			logEvent('rename-symbol.post-demo');
			// POST-DEMO
			await removeCursor(win);
			await runCommand(win, 'File: Revert File');
			await win.waitForTimeout(400);
		} catch (e) {
			console.warn(`  ⚠ rename-symbol: ${e.message}`);
		}
		markSegmentEnd('rename-symbol');

		// ── 07: Diagnostics — live ref() edit ──────────────────────────────────
		console.log('[07] Diagnostics');
		markSegmentStart('diagnostics');
		if (shouldRun('diagnostics')) try {
			// PRE-DEMO: reset, open Problems panel first, then open file
			await resetLayout(win);
			// Ctrl+Shift+M is a direct key (no command palette) — safe in pre-demo
			await win.keyboard.press('Control+Shift+M');
			await win.waitForSelector('.part.panel', { state: 'visible', timeout: 3000 }).catch(() => { });
			await openFile(win, 'season_summary.sql');
			// Manifest must be loaded before the unknown-ref check can fire.
			await waitForReady(win, 90000);
			await goToLine(win, 20, 22);
			await initCustomCursor(win);
			const posDiag = await getTokenScreenPos(win, 20, 22);
			// DEMO: cursor sweep is part of the demo
			await syncAndLogDemo(win, 'diagnostics.demo');
			if (posDiag) await moveMouse(win, posDiag.x, posDiag.y, 20);
			if (posDiag) {
				await win.waitForTimeout(200);
				await win.mouse.dblclick(posDiag.x, posDiag.y);
			} else {
				await win.keyboard.press('Control+Shift+ArrowRight');
			}
			await win.waitForTimeout(300);
			await win.keyboard.type('zzz_missing_model', TYPE_DELAY);
			// Hover the broken ref until its "Model not found" tooltip appears — that's the
			// focus, not the workspace-noisy Problems panel. The diagnostic is a fast
			// manifest lookup, so poll (re-hovering to refresh the tooltip) and screenshot
			// exactly when the error shows, instead of waiting on a fixed timeout.
			const hoverPos = await getTokenScreenPos(win, 20, 22);
			if (hoverPos) await moveMouse(win, hoverPos.x, hoverPos.y, 20);
			let hoverErr = false;
			for (let i = 0; i < 8 && !hoverErr; i++) {
				if (hoverPos) {
					await win.mouse.move(hoverPos.x + (i % 2), hoverPos.y);
					await win.mouse.move(hoverPos.x, hoverPos.y);
				}
				await win.waitForTimeout(1200);
				hoverErr = await win.evaluate(() =>
					/not found|unknown.ref|does not exist/i.test(document.querySelector('.monaco-hover')?.textContent || ''));
			}
			await win.waitForTimeout(800);
			await screenshot(win, 'diagnostics', 'Diagnostics — unknown ref() flagged in real time', 3500);
			logEvent('diagnostics.post-demo');
			// POST-DEMO
			await removeCursor(win);
			await runCommand(win, 'File: Revert File');
			await win.waitForTimeout(400);
		} catch (e) {
			console.warn(`  ⚠ diagnostics: ${e.message}`);
		}
		markSegmentEnd('diagnostics');

		// ── 08: Document Symbols / Outline ──────────────────────────────────────
		console.log('[08] Document Symbols');
		markSegmentStart('document-symbols');
		if (shouldRun('document-symbols')) try {
			// PRE-DEMO: focus the Outline FIRST so the collapse/expand act on the Explorer
			// sidebar (where the Outline lives), not the dbt Anvil sidebar. Collapsing the
			// file-tree + Timeline panes afterwards makes the CTE outline fill the sidebar.
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await runCommand(win, 'View: Focus Outline');
			await win.waitForSelector('.outline-element', { timeout: 8000 });
			await collapsePanelsExcept(win, 'OUTLINE');
			await setAllTreeItemsExpanded(win, true, '.part.sidebar', 4);
			// DEMO
			await syncAndLogDemo(win, 'document-symbols.demo');
			await flashPaneHighlight(win, 'OUTLINE');
			await screenshot(win, 'document-symbols', 'Outline — CTE tree with columns in every scope', 3000);
			logEvent('document-symbols.post-demo');
			// POST-DEMO
			await removeHighlight(win);
		} catch (e) {
			console.warn(`  ⚠ document-symbols: ${e.message}`);
		}
		markSegmentEnd('document-symbols');

		// ── 09: Go to Definition ─────────────────────────────────────────────────
		console.log('[09] Go to Definition');
		markSegmentStart('go-to-definition');
		if (shouldRun('go-to-definition')) try {
			// PRE-DEMO
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await goToLine(win, 92, 18);
			await initCustomCursor(win);
			// DEMO: two jumps — first a column → its CTE definition (same file), then a
			// ref() → the referenced model's own .sql file.
			await syncAndLogDemo(win, 'go-to-definition.demo');
			const ctrlClick = async (pos) => {
				await moveMouse(win, pos.x, pos.y, 30);
				await win.waitForTimeout(300);
				await win.keyboard.down('Control'); // VS Code shows the clickable underline
				await win.waitForTimeout(600);
				await win.mouse.click(pos.x, pos.y);
				await win.keyboard.up('Control');
			};
			const posCol = await getTokenScreenPos(win, 92, 18);
			if (posCol) { await ctrlClick(posCol); } else { await win.keyboard.press('F12'); }
			await win.waitForTimeout(1800);
			// jump 2 — a ref() opens that model's file
			await goToLine(win, 6, 30);
			const posRef = await getTokenScreenPos(win, 6, 30);
			if (posRef) { await ctrlClick(posRef); }
			await win.waitForTimeout(2200);
			await screenshot(win, 'go-to-definition', 'Go to Definition — column → its CTE, ref() → its model', 3000);
			logEvent('go-to-definition.post-demo');
			// POST-DEMO
			await removeCursor(win);
			await closeEditor(win);
		} catch (e) {
			console.warn(`  ⚠ go-to-definition: ${e.message}`);
		}
		markSegmentEnd('go-to-definition');

		// ── 10: Find All References ───────────────────────────────────────────────
		console.log('[10] Find All References');
		markSegmentStart('find-all-references');
		if (shouldRun('find-all-references')) try {
			// PRE-DEMO
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await goToLine(win, 6, 30);
			await initCustomCursor(win);
			const posFar = await getTokenScreenPos(win, 6, 30);
			// DEMO: cursor sweep is part of the demo
			await syncAndLogDemo(win, 'find-all-references.demo');
			if (posFar) await moveMouse(win, posFar.x, posFar.y, 25);
			await win.keyboard.press('Shift+F12');
			await win.waitForTimeout(3000);
			await screenshot(win, 'find-all-references', 'Find All References — all models using this source', 4000);
			logEvent('find-all-references.post-demo');
			// POST-DEMO
			await removeCursor(win);
			await pressEscape(win);
		} catch (e) {
			console.warn(`  ⚠ find-all-references: ${e.message}`);
		}
		markSegmentEnd('find-all-references');

		// ── 09: Call Hierarchy ───────────────────────────────────────────────────
		console.log('[11] Call Hierarchy');
		markSegmentStart('call-hierarchy');
		if (shouldRun('call-hierarchy')) try {
			// PRE-DEMO: open a mid-DAG model DIRECTLY and put the cursor on the model body
			// (line 1, 'with' — NOT on a ref) so the hierarchy roots on THIS model. reg_season_end
			// has three models that call it and refs its own upstream, so both directions are real.
			await resetLayout(win);
			await openFile(win, 'reg_season_end.sql');
			await win.click('.monaco-editor .view-lines');
			await goToLine(win, 1, 1);
			// DEMO: incoming calls (models that ref reg_season_end) first, then toggle to
			// outgoing (models reg_season_end refs) so both directions show over the clip.
			await syncAndLogDemo(win, 'call-hierarchy.demo');
			await win.keyboard.press('Shift+Alt+H');
			await waitForReady(win, 15000).catch(() => { });
			await win.waitForTimeout(1500);
			// Switch call direction by toolbar button (fall back to the command), then expand.
			const showCalls = async (label, command) => {
				const btn = win.locator(`[aria-label="${label}"]`).first();
				if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) await btn.click();
				else await runCommand(win, command).catch(() => { });
				await win.waitForTimeout(1000);
				await setAllTreeItemsExpanded(win, true, '.part.panel', 3);
				await setAllTreeItemsExpanded(win, true, '.part.sidebar', 3);
			};
			// INCOMING first — models that ref reg_season_end (its callers). The default view
			// lands on outgoing, so switch to incoming explicitly and hold so it reads in the clip.
			await showCalls('Show Incoming Calls', 'Calls: Show Incoming Calls');
			await win.waitForTimeout(2500);
			// Re-focus the root row so the OUTGOING toggle pivots on reg_season_end — the deep
			// incoming expansion leaves a descendant focused, and the toggle follows focus.
			await win.locator('.monaco-list-row', { hasText: /reg_season_end/ }).first().click({ timeout: 2000 }).catch(() => { });
			await win.waitForTimeout(500);
			// OUTGOING — models reg_season_end refs (its callees).
			await showCalls('Show Outgoing Calls', 'Calls: Show Outgoing Calls');
			await win.waitForTimeout(1500);
			await screenshot(win, 'call-hierarchy', 'Call Hierarchy — models that call this one, and the models it calls', 4000);
			logEvent('call-hierarchy.post-demo');
			// POST-DEMO
			await pressEscape(win);
		} catch (e) {
			console.warn(`  ⚠ call-hierarchy: ${e.message}`);
		}
		markSegmentEnd('call-hierarchy');

		// ── 12: Workspace Symbol Search ──────────────────────────────────────────
		console.log('[12] Workspace Symbols');
		markSegmentStart('workspace-symbols');
		if (shouldRun('workspace-symbols')) try {
			// PRE-DEMO
			await resetLayout(win);
			// DEMO
			await syncAndLogDemo(win, 'workspace-symbols.demo');
			await win.keyboard.press('Control+T');
			await win.waitForSelector('.quick-input-widget input', { state: 'visible', timeout: 3000 });
			await win.keyboard.type('nba_team', TYPE_DELAY);
			await win.waitForSelector('.quick-input-list .monaco-list-row', { timeout: 6000 });
			await screenshot(win, 'workspace-symbols', 'Workspace Symbols (Ctrl+T) — search all models', 3000);
			logEvent('workspace-symbols.post-demo');
			// POST-DEMO
			await pressEscape(win);
		} catch (e) {
			console.warn(`  ⚠ workspace-symbols: ${e.message}`);
		}
		markSegmentEnd('workspace-symbols');

		// ── 13: Lineage Graph + Column Lineage (combined) ───────────────────────
		console.log('[13] Lineage');
		markSegmentStart('lineage');
		if (shouldRun('lineage')) try {
			// PRE-DEMO: open file, show lineage, fit, wait for enrichment. The panel stays at
			// its normal docked size — the graph fits well there; maximizing it just shrank the
			// cards inside a big empty frame.
			await resetLayout(win);
			await openFile(win, 'season_summary.sql');
			await runCommand(win, 'dbt Anvil: Show Lineage');
			await waitForReady(win, 30000).catch(() => { });
			// Wait for the lineage webview to actually mount instead of a blanket 5s —
			// returns as soon as #canvas-wrap exists, falls through after ~15s to the
			// existing fit/col-toggle checks below.
			for (let i = 0; i < 30; i++) {
				if (await findWebviewFrame(win, '#canvas-wrap')) break;
				await win.waitForTimeout(500);
			}
			const lineageFrame = await findWebviewFrame(win, '#canvas-wrap');
			if (!lineageFrame) throw new Error('Lineage webview frame not found');
			await lineageFrame.evaluate(() => document.getElementById('fit-btn')?.click());
			await win.waitForTimeout(1500);
			// Wait for column enrichment (col-toggle buttons appear on cards)
			let toggleVisible = false;
			for (let i = 0; i < 20; i++) {
				toggleVisible = await lineageFrame.evaluate(() => !!document.querySelector('.col-toggle'));
				if (toggleVisible) break;
				await win.waitForTimeout(1000);
			}
			if (!toggleVisible) throw new Error('No .col-toggle appeared');
			// Get screen positions of col-toggle and first col-item on the focus card
			const toggleBbox = await lineageFrame.locator('.card.focus .col-toggle').boundingBox();
			if (!toggleBbox) throw new Error('Focus card col-toggle not found');
			const togglePos = { x: toggleBbox.x + toggleBbox.width / 2, y: toggleBbox.y + toggleBbox.height / 2 };
			// DEMO: cursor sweeps in, expands columns, then clicks a column
			await initCustomCursor(win);
			await syncAndLogDemo(win, 'lineage.demo');
			await moveMouse(win, togglePos.x, togglePos.y, 30);
			await win.mouse.click(togglePos.x, togglePos.y);
			await win.waitForTimeout(1500);
			// Get position of first column item after expansion
			const colBbox = await lineageFrame.locator('.card.focus .col-item').first().boundingBox();
			if (!colBbox) throw new Error('Focus card .col-item not found after expansion');
			const colPos = { x: colBbox.x + colBbox.width / 2, y: colBbox.y + colBbox.height / 2 };
			const colName = await lineageFrame.locator('.card.focus .col-item').first().getAttribute('data-col');
			console.log(`  → tracing column: ${colName ?? '(unknown)'}`);
			await moveMouse(win, colPos.x, colPos.y, 20);
			await win.mouse.click(colPos.x, colPos.y);
			await waitForReady(win, 30000).catch(() => { });
			await win.waitForTimeout(2000);
			await flashHighlight(win, '.part.panel');
			await screenshot(win, 'lineage', 'Lineage Graph & Column Lineage — interactive DAG', 5000);
			logEvent('lineage.post-demo');
			// POST-DEMO
			await removeHighlight(win);
			await removeCursor(win);
		} catch (e) {
			console.warn(`  ⚠ lineage: ${e.message}`);
		}
		markSegmentEnd('lineage');

		// Close the bottom panel — don't let it distract subsequent frames
		await win.keyboard.press('Control+J');
		await win.waitForTimeout(400);

		// ── 15: Profiler ─────────────────────────────────────────────────────────
		// The Playwright session video naturally records the profiler running.
		// The screenshot captures the finished state with the full tree expanded.
		console.log('[15] Profiler');
		markSegmentStart('profiler');
		if (shouldRun('profiler')) try {
			// PRE-DEMO: reset layout, open file, keep only the PROFILE RESULTS pane.
			// Do NOT collapse the tree here — profiling populates it and we want it shown.
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await collapsePanelsExcept(win, 'PROFILE RESULTS');
			await goToLine(win, 1);
			await waitForReady(win, 30000);
			const profileBtn = win.locator('.editor-actions [aria-label="Profile Model"]');
			await profileBtn.waitFor({ state: 'visible', timeout: 20000 });
			const profileBbox = await profileBtn.boundingBox();
			if (!profileBbox) throw new Error('Profile Model button not found');
			const profilePos = { x: profileBbox.x + profileBbox.width / 2, y: profileBbox.y + profileBbox.height / 2 };
			await initCustomCursor(win);
			// DEMO: cursor sweeps to the Profile Model editor title button and clicks
			await syncAndLogDemo(win, 'profiler.demo');
			await moveMouse(win, profilePos.x, profilePos.y, 30);
			await profileBtn.click();

			await flashPaneHighlight(win, 'PROFILE RESULTS');
			// Profiling runs against DuckDB on a direct connection (no "dbt: db query"
			// status) and re-renders the tree as rows land — which invalidates element
			// handles. So poll the row count via page.evaluate (handle-safe) until it
			// stabilises, wrapping each expand in try/catch. Never collapse the tree —
			// collapsing it is what hid the results.
			let prevRows = -1, stable = 0;
			for (let i = 0; i < 90 && stable < 4; i++) {
				await win.waitForTimeout(1000);
				try { await expandAllTreeItems(win, '.part.sidebar'); } catch { /* tree mid-render */ }
				let rows = 0;
				try { rows = await win.evaluate(() => document.querySelectorAll('.part.sidebar .monaco-list-row').length); } catch { /* */ }
				stable = (rows === prevRows && rows > 5) ? stable + 1 : 0;
				prevRows = rows;
			}
			logEvent('profiler.ready');
			try { await expandAllTreeItems(win, '.part.sidebar'); } catch { /* */ }
			await win.waitForTimeout(400);
			await removeHighlight(win);

			await flashPaneHighlight(win, 'PROFILE RESULTS');
			await screenshot(win, 'profiler', 'Profiler — per-CTE row counts & timing', 4000);
			logEvent('profiler.post-demo');
			await removeHighlight(win);
			await removeCursor(win);
		} catch (e) {
			console.warn(`  ⚠ profiler: ${e.message}`);
		}
		markSegmentEnd('profiler');

		// ── 16: Query Results ────────────────────────────────────────────────────
		console.log('[16] Query Results');
		markSegmentStart('query-results');
		if (shouldRun('query-results')) try {
			// PRE-DEMO: open analysis query.sql, position on the query line
			await resetLayout(win);
			await openFile(win, 'query.sql');
			await goToLine(win, 2, 1);
			await initCustomCursor(win);
			// DEMO: run the statement at cursor via the Execute Query command (noDebug run).
			// NOT F5 — F5 is VS Code's Start Debugging and launches the CTE stepping debugger,
			// not a run. Execute Query is dbt-anvil.executeQuery, which runs and shows the grid.
			await syncAndLogDemo(win, 'query-results.demo');
			await runCommand(win, 'Execute Query');
			// executeQuery runs via the debug adapter in noDebug mode and does NOT set a
			// "dbt: db query" status, so poll for the result-grid webview to appear instead
			// of waiting on the status bar.
			let resultsFrame = null;
			for (let i = 0; i < 60 && !resultsFrame; i++) {
				await win.waitForTimeout(1000);
				resultsFrame = await findWebviewFrame(win, 'td[data-col]').catch(() => null);
			}
			if (resultsFrame) {
				const firstCell = resultsFrame.locator('td[data-col]').first();
				await firstCell.waitFor({ state: 'visible', timeout: 8000 });
				// Determine which row/col values are present, excluding gutter (row-num) cells
				const rowValues = await resultsFrame.evaluate(() => {
					const rows = new Set();
					for (const td of document.querySelectorAll('td[data-row]:not(.row-num)')) {
						rows.add(Number(td.getAttribute('data-row')));
					}
					return [...rows].sort((a, b) => a - b);
				});
				const colValues = await resultsFrame.evaluate(() => {
					const cols = new Set();
					for (const td of document.querySelectorAll('td[data-col]:not(.row-num)')) {
						cols.add(Number(td.getAttribute('data-col')));
					}
					return [...cols].sort((a, b) => a - b);
				});
				const topLeftRow = rowValues[0];
				const topLeftCol = colValues[0];
				const bottomRightRow = rowValues[Math.min(2, rowValues.length - 1)];
				const bottomRightCol = colValues[Math.min(3, colValues.length - 1)];
				const topLeft = resultsFrame.locator(`td[data-row="${topLeftRow}"][data-col="${topLeftCol}"]:not(.row-num)`).first();
				const bottomRight = resultsFrame.locator(`td[data-row="${bottomRightRow}"][data-col="${bottomRightCol}"]:not(.row-num)`).first();
				const tlBbox = await topLeft.boundingBox();
				const brBbox = await bottomRight.boundingBox();
				if (tlBbox && brBbox) {
					const p1 = { x: tlBbox.x + tlBbox.width / 2, y: tlBbox.y + tlBbox.height / 2 };
					const p2 = { x: brBbox.x + brBbox.width / 2, y: brBbox.y + brBbox.height / 2 };
					// Click-drag from top-left to bottom-right to select 4 cols × 3 rows
					await moveMouse(win, p1.x, p1.y, 20);
					await win.mouse.down();
					await moveMouse(win, p2.x, p2.y, 30);
					await win.mouse.up();
					await win.waitForTimeout(400);
				}
			}
			await win.waitForTimeout(500);
			// Click "Move Query Results to Panel"
			const moveToPanelBtn = win.locator('[aria-label="Move Query Results to Panel"]');
			if (await moveToPanelBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
				const moveBbox = await moveToPanelBtn.boundingBox();
				if (moveBbox) {
					const mp = { x: moveBbox.x + moveBbox.width / 2, y: moveBbox.y + moveBbox.height / 2 };
					await moveMouse(win, mp.x, mp.y, 20);
					await win.mouse.click(mp.x, mp.y);
					await win.waitForTimeout(1000);
				}
			}
			// Click "Toggle Column Stats"
			const toggleStatsBtn = win.locator('[aria-label="Toggle Column Stats"]');
			if (await toggleStatsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
				const tsBbox = await toggleStatsBtn.boundingBox();
				if (tsBbox) {
					const tp = { x: tsBbox.x + tsBbox.width / 2, y: tsBbox.y + tsBbox.height / 2 };
					await moveMouse(win, tp.x, tp.y, 20);
					await win.mouse.click(tp.x, tp.y);
					await win.waitForTimeout(1000);
				}
			}
			await screenshot(win, 'query-results', 'Query Results — run SQL, get results right here. Your editor is the query tool.', 4000);
			logEvent('query-results.post-demo');
			// POST-DEMO
			await removeCursor(win);
		} catch (e) {
			console.warn(`  ⚠ query-results: ${e.message}`);
		}
		markSegmentEnd('query-results');

		// ── 17: Query Model ───────────────────────────────────────────────────────
		console.log('[17] Query Model');
		markSegmentStart('query-model');
		if (shouldRun('query-model')) try {
			// PRE-DEMO: open file, wait for codelens to settle
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await goToLine(win, 1);
			await waitForReady(win, 30000);
			await win.waitForSelector('.codelens-decoration a', { timeout: 20000 });
			const queryModelBtn = win.locator('.editor-actions [aria-label="Query Model"]');
			await queryModelBtn.waitFor({ state: 'visible', timeout: 10000 });
			const queryModelBbox = await queryModelBtn.boundingBox();
			if (!queryModelBbox) throw new Error('Query Model button not found');
			const queryModelPos = { x: queryModelBbox.x + queryModelBbox.width / 2, y: queryModelBbox.y + queryModelBbox.height / 2 };
			await initCustomCursor(win);
			// DEMO: cursor sweeps to editor title button and clicks
			await syncAndLogDemo(win, 'query-model.demo');
			await moveMouse(win, queryModelPos.x, queryModelPos.y, 30);
			await queryModelBtn.click();
			// Wait for the result-grid webview (the db-query status is unreliable / too fast).
			let qmFrame = null;
			for (let i = 0; i < 60 && !qmFrame; i++) {
				await win.waitForTimeout(1000);
				qmFrame = await findWebviewFrame(win, 'td[data-col]').catch(() => null);
			}
			await win.waitForTimeout(1000);
			await screenshot(win, 'query-model', 'Query Model — compile & run the full model', 4000);
			logEvent('query-model.post-demo');
			// POST-DEMO
			await removeCursor(win);
		} catch (e) {
			console.warn(`  ⚠ query-model: ${e.message}`);
		}
		markSegmentEnd('query-model');

		// ── 18: Query CTE ─────────────────────────────────────────────────────────
		console.log('[18] Query CTE');
		markSegmentStart('query-cte');
		if (shouldRun('query-cte')) try {
			// PRE-DEMO: open file, wait for Query CTE codelens to appear on CTE lines
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await goToLine(win, 1);
			await waitForReady(win, 30000);
			const queryCteLens = win.locator('.codelens-decoration a', { hasText: 'Query CTE' }).first();
			await queryCteLens.waitFor({ state: 'visible', timeout: 20000 });
			const queryCteBbox = await queryCteLens.boundingBox();
			if (!queryCteBbox) throw new Error('Query CTE codelens not found');
			const queryCtePos = { x: queryCteBbox.x + queryCteBbox.width / 2, y: queryCteBbox.y + queryCteBbox.height / 2 };
			await initCustomCursor(win);
			// DEMO: cursor sweeps to the Query CTE codelens and clicks
			await syncAndLogDemo(win, 'query-cte.demo');
			await moveMouse(win, queryCtePos.x, queryCtePos.y, 30);
			await queryCteLens.click();
			let qcFrame = null;
			for (let i = 0; i < 60 && !qcFrame; i++) {
				await win.waitForTimeout(1000);
				qcFrame = await findWebviewFrame(win, 'td[data-col]').catch(() => null);
			}
			await win.waitForTimeout(1000);
			await screenshot(win, 'query-cte', 'Query CTE — run a single CTE in isolation', 4000);
			logEvent('query-cte.post-demo');
			// POST-DEMO
			await removeCursor(win);
		} catch (e) {
			console.warn(`  ⚠ query-cte: ${e.message}`);
		}
		markSegmentEnd('query-cte');


		// ── Done — write config and close ────────────────────────────────────────
		console.log('\nCapture complete. Closing VS Code...');
		logEvent('session.closing');
		await app.close();
		recordedVideoPath = recordedVideo ? await recordedVideo.path().catch(() => null) : null;
		logEvent('session.closed');

	} finally {
		// Restore all parked update files/dirs so VS Code can apply the update on next normal launch
		for (const { from, to } of parked) {
			if (fs.existsSync(to)) fs.renameSync(to, from);
		}
	}

	logEvent('session.end');

	const videoFile = (() => {
		if (recordedVideoPath) return path.relative(repoRoot, recordedVideoPath).replaceAll('\\\\', '/');
		const candidates = fs.existsSync(videoDir)
			? fs.readdirSync(videoDir)
				.filter(f => f.endsWith('.webm'))
				.map(f => path.join(videoDir, f))
				.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
			: [];
		if (candidates.length === 0) return null;
		return path.relative(repoRoot, candidates[0]).replaceAll('\\\\', '/');
	})();

	const recording = {
		capturedAt: new Date().toISOString(),
		videoFile,
		videoStartOffsetMs,
		windowSize,
		events,
		frames,
	};

	fs.writeFileSync(recordingOut, JSON.stringify(recording, null, 2));
	console.log(`\nWrote recording log to ${recordingOut}`);
	console.log(`Screenshots in: ${framesDir}`);
	console.log(`Video in:       ${videoDir}`);
	console.log('\nNext: npm run demo:generate -- --config scripts/demo/rendering-config-gif.json');
}

main().catch(err => {
	console.error('\nCapture failed:', err);
	process.exit(1);
});
