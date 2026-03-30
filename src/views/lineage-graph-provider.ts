import * as vscode from 'vscode';
import * as dagre from 'dagre';
import type { ManifestIndexer, ManifestIndex } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import type { GetColumnLineageTool } from '../tools/get-column-lineage';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';

interface ColumnData {
	name: string;
	type?: string;
}

interface PositionedNode {
	id: string;
	label: string;
	type: string;
	materialisation?: string;
	filePath?: string;
	isFocus: boolean;
	columns: ColumnData[];
	x: number;
	y: number;
	width: number;
	height: number;
}

interface GraphEdge {
	source: string;
	target: string;
}

const CARD_WIDTH = 180;
const HEADER_HEIGHT = 44;

export class LineageGraphProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'dbt-studio.lineageGraph';

	private _view?: vscode.WebviewView;
	private _focusModel?: string;
	private _followActive = true;
	private _upstreamDepth = 2;
	private _downstreamDepth = 1;
	private _enrichGeneration = 0;
	private readonly _depthPerModel = new Map<string, { upstream: number; downstream: number }>();
	private _showTests: boolean;
	private _columnLineageTool?: GetColumnLineageTool;
	private _executionService?: DbtExecutionService;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly globalState: vscode.Memento,
	) {
		this._followActive = globalState.get<boolean>('dbt-studio.lineageFollowActive', true);
		this._showTests = vscode.workspace.getConfiguration('dbt-studio').get<boolean>('lineage.showTests', true);
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('dbt-studio.lineage.showTests')) {
				this._showTests = vscode.workspace.getConfiguration('dbt-studio').get<boolean>('lineage.showTests', true);
				void vscode.commands.executeCommand('setContext', 'dbt-studio.lineage.showTests', this._showTests);
				this._updateGraph();
			}
		});
	}

	setExecutionService(service: DbtExecutionService): void {
		this._executionService = service;
	}

	setColumnLineageTool(tool: GetColumnLineageTool): void {
		this._columnLineageTool = tool;
	}

	get followActive(): boolean {
		return this._followActive;
	}

	toggleFollow(): void {
		this._followActive = !this._followActive;
		void this.globalState.update('dbt-studio.lineageFollowActive', this._followActive);
		void vscode.commands.executeCommand(
			'setContext',
			'dbt-studio.lineageFollowActive',
			this._followActive,
		);
	}

	get showTests(): boolean {
		return this._showTests;
	}

	setShowTests(value: boolean): void {
		void vscode.workspace.getConfiguration('dbt-studio').update('lineage.showTests', value, vscode.ConfigurationTarget.Global);
		// Config change listener handles re-render and context key update
	}

	setFocusModel(uniqueId: string): void {
		if (this._focusModel === uniqueId) return;
		// Save depths for the model we're leaving so they're restored on return
		if (this._focusModel) {
			this._depthPerModel.set(this._focusModel, { upstream: this._upstreamDepth, downstream: this._downstreamDepth });
		}
		this._focusModel = uniqueId;
		const savedDepths = this._depthPerModel.get(uniqueId);
		this._upstreamDepth = savedDepths?.upstream ?? 2;
		this._downstreamDepth = savedDepths?.downstream ?? 1;
		this._updateGraph();
	}

	/** Called when a file is closed in the editor — clears its persisted lineage state. */
	notifyFileClosed(filePath: string): void {
		const uid = this.indexer.findModelByFilePath(filePath);
		if (!uid) return;
		this._depthPerModel.delete(uid);
		void this._view?.webview.postMessage({ command: 'clearFileState', focusId: uid });
	}

	/** Called when the manifest index is rebuilt so the graph reflects fresh data. */
	refreshGraph(): void {
		if (!this._focusModel) return;
		this._updateGraph();
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this._getHtml();

		webviewView.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
			if (msg['command'] === 'openFile' && typeof msg['filePath'] === 'string') {
				void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg['filePath'] as string));
			}
			if (msg['command'] === 'incrementUpstream') {
				this._upstreamDepth++;
				this._updateGraph();
			}
			if (msg['command'] === 'decrementUpstream') {
				if (this._upstreamDepth > 0) { this._upstreamDepth--; this._updateGraph(); }
			}
			if (msg['command'] === 'incrementDownstream') {
				this._downstreamDepth++;
				this._updateGraph();
			}
			if (msg['command'] === 'decrementDownstream') {
				if (this._downstreamDepth > 0) { this._downstreamDepth--; this._updateGraph(); }
			}
			if (msg['command'] === 'traceColumn' && typeof msg['model'] === 'string' && typeof msg['column'] === 'string') {
				void this._handleTraceColumn(msg['model'] as string, msg['column'] as string);
			}
		});

		/* Re-sync when the panel becomes visible after being hidden.
		 * postMessage is silently dropped while the view is hidden, so we
		 * must re-send the current graph whenever visibility is restored. */
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible && this._focusModel) {
				this._updateGraph();
			}
		});

		if (this._focusModel) {
			this._updateGraph();
		}
	}

	private _updateGraph(): void {
		if (!this._view || !this._focusModel) return;
		void this._updateGraphAsync();
	}

	private async _updateGraphAsync(): Promise<void> {
		if (!this._view || !this._focusModel) return;

		const gen = ++this._enrichGeneration;

		// Ensure manifest exists before building the graph
		const ready = await this._ensureParsed();
		if (!ready) {
			void this._view.webview.postMessage({ command: 'setGraph', nodes: [], edges: [], focusId: this._focusModel, upstreamDepth: this._upstreamDepth, downstreamDepth: this._downstreamDepth });
			return;
		}

		const index = this.indexer.index;
		if (!index) return;

		const lineage = this.indexer.getLineage(this._focusModel, this._upstreamDepth, this._downstreamDepth);
		const { nodes, edges } = this._buildGraph(index, lineage, this._focusModel, this._showTests);
		this._computeLayout(nodes, edges);

		void this._view.webview.postMessage({
			command: 'setGraph',
			nodes,
			edges,
			focusId: this._focusModel,
			upstreamDepth: this._upstreamDepth,
			downstreamDepth: this._downstreamDepth,
		});

		// Progressively enrich columns for nodes that have compiled SQL
		if (this._columnLineageTool) {
			void this._enrichColumns(nodes, gen);
		}
	}

	/**
	 * Ensure manifest is parsed. If missing, triggers dbt parse.
	 * Returns true if manifest is available after this call.
	 */
	private async _ensureParsed(): Promise<boolean> {
		if (this.indexer.manifestExists()) return true;
		if (!this._executionService) return false;

		try {
			const result = await this._executionService.submit({
				type: 'parse',
				args: ['parse'],
				priority: Priority.Tool,
				origin: 'copilot',
				label: 'parse (lineage view)',
			});
			if (result.success) {
				this.indexer.build(true);
				return this.indexer.manifestExists();
			}
		} catch {
			this.logger.warn('Auto-parse failed for lineage view');
		}
		return false;
	}

	private async _enrichColumns(nodes: PositionedNode[], gen: number): Promise<void> {
		if (!this._view || !this._columnLineageTool) return;

		for (const node of nodes) {
			if (gen !== this._enrichGeneration) return;
			if (node.columns.length > 0) continue;
			try {
				const cols = await this._columnLineageTool.resolveColumnsForNode(node.id);
				if (gen !== this._enrichGeneration) return;
				if (cols.length > 0 && this._view) {
					void this._view.webview.postMessage({
						command: 'updateColumns',
						nodeId: node.id,
						columns: cols.map(c => ({ name: c })),
					});
				}
			} catch {
				// Ignore — bridge may not be running
			}
		}
	}

	private async _handleTraceColumn(modelUniqueId: string, column: string): Promise<void> {
		if (!this._view) return;
		if (!this._columnLineageTool) {
			void this._view.webview.postMessage({
				command: 'columnLineageStatus',
				status: 'error',
				message: 'Column lineage tool not available',
			});
			return;
		}

		void this._view.webview.postMessage({
			command: 'columnLineageStatus',
			status: 'loading',
			message: 'Tracing ' + column + '...',
		});

		try {
			const result = await this._columnLineageTool.traceColumnDirect(modelUniqueId, column, 'upstream');
			if (result.error) {
				this.logger.warn(`Column lineage error: ${result.error}`);
				void this._view.webview.postMessage({
					command: 'columnLineageStatus',
					status: 'error',
					message: result.error,
				});
				return;
			}

			const columns: Array<{ model: string; column: string }> = [];
			columns.push({ model: modelUniqueId, column });

			for (const dep of result.dependencies) {
				if (dep.dbt_resource) {
					columns.push({ model: dep.dbt_resource, column: dep.column });
				}
			}

			// Ensure columns are loaded in the DOM for every node in the trace result
			// before highlighting — progressive enrichment may not have reached them yet
			if (this._columnLineageTool) {
				const uniqueNodes = [...new Set(columns.map(c => c.model))];
				for (const nodeId of uniqueNodes) {
					try {
						const cols = await this._columnLineageTool.resolveColumnsForNode(nodeId);
						if (cols.length > 0 && this._view) {
							void this._view.webview.postMessage({
								command: 'updateColumns',
								nodeId,
								columns: cols.map(c => ({ name: c })),
							});
						}
					} catch {
						// Non-critical — highlighting may be partial
					}
				}
			}

			void this._view.webview.postMessage({
				command: 'columnLineageStatus',
				status: 'done',
			});

			void this._view.webview.postMessage({
				command: 'highlightColumns',
				columns,
				columnEdges: result.columnEdges,
				sourceModel: modelUniqueId,
				sourceColumn: column,
			});
		} catch (err) {
			this.logger.warn(`Column lineage failed: ${err}`);
			if (this._view) {
				void this._view.webview.postMessage({
					command: 'columnLineageStatus',
					status: 'error',
					message: 'Column lineage failed. Is the Python bridge running?',
				});
			}
		}
	}

	private _buildGraph(
		index: ManifestIndex,
		lineage: { upstream: { uniqueId: string }[]; downstream: { uniqueId: string }[] },
		focusId: string,
		showTests = true,
	): { nodes: PositionedNode[]; edges: GraphEdge[] } {
		const allIds = new Set<string>();
		allIds.add(focusId);
		for (const node of lineage.upstream) allIds.add(node.uniqueId);
		for (const node of lineage.downstream) allIds.add(node.uniqueId);

		// Filter test nodes when showTests is false
		if (!showTests) {
			for (const id of [...allIds]) {
				const kind = id.split('.')[0];
				if (kind === 'test' || kind === 'unit_test') allIds.delete(id);
			}
		}

		const nodes: PositionedNode[] = [];
		for (const id of allIds) {
			const rawNode = this.indexer.getRawNode(id);
			const columns: ColumnData[] = [];
			if (rawNode && 'columns' in rawNode) {
				for (const col of Object.values(rawNode.columns)) {
					columns.push({ name: col.name, type: col.data_type });
				}
			}

			const model = index.models.get(id);
			const source = index.sources.get(id);
			if (model) {
				nodes.push({
					id,
					label: model.name,
					type: 'model',
					materialisation: model.materialisation,
					filePath: model.path,
					isFocus: id === focusId,
					columns,
					x: 0, y: 0,
					width: CARD_WIDTH,
					height: HEADER_HEIGHT,
				});
			} else if (source) {
				nodes.push({
					id,
					label: source.name,
					type: 'source',
					isFocus: id === focusId,
					columns,
					x: 0, y: 0,
					width: CARD_WIDTH,
					height: HEADER_HEIGHT,
				});
			} else {
				const kind = id.split('.')[0];
				const name = id.split('.').pop() ?? id;
				nodes.push({
					id,
					label: name,
					type: kind,
					isFocus: id === focusId,
					columns,
					x: 0, y: 0,
					width: CARD_WIDTH,
					height: HEADER_HEIGHT,
				});
			}
		}

		const edges: GraphEdge[] = [];
		for (const id of allIds) {
			const parents = index.parentMap.get(id) ?? [];
			for (const parent of parents) {
				if (allIds.has(parent)) {
					edges.push({ source: parent, target: id });
				}
			}
		}

		return { nodes, edges };
	}

	private _computeLayout(nodes: PositionedNode[], edges: GraphEdge[]): void {
		if (nodes.length === 0) return;

		const g = new dagre.graphlib.Graph();
		g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 100, marginx: 20, marginy: 20 });
		g.setDefaultEdgeLabel(() => ({}));

		for (const node of nodes) {
			g.setNode(node.id, { width: node.width, height: node.height });
		}
		for (const edge of edges) {
			g.setEdge(edge.source, edge.target);
		}

		dagre.layout(g);

		for (const node of nodes) {
			const pos = g.node(node.id);
			node.x = pos.x;
			node.y = pos.y;
		}
	}

	private _getHtml(): string {
		const nonce = getNonce();
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body {
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
}
.controls {
	display: flex; gap: 8px; padding: 6px 8px;
	align-items: center; flex-wrap: wrap;
	border-bottom: 1px solid var(--vscode-panel-border);
	background: var(--vscode-sideBar-background);
	position: relative; z-index: 10;
}
.depth-control { display: flex; align-items: center; gap: 4px; }
.depth-chevron {
	font-size: 16px; font-weight: 900;
	color: var(--vscode-foreground); opacity: 0.75;
	padding: 1px 2px; line-height: 1; user-select: none;
}
.depth-control button {
	background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	border: 1px solid var(--vscode-input-border, transparent);
	padding: 2px 7px; font-size: 14px; font-weight: 700; border-radius: 3px; cursor: pointer; line-height: 1.3;
}
.depth-control button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.depth-value { font-size: 13px; font-weight: 600; min-width: 16px; text-align: center; }
.fit-btn {
	background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	border: 1px solid var(--vscode-input-border, transparent);
	padding: 2px 7px; font-size: 12px; border-radius: 3px; cursor: pointer;
}
.fit-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.legend { display: flex; gap: 8px; margin-left: auto; }
.legend-item { display: flex; align-items: center; gap: 3px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }

#canvas-wrap {
	position: relative; width: 100%; height: calc(100% - 36px);
	overflow: hidden; cursor: grab;
}
#canvas-wrap.dragging { cursor: grabbing; }
#canvas {
	position: absolute; top: 0; left: 0;
	transform-origin: 0 0;
}
svg.edges {
	position: absolute; top: 0; left: 0;
	transform-origin: 0 0;
	pointer-events: none; overflow: visible;
}
svg.edges path {
	fill: none;
	stroke: var(--vscode-editorWidget-border, var(--vscode-panel-border));
	stroke-width: 1.5;
}
svg.edges path.col-edge {
	stroke-width: 1;
	opacity: 0.8;
}
svg.edges polygon {
	fill: var(--vscode-editorWidget-border, var(--vscode-panel-border));
}

.card {
	position: absolute;
	width: 180px;
	background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
	border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	border-radius: 4px;
	overflow: hidden;
	box-shadow: 0 1px 4px rgba(0,0,0,0.15);
}
.card.focus {
	border-color: var(--vscode-focusBorder);
	box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}
.card-header {
	display: flex; align-items: center; gap: 6px;
	padding: 6px 8px;
	background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background));
	border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	cursor: pointer;
	min-height: 32px;
}
.card-header:hover {
	background: var(--vscode-list-hoverBackground);
}
.type-stripe {
	width: 3px; align-self: stretch; border-radius: 1px; flex-shrink: 0;
}
.card-title {
	font-size: 11px; font-weight: 600;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	flex: 1;
	color: var(--vscode-foreground);
}
.card-subtitle {
	font-size: 9px;
	color: var(--vscode-descriptionForeground);
}
.col-toggle {
	font-size: 9px; cursor: pointer; flex-shrink: 0;
	color: var(--vscode-descriptionForeground);
	background: none; border: none; padding: 2px;
}
.col-toggle:hover { color: var(--vscode-foreground); }
.col-list {
	max-height: 200px; overflow-y: auto;
}
.col-item {
	display: flex; align-items: center; gap: 4px;
	padding: 2px 8px 2px 17px;
	font-size: 10px; cursor: pointer;
	color: var(--vscode-foreground);
}
.col-item:hover {
	background: var(--vscode-list-hoverBackground);
}
.col-item.highlighted {
	background: var(--vscode-list-activeSelectionBackground);
	color: var(--vscode-list-activeSelectionForeground);
}
.col-type {
	font-size: 9px;
	color: var(--vscode-descriptionForeground);
	margin-left: auto;
	white-space: nowrap;
}
.col-dot {
	width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
	background: var(--vscode-descriptionForeground);
}
.no-columns {
	padding: 4px 8px 6px 17px;
	font-size: 10px; font-style: italic;
	color: var(--vscode-descriptionForeground);
}

.empty-state {
	display: flex; justify-content: center; align-items: center;
	height: calc(100% - 36px);
	color: var(--vscode-descriptionForeground);
	font-size: 13px; text-align: center; padding: 16px;
}
#status-bar {
	display: none;
	position: fixed; bottom: 4px; left: 50%; transform: translateX(-50%);
	padding: 3px 10px; border-radius: 4px;
	font-size: 11px; z-index: 100; pointer-events: none;
	background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
	border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	color: var(--vscode-foreground);
}
#status-bar.status-error {
	color: var(--vscode-errorForeground, #f44);
}
</style>
</head>
<body>
<div class="controls">
	<div class="depth-control">
		<button id="up-inc">+</button>
		<button id="up-dec">−</button>
		<span class="depth-value" id="up-depth">2</span>
		<span class="depth-chevron">❮</span>
	</div>
	<div class="depth-control">
		<span class="depth-chevron">❯</span>
		<span class="depth-value" id="dn-depth">1</span>
		<button id="dn-dec">−</button>
		<button id="dn-inc">+</button>
	</div>
	<button class="fit-btn" id="fit-btn">⊡ Fit</button>
	<div class="legend">
		<span class="legend-item"><span class="swatch" style="background:var(--vscode-charts-blue, #5B8DEF)"></span>Model</span>
		<span class="legend-item"><span class="swatch" style="background:var(--vscode-charts-green, #43A686)"></span>Source</span>
		<span class="legend-item"><span class="swatch" style="background:var(--vscode-charts-purple, #C77DBA)"></span>Tests</span>
		<span class="legend-item"><span class="swatch" style="background:var(--vscode-charts-orange, #E8963E)"></span>Exposure</span>
	</div>
</div>
<div id="canvas-wrap" style="display:none">
	<svg class="edges" id="edges"></svg>
	<div id="canvas"></div>
	<svg class="edges" id="edges-fg"></svg>
</div>
<div id="empty" class="empty-state">Open a dbt model to see its lineage graph</div>

<script nonce="${nonce}">
(function() {
	const vscode = acquireVsCodeApi();
	const canvas = document.getElementById('canvas');
	const edgesSvg = document.getElementById('edges');
	const edgesFgSvg = document.getElementById('edges-fg');
	const wrapEl = document.getElementById('canvas-wrap');
	const emptyEl = document.getElementById('empty');
	const upDepthEl = document.getElementById('up-depth');
	const dnDepthEl = document.getElementById('dn-depth');

	const TYPE_COLORS = {
		model:     'var(--vscode-charts-blue, #5B8DEF)',
		source:    'var(--vscode-charts-green, #43A686)',
		test:      'var(--vscode-charts-purple, #C77DBA)',
		unit_test: 'var(--vscode-charts-purple, #C77DBA)',
		exposure:  'var(--vscode-charts-orange, #E8963E)',
		metric:    'var(--vscode-charts-orange, #E8963E)',
		seed:      'var(--vscode-charts-yellow, #8B7355)',
		snapshot:  'var(--vscode-descriptionForeground)',
	};

	let panX = 0, panY = 0, scale = 1;
	let isPanning = false, startX = 0, startY = 0;
	let graphData = null;
	let lastFocusId = null;
	let lastHighlightMsg = null;
	const expandedCards = new Set();
	const nodeInitialTops = new Map();
	/* Per-model saved state: expanded cards, column trace, pan/zoom */
	const savedStates = new Map();

	/* ── Pan & Zoom ── */
	function applyTransform() {
		canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
		edgesSvg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
		edgesFgSvg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
	}

	wrapEl.addEventListener('pointerdown', function(e) {
		/* Use composedPath for robustness — scrollbar clicks in some webview environments
		 * report e.target as the canvas/wrapEl rather than the col-list element itself. */
		const path = e.composedPath ? e.composedPath() : [e.target];
		const insideCard = path.some(function(el) { return el.classList && el.classList.contains('card'); });
		if (insideCard) return;
		isPanning = true;
		startX = e.clientX - panX;
		startY = e.clientY - panY;
		wrapEl.classList.add('dragging');
		wrapEl.setPointerCapture(e.pointerId);
	});
	wrapEl.addEventListener('pointermove', function(e) {
		if (!isPanning) return;
		panX = e.clientX - startX;
		panY = e.clientY - startY;
		applyTransform();
	});
	wrapEl.addEventListener('pointerup', function() {
		isPanning = false;
		wrapEl.classList.remove('dragging');
	});
	wrapEl.addEventListener('pointercancel', function() {
		isPanning = false;
		wrapEl.classList.remove('dragging');
	});
	wrapEl.addEventListener('wheel', function(e) {
		/* Always prevent the webview document from scrolling — if we let the default
		 * happen over a col-list the iframe body shifts, corrupting getBoundingClientRect
		 * and making subsequent zoom anchors jump wildly. */
		e.preventDefault();
		/* When over a col-list, forward the delta to the list's own scrollTop manually.
		 * Normalise: deltaMode 0 = pixels (scale down), 1 = lines, 2 = pages. */
		const colList = e.target.closest && e.target.closest('.col-list');
		if (colList) {
			const LINE_HEIGHT = 24;
			let px;
			if (e.deltaMode === 1) { px = e.deltaY * LINE_HEIGHT; }
			else if (e.deltaMode === 2) { px = e.deltaY * colList.clientHeight; }
			else { px = e.deltaY * 0.25; }  /* pixel mode — quarter the native delta */
			colList.scrollTop += px;
			return;
		}
		/* Don't zoom if a pan drag is active — the two conflict and cause erratic jumps */
		if (isPanning) return;
		const rect = wrapEl.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		const delta = e.deltaY > 0 ? 0.9 : 1.1;
		const newScale = Math.min(3, Math.max(0.15, scale * delta));
		panX = mx - (mx - panX) * (newScale / scale);
		panY = my - (my - panY) * (newScale / scale);
		scale = newScale;
		applyTransform();
	}, { passive: false });

	/* ── Render Graph ── */
	function setGraph(data) {
		const focusChanged = data.focusId !== lastFocusId;

		if (focusChanged && lastFocusId) {
			/* Save view state for the model we're navigating away from */
			savedStates.set(lastFocusId, {
				expandedCards: new Set(expandedCards),
				lastHighlightMsg: lastHighlightMsg,
				panX: panX, panY: panY, scale: scale,
			});
		}

		const restoredState = focusChanged ? savedStates.get(data.focusId) : null;
		if (focusChanged) {
			expandedCards.clear();
			lastHighlightMsg = null;
			if (restoredState) {
				for (const id of restoredState.expandedCards) expandedCards.add(id);
				lastHighlightMsg = restoredState.lastHighlightMsg;
			}
		}

		/* When depth changes (same focus model), preserve the focus node's screen position.
		 * Capture where the focus node currently sits on screen before replacing graphData. */
		let anchorScreenX = null, anchorScreenY = null, anchorNewNode = null;
		if (graphData && !focusChanged) {
			const oldNode = graphData.nodes.find(function(n) { return n.id === data.focusId; });
			if (oldNode) {
				anchorScreenX = oldNode.x * scale + panX;
				anchorScreenY = oldNode.y * scale + panY;
				anchorNewNode = data.nodes.find(function(n) { return n.id === data.focusId; });
			}
		}

		graphData = data;
		emptyEl.style.display = 'none';
		wrapEl.style.display = 'block';
		canvas.innerHTML = '';
		edgesSvg.innerHTML = '';
		edgesFgSvg.innerHTML = '';

		const CARD_W = 180;

		for (const node of data.nodes) {
			const card = document.createElement('div');
			card.className = 'card' + (node.isFocus ? ' focus' : '');
			card.dataset.id = node.id;
			card.style.left = (node.x - CARD_W / 2) + 'px';
			card.style.top = (node.y - node.height / 2) + 'px';

			const color = TYPE_COLORS[node.type] || 'var(--vscode-descriptionForeground)';
			const mat = node.materialisation;
			const subtitle = mat ? mat : node.type;
			const colCount = node.columns ? node.columns.length : 0;

			card.innerHTML =
				'<div class="card-header" data-file="' + escHtml(node.filePath || '') + '">' +
					'<span class="type-stripe" style="background:' + color + '"></span>' +
					'<span class="card-title" title="' + escHtml(node.id) + '">' + escHtml(node.label) + '</span>' +
					'<span class="card-subtitle">' + escHtml(subtitle) + '</span>' +
					(colCount > 0 ? '<button class="col-toggle" data-node="' + escHtml(node.id) + '">' + colCount + ' cols ▸</button>' : '') +
				'</div>';

			if (colCount > 0) {
				let colHtml = '<div class="col-list" style="display:none" data-cols="' + escHtml(node.id) + '">';
				for (const col of node.columns) {
					colHtml += '<div class="col-item" data-model="' + escHtml(node.id) + '" data-col="' + escHtml(col.name) + '">' +
						'<span class="col-dot"></span>' +
						escHtml(col.name) +
						(col.type ? '<span class="col-type">' + escHtml(col.type) + '</span>' : '') +
					'</div>';
				}
				colHtml += '</div>';
				card.innerHTML += colHtml;
			} else if (node.type === 'model' || node.type === 'source') {
				card.innerHTML += '<div class="col-list" style="display:none" data-cols="' + escHtml(node.id) + '"><div class="no-columns">No columns in manifest</div></div>';
			}

			canvas.appendChild(card);
		}

		/* Restore expanded state */
		for (const nodeId of expandedCards) {
			const colList = canvas.querySelector('[data-cols="' + CSS.escape(nodeId) + '"]');
			const toggle = canvas.querySelector('[data-node="' + CSS.escape(nodeId) + '"]');
			if (colList) {
				colList.style.display = '';
				if (toggle) toggle.textContent = toggle.textContent.replace('▸', '▾');
			}
		}

		drawEdges(data);

		/* Only fit to view when switching to a different model; preserve zoom/pan
		 * when the same model re-renders (e.g. column enrichment completing). */
		lastFocusId = data.focusId;
		if (focusChanged) {
			if (restoredState) {
				/* Returning to a previously-viewed model: restore pan/zoom and relayout
				 * expanded cards after the browser has had a chance to reflow. */
				panX = restoredState.panX;
				panY = restoredState.panY;
				scale = restoredState.scale;
				applyTransform();
				requestAnimationFrame(function() { relayoutAfterToggle(); });
			} else {
				fitToView(data);
			}
		} else if (anchorNewNode !== null) {
			/* Depth changed: keep focus node at the same screen position, same zoom. */
			panX = anchorScreenX - anchorNewNode.x * scale;
			panY = anchorScreenY - anchorNewNode.y * scale;
			applyTransform();
		}

		redrawColumnEdges();
		upDepthEl.textContent = data.upstreamDepth;
		dnDepthEl.textContent = data.downstreamDepth;

		/* Record initial card top positions (collapsed state) for re-layout after expand/collapse */
		nodeInitialTops.clear();
		for (const node of data.nodes) {
			nodeInitialTops.set(node.id, node.y - node.height / 2);
		}
	}

	/* ── Edges ── */
	function drawEdges(data) {
		edgesSvg.innerHTML = '';
		const nodeMap = {};
		for (const n of data.nodes) nodeMap[n.id] = n;

		const CARD_W = 180;
		const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
		defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="6" orient="auto-start-reverse"><polygon points="0,0 10,3 0,6"/></marker>';
		edgesSvg.appendChild(defs);

		for (const edge of data.edges) {
			const src = nodeMap[edge.source];
			const tgt = nodeMap[edge.target];
			if (!src || !tgt) continue;

			const srcCard = canvas.querySelector('[data-id="' + CSS.escape(edge.source) + '"]');
			const tgtCard = canvas.querySelector('[data-id="' + CSS.escape(edge.target) + '"]');
			const srcH = srcCard ? srcCard.offsetHeight : src.height;
			const tgtH = tgtCard ? tgtCard.offsetHeight : tgt.height;

			const x1 = src.x + CARD_W / 2;
			const y1 = src.y - src.height / 2 + srcH / 2;
			const x2 = tgt.x - CARD_W / 2;
			const y2 = tgt.y - tgt.height / 2 + tgtH / 2;
			const cx = (x1 + x2) / 2;

			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + cx + ',' + y1 + ' ' + cx + ',' + y2 + ' ' + x2 + ',' + y2);
			path.setAttribute('marker-end', 'url(#arrow)');
			edgesSvg.appendChild(path);
		}
	}

	/* ── Fit ── */
	function fitToView(data) {
		if (!data.nodes.length) return;
		const CARD_W = 180;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const n of data.nodes) {
			const left = n.x - CARD_W / 2;
			const top = n.y - n.height / 2;
			if (left < minX) minX = left;
			if (top < minY) minY = top;
			if (left + CARD_W > maxX) maxX = left + CARD_W;

			const card = canvas.querySelector('[data-id="' + CSS.escape(n.id) + '"]');
			const h = card ? card.offsetHeight : n.height;
			if (top + h > maxY) maxY = top + h;
		}
		const gw = maxX - minX;
		const gh = maxY - minY;
		const ww = wrapEl.clientWidth;
		const wh = wrapEl.clientHeight;
		const pad = 40;
		scale = Math.min(1.2, Math.min((ww - pad * 2) / gw, (wh - pad * 2) / gh));
		scale = Math.max(0.15, scale);
		panX = (ww - gw * scale) / 2 - minX * scale;
		panY = (wh - gh * scale) / 2 - minY * scale;
		applyTransform();
	}

	/* ── Re-layout after column expand/collapse ── */
	function relayoutAfterToggle() {
		if (!graphData) return;
		const GAP = 40;

		const rankMap = new Map();
		for (const node of graphData.nodes) {
			if (!rankMap.has(node.x)) rankMap.set(node.x, []);
			rankMap.get(node.x).push(node);
		}

		for (const nodes of rankMap.values()) {
			if (nodes.length <= 1) continue;
			nodes.sort(function(a, b) {
				return (nodeInitialTops.get(a.id) ?? a.y) - (nodeInitialTops.get(b.id) ?? b.y);
			});
			var top = nodeInitialTops.has(nodes[0].id)
				? nodeInitialTops.get(nodes[0].id)
				: nodes[0].y - nodes[0].height / 2;
			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				var card = canvas.querySelector('[data-id="' + CSS.escape(node.id) + '"]');
				var h = card ? card.offsetHeight : node.height;
				node.y = top + h / 2;			node.height = h;				if (card) card.style.top = top + 'px';
				top += h + GAP;
			}
		}
		drawEdges(graphData);
		/* Defer column edge redraw one frame so browser reflows card heights first */
		requestAnimationFrame(redrawColumnEdges);
	}

	/* ── Event Delegation ── */
	canvas.addEventListener('click', function(e) {
		const header = e.target.closest('.card-header');
		const toggleBtn = e.target.closest('.col-toggle');
		const colItem = e.target.closest('.col-item');

		if (toggleBtn) {
			e.stopPropagation();
			const nodeId = toggleBtn.dataset.node;
			const colList = canvas.querySelector('[data-cols="' + CSS.escape(nodeId) + '"]');
			if (!colList) return;
			const show = colList.style.display === 'none';
			colList.style.display = show ? '' : 'none';
			toggleBtn.textContent = toggleBtn.textContent.replace(show ? '▸' : '▾', show ? '▾' : '▸');
			if (show) expandedCards.add(nodeId); else expandedCards.delete(nodeId);
			relayoutAfterToggle();
			return;
		}

		if (colItem) {
			const model = colItem.dataset.model;
			const col = colItem.dataset.col;
			vscode.postMessage({ command: 'traceColumn', model: model, column: col });
			return;
		}

		if (header) {
			const fp = header.dataset.file;
			if (fp) vscode.postMessage({ command: 'openFile', filePath: fp });
		}
	});

	/* Redraw column edges on col-list scroll so the line tracks the scrolled position.
	 * Scroll events don't bubble, so use capture phase on the canvas container. */
	canvas.addEventListener('scroll', function(e) {
		if (e.target.classList && e.target.classList.contains('col-list')) {
			requestAnimationFrame(redrawColumnEdges);
		}
	}, true);

	/* ── Controls ── */
	document.getElementById('up-inc').addEventListener('click', function() {
		vscode.postMessage({ command: 'incrementUpstream' });
	});
	document.getElementById('up-dec').addEventListener('click', function() {
		vscode.postMessage({ command: 'decrementUpstream' });
	});
	document.getElementById('dn-inc').addEventListener('click', function() {
		vscode.postMessage({ command: 'incrementDownstream' });
	});
	document.getElementById('dn-dec').addEventListener('click', function() {
		vscode.postMessage({ command: 'decrementDownstream' });
	});
	document.getElementById('fit-btn').addEventListener('click', function() {
		if (graphData) fitToView(graphData);
	});

	window.addEventListener('message', function(event) {
		const msg = event.data;
		if (msg.command === 'setGraph') setGraph(msg);
		if (msg.command === 'highlightColumns') highlightColumns(msg);
		if (msg.command === 'updateColumns') updateColumns(msg);
		if (msg.command === 'columnLineageStatus') showStatus(msg);
		if (msg.command === 'clearFileState') savedStates.delete(msg.focusId);
	});

	function showStatus(msg) {
		var el = document.getElementById('status-bar');
		if (!el) {
			el = document.createElement('div');
			el.id = 'status-bar';
			document.body.appendChild(el);
		}
		if (msg.status === 'loading') {
			el.textContent = msg.message || 'Loading...';
			el.style.display = 'block';
			el.className = 'status-loading';
		} else if (msg.status === 'error') {
			el.textContent = msg.message || 'Error';
			el.style.display = 'block';
			el.className = 'status-error';
			setTimeout(function() { el.style.display = 'none'; }, 4000);
		} else {
			el.style.display = 'none';
		}
	}

	function updateColumns(msg) {
		if (!msg.nodeId || !msg.columns || !graphData) return;

		/* Update graphData nodes */
		for (const node of graphData.nodes) {
			if (node.id === msg.nodeId) {
				node.columns = msg.columns;
				break;
			}
		}

		/* Find the card and update its column list */
		const card = canvas.querySelector('[data-id="' + CSS.escape(msg.nodeId) + '"]');
		if (!card) return;

		/* Update or create toggle button */
		var toggle = card.querySelector('.col-toggle');
		var header = card.querySelector('.card-header');
		if (!toggle && header && msg.columns.length > 0) {
			toggle = document.createElement('button');
			toggle.className = 'col-toggle';
			toggle.dataset.node = msg.nodeId;
			toggle.textContent = msg.columns.length + ' cols ▸';
			header.appendChild(toggle);
		} else if (toggle) {
			toggle.textContent = msg.columns.length + ' cols ' + (expandedCards.has(msg.nodeId) ? '▾' : '▸');
		}

		/* Update or create column list */
		var colList = card.querySelector('.col-list');
		if (!colList) {
			colList = document.createElement('div');
			colList.className = 'col-list';
			colList.dataset.cols = msg.nodeId;
			colList.style.display = expandedCards.has(msg.nodeId) ? '' : 'none';
			card.appendChild(colList);
		}

		var colHtml = '';
		for (var i = 0; i < msg.columns.length; i++) {
			var col = msg.columns[i];
			colHtml += '<div class="col-item" data-model="' + escHtml(msg.nodeId) + '" data-col="' + escHtml(col.name) + '">' +
				'<span class="col-dot"></span>' +
				escHtml(col.name) +
				(col.type ? '<span class="col-type">' + escHtml(col.type) + '</span>' : '') +
			'</div>';
		}
		colList.innerHTML = colHtml;
		/* If this card is already expanded its height just changed — re-stack sibling cards */
		if (expandedCards.has(msg.nodeId)) {
			relayoutAfterToggle();
		}
		redrawColumnEdges();
	}

	function highlightColumns(msg) {
		lastHighlightMsg = msg.columns ? msg : null;
		canvas.querySelectorAll('.col-item.highlighted').forEach(function(el) {
			el.classList.remove('highlighted');
		});
		edgesFgSvg.querySelectorAll('.col-edge').forEach(function(el) {
			el.remove();
		});
		if (!msg.columns) return;

		const highlightedEls = [];
		for (const c of msg.columns) {
			const sel = '.col-item[data-model="' + CSS.escape(c.model) + '"][data-col="' + CSS.escape(c.column) + '"]';
			const el = canvas.querySelector(sel);
			if (el) {
				el.classList.add('highlighted');
				/* Scroll the col-list to reveal the highlighted item WITHOUT calling
				 * scrollIntoView — that can propagate to the webview iframe and shift
				 * wrapEl.getBoundingClientRect(), breaking the wheel zoom anchor. */
				const revealList = el.closest('.col-list');
				if (revealList) {
					const elTop = el.offsetTop;
					const elBottom = elTop + el.offsetHeight;
					if (elTop < revealList.scrollTop) {
						revealList.scrollTop = elTop;
					} else if (elBottom > revealList.scrollTop + revealList.clientHeight) {
						revealList.scrollTop = elBottom - revealList.clientHeight;
					}
				}
				highlightedEls.push({ model: c.model, column: c.column, el: el });
				const colList = el.closest('.col-list');
				if (colList && colList.style.display === 'none') {
					colList.style.display = '';
					const nodeId = colList.dataset.cols;
					expandedCards.add(nodeId);
					const toggle = canvas.querySelector('[data-node="' + CSS.escape(nodeId) + '"]');
					if (toggle) toggle.textContent = toggle.textContent.replace('▸', '▾');
				}
			}
		}

		if (graphData) {
			/* Defer everything one frame so the browser reflows expanded col-lists first.
			 * Reading card.offsetHeight before reflow returns stale collapsed heights
			 * causing relayoutAfterToggle to stack cards at wrong positions. */
			requestAnimationFrame(function() {
				relayoutAfterToggle();
				/* relayoutAfterToggle itself defers redrawColumnEdges via rAF — that will
				 * pick up lastHighlightMsg.  But we also need a second frame here to let
				 * relayoutAfterToggle's own DOM writes (card.style.top) settle before
				 * we sample positions for the column edges. */
				requestAnimationFrame(function() {
					drawEdges(graphData);
					drawColumnEdges(highlightedEls, msg.columnEdges || []);
				});
			});
		}
	}

	function drawColumnEdges(highlightedEls, columnEdges) {
		if (highlightedEls.length < 2 || !graphData || !columnEdges.length) return;

		const CARD_W = 180;
		const elByKey = {};
		for (const h of highlightedEls) {
			elByKey[h.model + '\x00' + h.column] = h;
		}

		const nodeMap = {};
		for (const n of graphData.nodes) nodeMap[n.id] = n;

		for (const edge of columnEdges) {
			const sc = elByKey[edge.sourceModel + '\x00' + edge.sourceColumn];
			const tc = elByKey[edge.targetModel + '\x00' + edge.targetColumn];
			if (!sc || !tc) continue;

			const srcNode = nodeMap[sc.model];
			const tgtNode = nodeMap[tc.model];
			if (!srcNode || !tgtNode) continue;

			/* Canvas-local Y of an element — works entirely in canvas coordinates.
			 * card.style.top is set by setGraph/relayoutAfterToggle in canvas-local px.
			 * el.offsetTop is offset from card top (col-list is position:static so card
			 * is the offsetParent). Subtract colList.scrollTop because the col-list has
			 * max-height + overflow-y:auto — the element may be scrolled out of view.
			 * If the element is outside the col-list's visible window, clamp Y to the
			 * visible edge so the line enters/exits at the list boundary. */
			function toCanvasY(el) {
				if (el.classList.contains('card')) {
					return parseInt(el.style.top) + el.offsetHeight / 2;
				}
				const card = el.closest('.card');
				const colList = el.closest('.col-list');
				if (!card) return 0;
				const cardTop = parseInt(card.style.top);
				if (!colList) return cardTop + el.offsetTop + el.offsetHeight / 2;
				/* el.offsetTop is relative to the card (nearest positioned ancestor),
				 * so it already includes colList.offsetTop. Subtract scrollTop to get
				 * the visible Y within the card. */
				const visY = el.offsetTop - colList.scrollTop + el.offsetHeight / 2;
				const listTop = colList.offsetTop;
				const listBottom = listTop + colList.clientHeight;
				return cardTop + Math.max(listTop, Math.min(listBottom, visY));
			}

			const x1 = srcNode.x + CARD_W / 2;
			const y1 = toCanvasY(sc.el);

			const x2 = tgtNode.x - CARD_W / 2;
			const y2 = toCanvasY(tc.el);

			const cx = (x1 + x2) / 2;
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + cx + ',' + y1 + ' ' + cx + ',' + y2 + ' ' + x2 + ',' + y2);
			path.setAttribute('class', 'col-edge');
			path.style.stroke = 'var(--vscode-charts-blue, #5B8DEF)';
			edgesFgSvg.appendChild(path);
		}
	}

	function redrawColumnEdges() {
		if (!lastHighlightMsg || !graphData) return;
		canvas.querySelectorAll('.col-item.highlighted').forEach(function(el) { el.classList.remove('highlighted'); });
		edgesFgSvg.querySelectorAll('.col-edge').forEach(function(el) { el.remove(); });
		const highlightedEls = [];
		for (const c of (lastHighlightMsg.columns || [])) {
			const sel = '.col-item[data-model="' + CSS.escape(c.model) + '"][data-col="' + CSS.escape(c.column) + '"]';
			const el = canvas.querySelector(sel);
			if (!el) continue;
			const colList = el.closest('.col-list');
			const isCollapsed = colList && colList.style.display === 'none';
			if (isCollapsed) {
				/* Card is collapsed — fall back to card element so lines flow to/from the card edge,
				 * just like model edges do. No highlight class since the column row is hidden. */
				const card = canvas.querySelector('[data-id="' + CSS.escape(c.model) + '"]');
				if (card) highlightedEls.push({ model: c.model, column: c.column, el: card });
			} else {
				el.classList.add('highlighted');
				/* Do NOT call scrollIntoView here — this function is called from
				 * the col-list scroll listener, so calling scrollIntoView would
				 * fight the user's scroll and/or trigger an infinite scroll loop. */
				highlightedEls.push({ model: c.model, column: c.column, el: el });
			}
		}
		drawColumnEdges(highlightedEls, lastHighlightMsg.columnEdges || []);
	}

	function escHtml(s) {
		if (!s) return '';
		return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
	}
})();
</script>
</body>
</html>`;
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
