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
	private _depth = 2;
	private _direction: 'both' | 'upstream' | 'downstream' = 'both';
	private _columnLineageTool?: GetColumnLineageTool;
	private _executionService?: DbtExecutionService;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

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
		void vscode.commands.executeCommand(
			'setContext',
			'dbt-studio.lineageFollowActive',
			this._followActive,
		);
	}

	setFocusModel(uniqueId: string): void {
		if (this._focusModel === uniqueId) return;
		this._focusModel = uniqueId;
		this._updateGraph();
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
			if (msg['command'] === 'setDepth' && typeof msg['depth'] === 'number') {
				this._depth = msg['depth'] as number;
				this._updateGraph();
			}
			if (msg['command'] === 'setDirection' && typeof msg['direction'] === 'string') {
				this._direction = msg['direction'] as 'both' | 'upstream' | 'downstream';
				this._updateGraph();
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

		// Ensure manifest exists before building the graph
		const ready = await this._ensureParsed();
		if (!ready) {
			void this._view.webview.postMessage({ command: 'setGraph', nodes: [], edges: [], focusId: this._focusModel, depth: this._depth, direction: this._direction });
			return;
		}

		const index = this.indexer.index;
		if (!index) return;

		const lineage = this.indexer.getLineage(this._focusModel, this._depth, this._direction);
		const { nodes, edges } = this._buildGraph(index, lineage, this._focusModel);
		this._computeLayout(nodes, edges);

		void this._view.webview.postMessage({
			command: 'setGraph',
			nodes,
			edges,
			focusId: this._focusModel,
			depth: this._depth,
			direction: this._direction,
		});

		// Progressively enrich columns for nodes that have compiled SQL
		if (this._columnLineageTool) {
			void this._enrichColumns(nodes);
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

	private async _enrichColumns(nodes: PositionedNode[]): Promise<void> {
		if (!this._view || !this._columnLineageTool) return;

		for (const node of nodes) {
			if (node.columns.length > 0) continue;
			try {
				const cols = await this._columnLineageTool.resolveColumnsForNode(node.id);
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
	): { nodes: PositionedNode[]; edges: GraphEdge[] } {
		const allIds = new Set<string>();
		allIds.add(focusId);
		for (const node of lineage.upstream) allIds.add(node.uniqueId);
		for (const node of lineage.downstream) allIds.add(node.uniqueId);

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
.controls label { font-size: 11px; color: var(--vscode-descriptionForeground); }
.controls select, .controls input {
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	padding: 2px 4px; font-size: 11px; border-radius: 2px;
}
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
	z-index: 1;
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
	<label>Depth</label>
	<input type="number" id="depth" min="1" max="10" value="2" style="width:48px">
	<label>Direction</label>
	<select id="direction">
		<option value="both" selected>Both</option>
		<option value="upstream">Upstream</option>
		<option value="downstream">Downstream</option>
	</select>
	<div class="legend">
		<span class="legend-item"><span class="swatch" style="background:var(--vscode-charts-blue, #5B8DEF)"></span>Model</span>
		<span class="legend-item"><span class="swatch" style="background:var(--vscode-charts-green, #43A686)"></span>Source</span>
		<span class="legend-item"><span class="swatch" style="background:var(--vscode-charts-purple, #C77DBA)"></span>Test</span>
		<span class="legend-item"><span class="swatch" style="background:var(--vscode-charts-orange, #E8963E)"></span>Exposure</span>
	</div>
</div>
<div id="canvas-wrap" style="display:none">
	<svg class="edges" id="edges"></svg>
	<div id="canvas"></div>
</div>
<div id="empty" class="empty-state">Open a dbt model to see its lineage graph</div>

<script nonce="${nonce}">
(function() {
	const vscode = acquireVsCodeApi();
	const canvas = document.getElementById('canvas');
	const edgesSvg = document.getElementById('edges');
	const wrapEl = document.getElementById('canvas-wrap');
	const emptyEl = document.getElementById('empty');
	const depthInput = document.getElementById('depth');
	const dirSelect = document.getElementById('direction');

	const TYPE_COLORS = {
		model:    'var(--vscode-charts-blue, #5B8DEF)',
		source:   'var(--vscode-charts-green, #43A686)',
		test:     'var(--vscode-charts-purple, #C77DBA)',
		exposure: 'var(--vscode-charts-orange, #E8963E)',
		metric:   'var(--vscode-charts-orange, #E8963E)',
		seed:     'var(--vscode-charts-yellow, #8B7355)',
		snapshot: 'var(--vscode-descriptionForeground)',
	};

	let panX = 0, panY = 0, scale = 1;
	let isPanning = false, startX = 0, startY = 0;
	let graphData = null;
	const expandedCards = new Set();
	const nodeInitialTops = new Map();

	/* ── Pan & Zoom ── */
	function applyTransform() {
		canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
		edgesSvg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
	}

	wrapEl.addEventListener('pointerdown', function(e) {
		if (e.target.closest('.card')) return;
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
	wrapEl.addEventListener('wheel', function(e) {
		e.preventDefault();
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
		graphData = data;
		emptyEl.style.display = 'none';
		wrapEl.style.display = 'block';
		canvas.innerHTML = '';
		edgesSvg.innerHTML = '';

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
		fitToView(data);

		depthInput.value = data.depth;
		dirSelect.value = data.direction;

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

	/* ── Controls ── */
	depthInput.addEventListener('change', function() {
		const val = parseInt(depthInput.value, 10);
		if (val >= 1 && val <= 10) {
			vscode.postMessage({ command: 'setDepth', depth: val });
		}
	});
	dirSelect.addEventListener('change', function() {
		vscode.postMessage({ command: 'setDirection', direction: dirSelect.value });
	});

	window.addEventListener('message', function(event) {
		const msg = event.data;
		if (msg.command === 'setGraph') setGraph(msg);
		if (msg.command === 'highlightColumns') highlightColumns(msg);
		if (msg.command === 'updateColumns') updateColumns(msg);
		if (msg.command === 'columnLineageStatus') showStatus(msg);
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
	}

	function highlightColumns(msg) {
		canvas.querySelectorAll('.col-item.highlighted').forEach(function(el) {
			el.classList.remove('highlighted');
		});
		edgesSvg.querySelectorAll('.col-edge').forEach(function(el) {
			el.remove();
		});
		if (!msg.columns) return;

		const highlightedEls = [];
		for (const c of msg.columns) {
			const sel = '.col-item[data-model="' + CSS.escape(c.model) + '"][data-col="' + CSS.escape(c.column) + '"]';
			const el = canvas.querySelector(sel);
			if (el) {
				el.classList.add('highlighted');
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
			drawEdges(graphData);
			drawColumnEdges(highlightedEls, msg.columnEdges || []);
		}
	}

	function drawColumnEdges(highlightedEls, columnEdges) {
		if (highlightedEls.length < 2 || !graphData || !columnEdges.length) return;

		const elByKey = {};
		for (const h of highlightedEls) {
			elByKey[h.model + '\x00' + h.column] = h;
		}

		for (const edge of columnEdges) {
			const sc = elByKey[edge.sourceModel + '\x00' + edge.sourceColumn];
			const tc = elByKey[edge.targetModel + '\x00' + edge.targetColumn];
			if (!sc || !tc) continue;

			const srcRect = sc.el.getBoundingClientRect();
			const tgtRect = tc.el.getBoundingClientRect();
			const canvasRect = canvas.getBoundingClientRect();

			/* Convert screen coords to canvas-local coords */
			const x1 = (srcRect.right - canvasRect.left) / scale;
			const y1 = (srcRect.top + srcRect.height / 2 - canvasRect.top) / scale;
			const x2 = (tgtRect.left - canvasRect.left) / scale;
			const y2 = (tgtRect.top + tgtRect.height / 2 - canvasRect.top) / scale;
			const cx = (x1 + x2) / 2;

			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + cx + ',' + y1 + ' ' + cx + ',' + y2 + ' ' + x2 + ',' + y2);
			path.setAttribute('class', 'col-edge');
			path.style.stroke = 'var(--vscode-charts-blue, #5B8DEF)';
			edgesSvg.appendChild(path);
		}
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
