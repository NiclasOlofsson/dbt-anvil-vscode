/**
 * capture-demo.mjs
 *
 * Launches VS Code with the dbt Studio extension loaded against the nba-monte-carlo
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const sampleProject = path.join(repoRoot, 'samples', 'nba-monte-carlo');
const framesDir = path.join(repoRoot, 'temp_auto', 'demo-frames');
const videoDir = path.join(repoRoot, 'temp_auto', 'demo-video');
const userDataDir = path.join(repoRoot, 'temp_auto', 'demo-userdata');
const recordingOut = path.join(repoRoot, 'temp_auto', 'demo-recording.json');

// --step <segment-id>  run only that one segment; omit for a full capture
// e.g.  npm run demo:capture -- --step profiler
const stepArgIdx = process.argv.indexOf('--step');
const stepFilter = stepArgIdx !== -1 ? process.argv[stepArgIdx + 1] : null;
const shouldRun = (id) => !stepFilter || stepFilter === id;

// VS Code Insiders executable — primary path on this machine
const VSCODE_EXE = 'C:\\Users\\Niclas.Olofsson\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe';

// Delay between keystrokes when typing via keyboard.type(). 1ms = effectively instant
// but still fires individual key events (needed for VS Code quick-open fuzzy matching).
const TYPE_DELAY = { delay: 1 };

// Model paths that make great demo targets
const MODEL = {
	enriched: path.join(sampleProject, 'models', 'nba', 'analysis', 'reg_season_actuals_enriched.sql'),
	season: path.join(sampleProject, 'models', 'nba', 'analysis', 'season_summary.sql'),
	preds: path.join(sampleProject, 'models', 'nba', 'analysis', 'reg_season_predictions.sql'),
};

// Ensure output directories exist — wipe frames dir first so stale files don't accumulate
// Only wipe stale frames on a full run; preserve them when testing a single step
if (!stepFilter && fs.existsSync(framesDir)) {
	for (const f of fs.readdirSync(framesDir)) fs.unlinkSync(path.join(framesDir, f));
}
fs.mkdirSync(framesDir, { recursive: true });
fs.mkdirSync(videoDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });

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
fs.writeFileSync(vscSettingsPath, JSON.stringify(existingSettings, null, 2));

let screenshotN = 0;
const frames = [];
const events = [];
const segmentStarts = new Map();
let sessionStartMs = Date.now();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Inject a semi-transparent green border/fill over the given CSS selector so the
 * viewer's eye is drawn to the right part of the screen in the screenshot.
 * Call removeHighlight(win) immediately after the screenshot.
 */
async function flashHighlight(win, selector) {
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
		});
		document.body.appendChild(ov);
	}, selector);
}

/**
 * Highlight a specific collapsible pane by its visible title instead of the whole sidebar.
 * Falls back to the provided container selector if the pane cannot be found.
 */
async function flashPaneHighlight(win, titleText, containerSelector = '.part.sidebar') {
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
	await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 3000 });
	await win.keyboard.type(command, TYPE_DELAY);
	await win.waitForSelector('.quick-input-list .monaco-list-row', { timeout: 3000 }).catch(() => { });
	await win.keyboard.press('Enter');
	// Wait for the command palette overlay to fully dismiss before continuing
	await win.waitForSelector('.quick-input-widget', { state: 'hidden', timeout: 3000 }).catch(() => { });
}

async function openFile(win, filename) {
	await win.keyboard.press('Control+P');
	await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 3000 });
	await win.keyboard.press('Control+A'); // clear any leftover text from previous open
	await win.keyboard.type(filename, TYPE_DELAY);
	await win.waitForSelector('.quick-input-list .monaco-list-row', { timeout: 3000 }).catch(() => { });
	await win.keyboard.press('Enter');
	// Wait for editor to be visible and stabilise
	await win.waitForSelector('.monaco-editor .view-lines', { timeout: 10000 });
	await win.waitForTimeout(300);
}

async function goToLine(win, line, col = 1) {
	await win.keyboard.press('Control+G');
	await win.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 3000 });
	await win.keyboard.type(`${line}:${col}`, TYPE_DELAY);
	await win.keyboard.press('Enter');
	await win.waitForTimeout(400);
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
 * Wait until the dbt Studio status bar shows "dbt: Ready" (no active job).
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

async function waitForDbQuery(win, timeout = 30000) {
	await win.waitForFunction(
		() => {
			for (const item of document.querySelectorAll('.statusbar-item')) {
				const text = (item.textContent || '')
					+ (item.getAttribute('aria-label') || '')
					+ (item.title || '');
				if (text.includes('dbt: db query')) return true;
			}
			return false;
		},
		undefined,
		{ timeout },
	);
}

// ─── Panel / tree helpers ─────────────────────────────────────────────────────

/**
 * Expand or collapse a dbt Studio sidebar panel by its visible title text.
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
			if (twistie) await twistie.click().catch(() => row.click().catch(() => { }));
			else await row.click().catch(() => { });
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

/** Collapse all expanded tree rows inside containerSelector. */
async function collapseAllTreeItems(win, containerSelector = '.part.sidebar', maxPasses = 6) {
	return setAllTreeItemsExpanded(win, false, containerSelector, maxPasses);
}

/**
 * Open the dbt Studio activity-bar container and wait until its sidebar panes appear.
 * This is more reliable than assuming the currently visible sidebar belongs to dbt Studio.
 */
async function openDbtStudioSidebar(win, timeout = 15000) {
	const iconSelectors = [
		'.activitybar .action-label[aria-label="dbt Studio"]',
		'.activitybar li[aria-label="dbt Studio"]',
		'.activitybar [title="dbt Studio"]',
		'.composite-bar .action-label[aria-label="dbt Studio"]',
		'.composite-bar [title="dbt Studio"]',
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

	throw new Error('Could not open dbt Studio sidebar');
}

// ─── Wait for extension to be fully ready ────────────────────────────────────
//
// Strategy:
//   1. Poll for the dbt Studio activity bar icon (proves the extension registered)
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
 *   - Primary sidebar = dbt Studio (always visible on the left)
 *   - All editor tabs closed (middle column empty)
 *   - Bottom panel closed
 *   - Secondary sidebar (right column) closed
 *
 * Call this at the start of every segment's pre-demo setup phase.
 * All the runCommand / openFile / goToLine calls that follow are intentionally
 * BEFORE the `{id}.demo` event, so the command-palette UI is outside the
 * video clip window.
 */
async function resetLayout(win) {
	// Close every open editor tab
	await runCommand(win, 'View: Close All Editors');
	await win.waitForTimeout(200);
	// Close the bottom panel if it is open
	const panelOpen = await win.locator('.part.panel').isVisible({ timeout: 500 }).catch(() => false);
	if (panelOpen) {
		await win.keyboard.press('Control+J');
		await win.waitForTimeout(200);
	}
	// Close the secondary sidebar (right column) if it is open
	const auxOpen = await win.locator('.auxiliarybar, .part.auxiliarybar').isVisible({ timeout: 300 }).catch(() => false);
	if (auxOpen) {
		await runCommand(win, 'View: Close Secondary Side Bar');
		await win.waitForTimeout(200);
	}
	// Make sure dbt Studio panes are visible in the primary sidebar
	await openDbtStudioSidebar(win);
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
	console.log('Waiting for dbt Studio activity bar icon...');

	const iconSelectors = [
		'.activitybar .action-label[aria-label="dbt Studio"]',
		'.activitybar li[aria-label="dbt Studio"]',
		'.activitybar [title="dbt Studio"]',
		'.composite-bar .action-label[aria-label="dbt Studio"]',
		'.composite-bar [title="dbt Studio"]',
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
		await openDbtStudioSidebar(win, 15000);
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
	console.log('\n=== dbt Studio Demo Capture ===\n');
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
	try {
		app = await electron.launch({
			executablePath: VSCODE_EXE,
			args: [
				'--extensionDevelopmentPath=' + repoRoot,
				'--user-data-dir=' + userDataDir,
				'--disable-extensions',
				'--disable-workspace-trust',
				'--skip-release-notes',
				'--skip-welcome',
				'--window-size=1920,1080',
				sampleProject,
			],
			timeout: 60000,
			recordVideo: {
				dir: videoDir,
				size: { width: 1920, height: 1080 },
			},
		});

		// Get the main workbench window
		const win = await app.firstWindow({ timeout: 45000 });
		const recordedVideo = win.video();

		// Wait for workbench chrome to appear
		await win.waitForSelector('.monaco-workbench', { timeout: 45000 });
		// Maximize the window. On Windows the actual height is less than the recording
		// height (1080) because the taskbar is outside the BrowserWindow client area.
		const browserWindow = await app.browserWindow(win);
		await browserWindow.evaluate(bw => bw.maximize());
		await win.waitForTimeout(500);
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
				const candidate = path.join(wsStorage, hash, 'nickeolofsson.dbt-studio-vscode', 'column-store.json');
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
				await openFile(win, f);
				await waitForReady(win, 60000);
			}
			await waitForReady(win, 120000);
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
		// waitForExtensionReady() already clicked the sidebar and waited for tree items,
		// so just take the screenshot — sidebar is already open and populated.
		console.log('[01] Model Explorer');
		markSegmentStart('model-explorer');
		if (shouldRun('model-explorer')) try {
			await win.waitForTimeout(500);
			// Expand top-level folders (Models, Sources) — single pass avoids over-expanding
			await setAllTreeItemsExpanded(win, true, '.part.sidebar', 1);
			await win.waitForTimeout(600);
			await flashPaneHighlight(win, 'MODEL EXPLORER');
			await screenshot(win, 'model-explorer', 'Model Explorer — Models · Sources · By Tag', 3500);
			await removeHighlight(win);
		} catch (e) {
			console.warn(`  ⚠ model-explorer: ${e.message}`);
		}
		markSegmentEnd('model-explorer');

		// ── 02: CodeLens ─────────────────────────────────────────────────────────
		console.log('[02] CodeLens');
		markSegmentStart('codelens');
		if (shouldRun('codelens')) try {
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await goToLine(win, 1);
			await waitForReady(win, 30000);
			// Wait for CodeLens decorations above the first line
			await win.waitForSelector('.codelens-decoration a', { timeout: 20000 });
			await win.waitForTimeout(600);
			// Highlight the editor title-bar action buttons (Run/Build/Compile/Profile icons)
			await flashHighlight(win, '.editor-actions');
			await screenshot(win, 'codelens', 'CodeLens — Run · Build · Test · Compile · Profile', 3000);
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
			await moveMouse(win, posHoverRef.x, posHoverRef.y, 30);
			// DEMO: real pointer lands — Monaco shows hover after ~300ms idle
			logEvent('hover-ref.demo');
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
			await goToLine(win, 77, 8);
			await initCustomCursor(win);
			const posHoverCol = await getTokenScreenPos(win, 77, 8);
			if (!posHoverCol) throw new Error('getTokenScreenPos returned null for line 77 col 8');
			console.log(`  hover-column token pos: ${posHoverCol.x},${posHoverCol.y}`);
			await moveMouse(win, posHoverCol.x, posHoverCol.y, 30);
			// DEMO
			logEvent('hover-column.demo');
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
			logEvent('completion.demo');
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
			if (posRename) await moveMouse(win, posRename.x, posRename.y, 30);
			// DEMO
			logEvent('rename-symbol.demo');
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
			// PRE-DEMO: reset, open file, open Problems panel, position cursor at the token
			await resetLayout(win);
			await openFile(win, 'season_summary.sql');
			// Ctrl+Shift+M is a direct key (no command palette) — safe in pre-demo
			await win.keyboard.press('Control+Shift+M');
			await win.waitForSelector('.part.panel', { state: 'visible', timeout: 3000 }).catch(() => { });
			await win.click('.monaco-editor .view-lines');
			await goToLine(win, 20, 22);
			await initCustomCursor(win);
			const posDiag = await getTokenScreenPos(win, 20, 22);
			if (posDiag) await moveMouse(win, posDiag.x, posDiag.y, 20);
			// DEMO
			logEvent('diagnostics.demo');
			if (posDiag) {
				await win.waitForTimeout(200);
				await win.mouse.dblclick(posDiag.x, posDiag.y);
			} else {
				await win.keyboard.press('Control+Shift+ArrowRight');
			}
			await win.waitForTimeout(300);
			await win.keyboard.type('zzz_missing_model', TYPE_DELAY);
			await win.waitForTimeout(3500);
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
			await openFile(win, 'reg_season_actuals_enriched.sql');
			// Collapse other sidebar panes so OUTLINE fills more height
			await collapsePanelsExcept(win, 'OUTLINE');
			await runCommand(win, 'View: Focus Outline');
			await win.waitForSelector('.outline-element', { timeout: 8000 });
			// Expand all nodes so the full CTE tree with columns is visible
			await setAllTreeItemsExpanded(win, true, '.part.sidebar', 4);
			await win.waitForTimeout(800);
			await flashPaneHighlight(win, 'OUTLINE');
			await screenshot(win, 'document-symbols', 'Outline — CTE tree with columns in every scope', 3000);
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
			const posGotoDef = await getTokenScreenPos(win, 92, 18);
			if (posGotoDef) await moveMouse(win, posGotoDef.x, posGotoDef.y, 30);
			// DEMO
			logEvent('go-to-definition.demo');
			if (posGotoDef) {
				await win.waitForTimeout(300);
				// Hold Ctrl — VS Code shows clickable underline
				await win.keyboard.down('Control');
				await win.waitForTimeout(700);
				await win.mouse.click(posGotoDef.x, posGotoDef.y);
				await win.keyboard.up('Control');
			} else {
				await win.keyboard.press('F12');
			}
			await win.waitForTimeout(2500);
			await screenshot(win, 'go-to-definition', 'Go to Definition — Ctrl+Click to jump to source', 3000);
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
			if (posFar) await moveMouse(win, posFar.x, posFar.y, 25);
			// DEMO
			logEvent('find-all-references.demo');
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
			await openFile(win, 'season_summary.sql');
			// Line 20: `from {{ ref("reg_season_summary") }} r`
			// "reg_season_summary" starts at col 14, middle ~col 22
			await win.click('.monaco-editor .view-lines');
			await goToLine(win, 20, 22);
			await win.keyboard.press('Shift+Alt+H');
			// Call hierarchy opens as a peek/panel — wait for idle then expand tree
			await win.waitForTimeout(500);
			await waitForReady(win, 15000).catch(() => { });
			await win.waitForTimeout(2000);
			// Expand both Callers (incoming) and Call Sites (outgoing) rows
			await setAllTreeItemsExpanded(win, true, '.part.panel', 3);
			await setAllTreeItemsExpanded(win, true, '.part.sidebar', 3);
			await win.waitForTimeout(1000);
			await screenshot(win, 'call-hierarchy', 'Call Hierarchy — upstream & downstream model tree', 4000);
			await pressEscape(win);
		} catch (e) {
			console.warn(`  ⚠ call-hierarchy: ${e.message}`);
		}
		markSegmentEnd('call-hierarchy');

		// ── 12: Workspace Symbol Search ──────────────────────────────────────────
		console.log('[12] Workspace Symbols');
		markSegmentStart('workspace-symbols');
		if (shouldRun('workspace-symbols')) try {
			await win.keyboard.press('Control+T');
			await win.waitForTimeout(400);
			await win.keyboard.type('nba_team', TYPE_DELAY);
			await win.waitForTimeout(800);
			await win.waitForSelector('.quick-input-list .monaco-list-row', { timeout: 6000 });
			await win.waitForTimeout(500);
			await screenshot(win, 'workspace-symbols', 'Workspace Symbols (Ctrl+T) — search all models', 3000);
			await pressEscape(win);
		} catch (e) {
			console.warn(`  ⚠ workspace-symbols: ${e.message}`);
		}
		markSegmentEnd('workspace-symbols');

		// ── 13: Lineage Graph ────────────────────────────────────────────────────
		console.log('[13] Lineage Graph');
		markSegmentStart('lineage-graph');
		if (shouldRun('lineage-graph')) try {
			await openFile(win, 'season_summary.sql');
			await runCommand(win, 'dbt Studio: Show Lineage');
			await waitForReady(win, 30000).catch(() => { });
			await win.waitForTimeout(5000);
			// Maximize panel so the DAG fills the screen
			const maximizeBtn = win.locator('.part.panel .codicon-panel-maximize').first();
			if (await maximizeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
				await maximizeBtn.click();
			} else {
				await runCommand(win, 'View: Toggle Maximized Panel Size');
			}
			await win.waitForTimeout(500);
			// Press Fit in the lineage webview
			const lineageFrameForFit = await findWebviewFrame(win, '#canvas-wrap');
			if (lineageFrameForFit) {
				await lineageFrameForFit.evaluate(() => document.getElementById('fit-btn')?.click());
				await win.waitForTimeout(1500);
			}
			await flashHighlight(win, '.part.panel');
			await screenshot(win, 'lineage-graph', 'Lineage Graph — interactive DAG', 4500);
			await removeHighlight(win);
			// Stay maximized — lineage-column video uses this panel state
		} catch (e) {
			console.warn(`  ⚠ lineage-graph: ${e.message}`);
		}
		markSegmentEnd('lineage-graph');

		// ── 14: Column Lineage ─────────────────────────────────────────────────
		console.log('[14] Column Lineage');
		markSegmentStart('lineage-column');
		if (shouldRun('lineage-column')) try {
			await initCustomCursor(win);
			// Panel should still be maximized from lineage-graph segment.
			// When running standalone (--step lineage-column), open lineage first.
			if (stepFilter === 'lineage-column') {
				await openFile(win, 'season_summary.sql');
				await runCommand(win, 'dbt Studio: Show Lineage');
				await waitForReady(win, 30000).catch(() => { });
				await win.waitForTimeout(5000);
				const maximizeBtnLC = win.locator('.part.panel .codicon-panel-maximize').first();
				if (await maximizeBtnLC.isVisible({ timeout: 1000 }).catch(() => false)) {
					await maximizeBtnLC.click();
				} else {
					await runCommand(win, 'View: Toggle Maximized Panel Size');
				}
				await win.waitForTimeout(500);
			}
			const lineageFrame = await findWebviewFrame(win, '#canvas-wrap');
			if (!lineageFrame) throw new Error('Lineage webview frame not found');
			// Ensure Fit is applied so the full graph is visible
			await lineageFrame.evaluate(() => document.getElementById('fit-btn')?.click());
			await win.waitForTimeout(1000);

			// Wait for column enrichment
			let toggleVisible = false;
			for (let i = 0; i < 20; i++) {
				toggleVisible = await lineageFrame.evaluate(() => !!document.querySelector('.col-toggle'));
				if (toggleVisible) break;
				await win.waitForTimeout(1000);
			}
			if (!toggleVisible) throw new Error('No .col-toggle appeared');
			logEvent('lineage-column.demo');

			// Click the focus card's col-toggle to expand its column list
			const clicked = await lineageFrame.evaluate(() => {
				const toggle = document.querySelector('.card.focus .col-toggle');
				if (!toggle) return false;
				toggle.click();
				return true;
			});
			if (!clicked) throw new Error('Focus card col-toggle not found');
			await win.waitForTimeout(2000);

			// Click the first column item to trigger column lineage trace
			const colClicked = await lineageFrame.evaluate(() => {
				const col = document.querySelector('.card.focus .col-item');
				if (!col) return null;
				col.click();
				return col.dataset.col || '(unknown)';
			});
			if (!colClicked) throw new Error('Focus card .col-item not found');
			console.log(`  → tracing column: ${colClicked}`);

			await waitForReady(win, 30000).catch(() => { });
			await win.waitForTimeout(2000);
			await win.waitForTimeout(1000);

			await flashHighlight(win, '.part.panel');
			await screenshot(win, 'lineage-column', 'Column Lineage — trace column through upstream models', 5000);
			logEvent('lineage-column.post-demo');
			// POST-DEMO
			await removeHighlight(win);
			await removeCursor(win);
			// Restore panel to normal size
			await runCommand(win, 'View: Toggle Maximized Panel Size');
			await win.waitForTimeout(400);
		} catch (e) {
			console.warn(`  ⚠ lineage-column: ${e.message}`);
		}
		markSegmentEnd('lineage-column');

		// Close the bottom panel — don't let it distract subsequent frames
		await win.keyboard.press('Control+J');
		await win.waitForTimeout(400);

		// ── 15: Profiler ─────────────────────────────────────────────────────────
		// The Playwright session video naturally records the profiler running.
		// The screenshot captures the finished state with the full tree expanded.
		console.log('[15] Profiler');
		markSegmentStart('profiler');
		if (shouldRun('profiler')) try {
			// PRE-DEMO: reset layout (also opens dbt Studio sidebar), open file and collapse panels
			await resetLayout(win);
			await openFile(win, 'reg_season_actuals_enriched.sql');
			await collapsePanelsExcept(win, 'PROFILE RESULTS');
			await collapseAllTreeItems(win, '.part.sidebar');
			await win.waitForTimeout(300);
			await goToLine(win, 1);
			await waitForReady(win, 30000);
			await win.waitForSelector('.codelens-decoration a', { timeout: 20000 });
			// DEMO: click Profile — the profiler run and results are the demo content
			logEvent('profiler.demo');
			const profileLens = win.locator('.codelens-decoration a', { hasText: 'Profile' });
			await profileLens.click();

			await flashPaneHighlight(win, 'PROFILE RESULTS');
			await waitForDbQuery(win, 30000);
			logEvent('profiler.started');
			await win.waitForTimeout(500);

			// Expand the full tree so every CTE row is visible
			await expandAllTreeItems(win, '.part.sidebar');
			logEvent('profiler.tree-expanded');
			await win.waitForTimeout(500);
			await removeHighlight(win);

			await waitForReady(win, 90000);
			logEvent('profiler.ready');
			await win.waitForTimeout(800);

			// Re-expand after all results have landed (items added during profiling start collapsed)
			await expandAllTreeItems(win, '.part.sidebar');
			await win.waitForTimeout(400);

			await flashPaneHighlight(win, 'PROFILE RESULTS');
			await screenshot(win, 'profiler', 'Profiler — per-CTE row counts & timing', 4000);
			logEvent('profiler.post-demo');
			await removeHighlight(win);
		} catch (e) {
			console.warn(`  ⚠ profiler: ${e.message}`);
		}
		markSegmentEnd('profiler');

		// ── 16: Query Results ────────────────────────────────────────────────────
		console.log('[16] Query Results');
		markSegmentStart('query-results');
		if (shouldRun('query-results')) try {
			// PRE-DEMO
			await resetLayout(win);
			await openFile(win, 'reg_season_predictions.sql');
			await goToLine(win, 1);
			await initCustomCursor(win);
			// DEMO: execute query and show results
			logEvent('query-results.demo');
			await win.keyboard.press('Control+Shift+Enter');
			await waitForReady(win, 60000).catch(() => { });
			await win.waitForTimeout(2000);
			const resultsFrame = await findWebviewFrame(win, '.result-grid, .tg, .grid-body, td');
			if (resultsFrame) {
				const cells = await resultsFrame.locator('td, .grid-cell').elementHandles();
				for (let i = 0; i < Math.min(3, cells.length); i++) {
					await cells[i].click().catch(() => { });
					await win.waitForTimeout(300);
				}
			}
			await win.waitForTimeout(600);
			await screenshot(win, 'query-results', 'Query Results — run SQL and browse results inline', 4000);
			logEvent('query-results.post-demo');
			// POST-DEMO
			await removeCursor(win);
		} catch (e) {
			console.warn(`  ⚠ query-results: ${e.message}`);
		}
		markSegmentEnd('query-results');



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
