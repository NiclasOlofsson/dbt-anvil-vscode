import * as vscode from 'vscode';
import * as dagre from '@dagrejs/dagre';
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
	depthLevel: number;
}

interface GraphEdge {
	source: string;
	target: string;
}

const HEADER_HEIGHT = 44;
const LAYOUT_STORAGE_KEY = 'dbt-studio.lineageLayoutConfig';
const DEFAULT_LAYOUT_CONFIG = {
	graph: {
		rankdir: 'LR',
		ranksep: 105,
		nodesep: 5,
		edgesep: 0,
		align: 'none',
		ranker: 'tight-tree',
		marginx: 20,
		marginy: 10,
	},
	node: {
		width: 140,
		heightPadding: 0,
	},
	edge: {
		minlen: 1,
		weight: 1,
		strokeWidth: 0.25,
		opacity: 0.45,
	},
};

function cloneLayoutConfig<T>(config: T): T {
	return JSON.parse(JSON.stringify(config)) as T;
}

function normalizeLayoutConfig(config: unknown): typeof DEFAULT_LAYOUT_CONFIG {
	const value = (config ?? {}) as Record<string, unknown>;
	const graph = (value.graph ?? {}) as Record<string, unknown>;
	const node = (value.node ?? {}) as Record<string, unknown>;
	const edge = (value.edge ?? {}) as Record<string, unknown>;
	return {
		graph: {
			rankdir: typeof graph.rankdir === 'string' ? graph.rankdir : DEFAULT_LAYOUT_CONFIG.graph.rankdir,
			ranksep: typeof graph.ranksep === 'number' ? graph.ranksep : DEFAULT_LAYOUT_CONFIG.graph.ranksep,
			nodesep: typeof graph.nodesep === 'number' ? graph.nodesep : DEFAULT_LAYOUT_CONFIG.graph.nodesep,
			edgesep: typeof graph.edgesep === 'number' ? graph.edgesep : DEFAULT_LAYOUT_CONFIG.graph.edgesep,
			align: typeof graph.align === 'string' ? graph.align : DEFAULT_LAYOUT_CONFIG.graph.align,
			ranker: typeof graph.ranker === 'string' ? graph.ranker : DEFAULT_LAYOUT_CONFIG.graph.ranker,
			marginx: typeof graph.marginx === 'number' ? graph.marginx : DEFAULT_LAYOUT_CONFIG.graph.marginx,
			marginy: typeof graph.marginy === 'number' ? graph.marginy : DEFAULT_LAYOUT_CONFIG.graph.marginy,
		},
		node: {
			width: typeof node.width === 'number' ? node.width : DEFAULT_LAYOUT_CONFIG.node.width,
			heightPadding: typeof node.heightPadding === 'number' ? node.heightPadding : DEFAULT_LAYOUT_CONFIG.node.heightPadding,
		},
		edge: {
			minlen: typeof edge.minlen === 'number' ? edge.minlen : DEFAULT_LAYOUT_CONFIG.edge.minlen,
			weight: typeof edge.weight === 'number' ? edge.weight : DEFAULT_LAYOUT_CONFIG.edge.weight,
			strokeWidth: typeof edge.strokeWidth === 'number' ? edge.strokeWidth : DEFAULT_LAYOUT_CONFIG.edge.strokeWidth,
			opacity: typeof edge.opacity === 'number' ? edge.opacity : DEFAULT_LAYOUT_CONFIG.edge.opacity,
		},
	};
}

export class LineageGraphProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'dbt-studio.lineageGraph';

	private _view?: vscode.WebviewView;
	private _focusModel?: string;
	private _followActive = true;
	private _upstreamDepth = 2;
	private _downstreamDepth = 1;
	private _enrichGeneration = 0;
	private readonly _depthPerModel = new Map<string, { upstream: number; downstream: number }>();
	private readonly _expandedNodesPerModel = new Map<string, Set<string>>();
	private _showTests: boolean;
	private _columnLineageTool?: GetColumnLineageTool;
	private _executionService?: DbtExecutionService;
	private _layoutConfig = cloneLayoutConfig(DEFAULT_LAYOUT_CONFIG);
	private _savedLayoutConfig?: typeof DEFAULT_LAYOUT_CONFIG;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly globalState: vscode.Memento,
		private readonly workspaceState: vscode.Memento,
	) {
		this._followActive = globalState.get<boolean>('dbt-studio.lineageFollowActive', true);
		const storedLayout = workspaceState.get<unknown>(LAYOUT_STORAGE_KEY);
		if (storedLayout !== undefined) {
			this._savedLayoutConfig = normalizeLayoutConfig(storedLayout);
			this._layoutConfig = cloneLayoutConfig(this._savedLayoutConfig);
		}
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
			if (msg['command'] === 'setExpandedNodes' && Array.isArray(msg['nodeIds'])) {
				if (!this._focusModel) return;
				const nodeIds = (msg['nodeIds'] as unknown[]).filter((x): x is string => typeof x === 'string');
				const next = new Set(nodeIds);
				const prev = this._expandedNodesPerModel.get(this._focusModel);
				const same = prev !== undefined
					&& prev.size === next.size
					&& [...next].every(id => prev.has(id));
				if (!same) {
					this._expandedNodesPerModel.set(this._focusModel, next);
					this._updateGraph();
				}
			}
			if (msg['command'] === 'setLayoutConfig') {
				this._layoutConfig = normalizeLayoutConfig(msg['config']);
				this._updateGraph();
			}
			if (msg['command'] === 'saveLayoutConfig') {
				const cfg = normalizeLayoutConfig(msg['config']);
				this._savedLayoutConfig = cloneLayoutConfig(cfg);
				this._layoutConfig = cloneLayoutConfig(cfg);
				void this.workspaceState.update(LAYOUT_STORAGE_KEY, this._savedLayoutConfig);
				void this._view?.webview.postMessage({
					command: 'layoutConfigSaved',
					message: 'Saved layout config',
					storedLayoutConfig: this._savedLayoutConfig,
				});
			}
			if (msg['command'] === 'copyLayoutConfig') {
				const cfg = normalizeLayoutConfig(msg['config']);
				const text = `{ graph: { rankdir: '${cfg.graph.rankdir}', ranksep: ${cfg.graph.ranksep}, nodesep: ${cfg.graph.nodesep}, edgesep: ${cfg.graph.edgesep}, align: '${cfg.graph.align}', ranker: '${cfg.graph.ranker}', marginx: ${cfg.graph.marginx}, marginy: ${cfg.graph.marginy} }, node: { width: ${cfg.node.width}, heightPadding: ${cfg.node.heightPadding} }, edge: { minlen: ${cfg.edge.minlen}, weight: ${cfg.edge.weight}, strokeWidth: ${cfg.edge.strokeWidth}, opacity: ${cfg.edge.opacity} } }`;
				void vscode.env.clipboard.writeText(text);
				void this._view?.webview.postMessage({
					command: 'layoutConfigCopied',
					message: 'Copied layout config',
				});
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
			layoutConfig: this._layoutConfig,
			storedLayoutConfig: this._savedLayoutConfig,
			defaultLayoutConfig: DEFAULT_LAYOUT_CONFIG,
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

		// Topological sort (Kahn's algorithm) using the manifest parentMap so that
		// upstream nodes are always enriched before their dependents. This ensures
		// _buildSchemaMapping finds already-resolved columns for upstream nodes.
		const index = this.indexer.index;
		const nodeIds = new Set(nodes.map(n => n.id));
		// Build in-degree and adjacency restricted to the visible node set
		const inDegree = new Map<string, number>();
		const children = new Map<string, string[]>();
		for (const node of nodes) {
			inDegree.set(node.id, 0);
			children.set(node.id, []);
		}
		for (const node of nodes) {
			const parents = index?.parentMap.get(node.id) ?? [];
			for (const parent of parents) {
				if (!nodeIds.has(parent)) continue;
				inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
				children.get(parent)!.push(node.id);
			}
		}
		const queue: string[] = [];
		for (const [id, deg] of inDegree) {
			if (deg === 0) queue.push(id);
		}
		const ordered: string[] = [];
		while (queue.length > 0) {
			const id = queue.shift()!;
			ordered.push(id);
			for (const child of children.get(id) ?? []) {
				const deg = (inDegree.get(child) ?? 1) - 1;
				inDegree.set(child, deg);
				if (deg === 0) queue.push(child);
			}
		}
		// Any nodes not reached (cycle) fall through at the end
		for (const node of nodes) {
			if (!ordered.includes(node.id)) ordered.push(node.id);
		}
		const nodeById = new Map(nodes.map(n => [n.id, n]));

		for (const id of ordered) {
			const node = nodeById.get(id);
			if (!node) continue;
			if (gen !== this._enrichGeneration) return;
			// Skip if columns are already in the live store.
			// NOTE: check the indexer's live column store, NOT node.columns — node.columns
			// is populated from YAML manifest columns and is unrelated to the live store.
			const storedCols = this.indexer.getColumns(node.id);
			if (storedCols && storedCols.length > 0) continue;
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
			// before highlighting — progressive enrichment may not have reached them yet.
			// If resolveColumnsForNode returns nothing (e.g. select * with no manifest docs),
			// inject the specific columns from the trace so their col-items exist in the DOM.
			if (this._columnLineageTool) {
				const uniqueNodes = [...new Set(columns.map(c => c.model))];
				for (const nodeId of uniqueNodes) {
					try {
						let cols = await this._columnLineageTool.resolveColumnsForNode(nodeId);
						if (cols.length === 0) {
							cols = columns.filter(c => c.model === nodeId).map(c => c.column);
						}
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
		const expandedNodes = this._expandedNodesPerModel.get(focusId) ?? new Set<string>();
		const computeNodeHeight = (id: string, type: string, colCount: number): number => {
			if (!expandedNodes.has(id)) return HEADER_HEIGHT;
			if (colCount > 0) {
				const rowHeight = 16;
				const listHeight = Math.min(200, colCount * rowHeight);
				return HEADER_HEIGHT + listHeight;
			}
			if (type === 'model' || type === 'source') return HEADER_HEIGHT + 22;
			return HEADER_HEIGHT;
		};

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
			// Prefer live columns from the store; fall back to YAML manifest
			const liveColumns = this.indexer.getColumns(id);
			if (liveColumns && liveColumns.length > 0) {
				for (const col of liveColumns) {
					columns.push({ name: col });
				}
			} else if (rawNode && 'columns' in rawNode) {
				for (const col of Object.values(rawNode.columns)) {
					columns.push({ name: col.name, type: col.data_type });
				}
			}

			const model = index.models.get(id);
			const source = index.sources.get(id);
			if (model) {
				const height = computeNodeHeight(id, 'model', columns.length);
				nodes.push({
					id,
					label: model.name,
					type: 'model',
					materialisation: model.materialisation,
					filePath: model.path,
					isFocus: id === focusId,
					columns,
					x: 0, y: 0,
					width: this._layoutConfig.node.width,
					height,
					depthLevel: 0,
				});
			} else if (source) {
				const height = computeNodeHeight(id, 'source', columns.length);
				nodes.push({
					id,
					label: source.name,
					type: 'source',
					isFocus: id === focusId,
					columns,
					x: 0, y: 0,
					width: this._layoutConfig.node.width,
					height,
					depthLevel: 0,
				});
			} else {
				const kind = id.split('.')[0];
				const name = id.split('.').pop() ?? id;
				const height = computeNodeHeight(id, kind, columns.length);
				nodes.push({
					id,
					label: name,
					type: kind,
					isFocus: id === focusId,
					columns,
					x: 0, y: 0,
					width: this._layoutConfig.node.width,
					height,
					depthLevel: 0,
				});
			}
		}

		// Compute depth level with independent traversals:
		// focus=0, upstream=+N (via parentMap), downstream=-N (via childMap)
		const upstreamDist = new Map<string, number>();
		const downstreamDist = new Map<string, number>();

		const upQueue: Array<{ id: string; d: number }> = [{ id: focusId, d: 0 }];
		upstreamDist.set(focusId, 0);
		while (upQueue.length > 0) {
			const { id, d } = upQueue.shift()!;
			for (const parent of (index.parentMap.get(id) ?? [])) {
				if (!allIds.has(parent) || upstreamDist.has(parent)) continue;
				const nd = d + 1;
				upstreamDist.set(parent, nd);
				upQueue.push({ id: parent, d: nd });
			}
		}

		const dnQueue: Array<{ id: string; d: number }> = [{ id: focusId, d: 0 }];
		downstreamDist.set(focusId, 0);
		while (dnQueue.length > 0) {
			const { id, d } = dnQueue.shift()!;
			for (const child of (index.childMap.get(id) ?? [])) {
				if (!allIds.has(child) || downstreamDist.has(child)) continue;
				const nd = d + 1;
				downstreamDist.set(child, nd);
				dnQueue.push({ id: child, d: nd });
			}
		}

		// Assign depth levels to nodes
		for (const node of nodes) {
			if (node.id === focusId) {
				node.depthLevel = 0;
				continue;
			}
			const up = upstreamDist.get(node.id);
			const dn = downstreamDist.get(node.id);
			if (up !== undefined && up > 0 && (dn === undefined || up <= dn)) {
				node.depthLevel = up;
			} else if (dn !== undefined && dn > 0) {
				node.depthLevel = -dn;
			} else {
				node.depthLevel = 0;
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
		const graphOpts: dagre.GraphLabel = {
			rankdir: this._layoutConfig.graph.rankdir as dagre.GraphLabel['rankdir'],
			nodesep: this._layoutConfig.graph.nodesep,
			edgesep: this._layoutConfig.graph.edgesep,
			ranksep: this._layoutConfig.graph.ranksep,
			marginx: this._layoutConfig.graph.marginx,
			marginy: this._layoutConfig.graph.marginy,
		};
		if (this._layoutConfig.graph.align && this._layoutConfig.graph.align !== 'none') {
			graphOpts.align = this._layoutConfig.graph.align as dagre.GraphLabel['align'];
		}
		if (this._layoutConfig.graph.ranker && this._layoutConfig.graph.ranker !== 'network-simplex') {
			graphOpts.ranker = this._layoutConfig.graph.ranker as 'network-simplex' | 'tight-tree' | 'longest-path';
		}

		g.setGraph(graphOpts);
		g.setDefaultEdgeLabel(() => ({}));

		for (const node of nodes) {
			g.setNode(node.id, { width: node.width, height: node.height + this._layoutConfig.node.heightPadding });
		}
		for (const edge of edges) {
			g.setEdge(edge.source, edge.target, { minlen: this._layoutConfig.edge.minlen, weight: this._layoutConfig.edge.weight });
		}

		dagre.layout(g);

		for (const node of nodes) {
			const pos = g.node(node.id);
			node.x = pos.x;
			node.y = pos.y;
		}
		// Column wrapping and relaxation are handled in the webview JS
		// where the viewport dimensions are known.
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
	--layout-panel-width: 272px;
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
	transition: width 180ms ease;
}
body.layout-panel-open #canvas-wrap {
	width: calc(100% - var(--layout-panel-width));
}
#canvas-wrap.dragging { cursor: grabbing; }
#canvas {
	position: absolute; top: 0; left: 0;
	transform-origin: 0 0;
	z-index: 2;
}
#bands {
	position: absolute; top: 0; left: 0;
	transform-origin: 0 0;
	pointer-events: none;
	z-index: 0;
}
.depth-band {
	position: absolute;
	border-radius: 6px;
	pointer-events: none;
}
svg.edges {
	position: absolute; top: 0; left: 0;
	transform-origin: 0 0;
	pointer-events: none; overflow: visible;
	z-index: 1;
}
svg.edges path {
	fill: none;
	stroke: var(--vscode-foreground);
	stroke-width: var(--edge-stroke-width, 0.25);
	stroke-opacity: var(--edge-opacity, 0.45);
}
svg.edges path.col-edge {
	stroke-opacity: calc(var(--edge-opacity, 0.45) * 0.7);
}
svg.edges polygon {
	fill: var(--vscode-foreground);
	opacity: var(--edge-opacity, 0.45);
}
#edges-fg {
	z-index: 3;
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
	border-left: 3px solid var(--vscode-focusBorder);
	box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}
.card-header {
	display: flex; align-items: flex-start; gap: 6px;
	padding: 6px 8px;
	background: transparent;
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
.depth-label {
	font-size: 9px; font-weight: 400; font-family: monospace;
	color: var(--vscode-descriptionForeground);
	margin-right: 3px;
	flex-shrink: 0;
}
.card-subtitle {
	font-size: 9px;
	color: var(--vscode-descriptionForeground);
	flex: 1;
}
.col-toggle {
	font-size: 9px; cursor: pointer; flex-shrink: 0;
	color: var(--vscode-descriptionForeground);
	background: none; border: none; padding: 0;
	line-height: 1;
	align-self: baseline;
}
.col-toggle:hover { color: var(--vscode-foreground); }
.card-text-wrapper {
	display: flex; flex-direction: column; gap: 1px; flex: 1;
	overflow: hidden;
}
.card-title-row {
	display: flex;
	align-items: baseline;
	gap: 8px;
	min-height: 14px;
}
.card-subtitle-row {
	display: flex;
	align-items: baseline;
	gap: 8px;
	min-height: 12px;
}
.type-badge {
	display: inline-block;
	font-size: 8px; font-weight: 700; line-height: 1;
	padding: 2px 3px; border-radius: 2px;
	flex-shrink: 0; margin-right: 4px;
	background: rgba(0, 0, 0, 0.2);
	color: var(--vscode-foreground);
}
.open-file-trigger {
	cursor: pointer;
}
.col-list {
	max-height: 200px; overflow-y: auto;
}
.col-item {
	display: flex; align-items: center; gap: 4px;
	position: relative;
	padding: 2px 8px 2px 38px;
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
	position: absolute;
	left: 28px;
	width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
	background: var(--vscode-descriptionForeground);
}
.no-columns {
	padding: 4px 8px 6px 38px;
	font-size: 10px; font-style: italic;
	color: var(--vscode-descriptionForeground);
}

.empty-state {
	display: flex; justify-content: center; align-items: center;
	height: calc(100% - 36px);
	width: 100%;
	color: var(--vscode-descriptionForeground);
	font-size: 13px; text-align: center; padding: 16px;
	transition: width 180ms ease;
}
body.layout-panel-open .empty-state {
	width: calc(100% - var(--layout-panel-width));
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
.layout-panel {
	position: fixed;
	top: 36px;
	right: 0;
	bottom: 0;
	width: var(--layout-panel-width);
	background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
	border-left: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	box-shadow: -6px 0 14px rgba(0,0,0,0.16);
	z-index: 20;
	font-size: 11px;
	display: flex;
	flex-direction: column;
	transform: translateX(100%);
	transition: transform 180ms ease;
}
.layout-panel.hidden {
	transform: translateX(100%);
	pointer-events: none;
}
body.layout-panel-open .layout-panel {
	transform: translateX(0);
	pointer-events: auto;
}
.layout-panel-title {
	padding: 7px 10px;
	font-weight: 600;
	font-size: 11px;
	border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	background: var(--vscode-sideBar-background);
	display: flex; align-items: center; justify-content: space-between;
}
.layout-panel-close {
	background: none; border: none; cursor: pointer;
	color: var(--vscode-foreground); opacity: 0.6; font-size: 13px; line-height: 1; padding: 0;
}
.layout-panel-close:hover { opacity: 1; }
.layout-panel-body {
	padding: 10px;
	display: flex;
	flex-direction: column;
	gap: 10px;
	flex: 1;
	overflow-y: auto;
}
.layout-section {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.layout-section-title {
	font-size: 10px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--vscode-descriptionForeground);
}
.layout-row { display: flex; flex-direction: column; gap: 4px; }
.layout-label {
	display: flex; justify-content: space-between; align-items: baseline;
	color: var(--vscode-foreground);
}
.layout-label-text { font-size: 10px; font-weight: 600; }
.layout-value { font-size: 10px; font-family: monospace; color: var(--vscode-descriptionForeground); }
.layout-slider {
	-webkit-appearance: none;
	appearance: none;
	width: 100%;
	height: 6px;
	border-radius: 2px;
	background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.25));
	cursor: pointer;
}
.layout-slider::-webkit-slider-runnable-track {
	height: 6px;
	border-radius: 2px;
	background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.25));
}
.layout-slider::-webkit-slider-thumb {
	-webkit-appearance: none;
	appearance: none;
	margin-top: -2px;
	width: 10px;
	height: 10px;
	border-radius: 3px;
	border: 1px solid var(--vscode-focusBorder, #007fd4);
	background: var(--vscode-button-background, var(--vscode-input-background));
}
.layout-slider::-moz-range-track {
	height: 6px;
	border-radius: 2px;
	border: none;
	background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.25));
}
.layout-slider::-moz-range-thumb {
	width: 10px;
	height: 10px;
	border-radius: 3px;
	border: 1px solid var(--vscode-focusBorder, #007fd4);
	background: var(--vscode-button-background, var(--vscode-input-background));
}
.layout-select {
	width: 100%;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	border-radius: 2px;
	font-size: 10px;
	padding: 2px 4px;
}
.layout-divider { height: 1px; background: var(--vscode-editorWidget-border, var(--vscode-panel-border)); margin: 4px 0; }
.layout-reset-btn {
	background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	border: 1px solid var(--vscode-input-border, transparent);
	border-radius: 3px; cursor: pointer; font-size: 10px;
	padding: 3px 8px; width: 100%; text-align: center;
}
.layout-reset-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.layout-copy-btn {
	background: var(--vscode-button-background, var(--vscode-button-secondaryBackground, var(--vscode-input-background)));
	color: var(--vscode-button-foreground, var(--vscode-button-secondaryForeground, var(--vscode-foreground)));
	border: 1px solid var(--vscode-button-border, var(--vscode-input-border, transparent));
	border-radius: 3px; cursor: pointer; font-size: 10px;
	padding: 3px 8px; width: 100%; text-align: center;
}
.layout-copy-btn:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground))); }
.settings-btn {
	background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	border: 1px solid var(--vscode-input-border, transparent);
	padding: 2px 7px; font-size: 12px; border-radius: 3px; cursor: pointer;
}
.settings-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
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
		<span class="legend-item"><span class="swatch" style="background:#D4A516"></span>Seed</span>
		<span class="legend-item"><span class="swatch" style="background:var(--vscode-charts-purple, #C77DBA)"></span>Test</span>
		<span class="legend-item"><span class="swatch" style="background:#A97FBE"></span>Unit Test</span>
	</div>
	<button class="settings-btn" id="layout-toggle" title="Layout settings">⚙</button>
</div>
<div id="canvas-wrap" style="display:none">
	<div id="bands"></div>
	<svg class="edges" id="edges"></svg>
	<div id="canvas"></div>
	<svg class="edges" id="edges-fg"></svg>
</div>
<div class="layout-panel hidden" id="layout-panel">
	<div class="layout-panel-title">
		<span>Layout Settings</span>
		<button class="layout-panel-close" id="layout-panel-close">✕</button>
	</div>
	<div class="layout-panel-body">
		<div class="layout-section">
			<div class="layout-section-title">Graph</div>
			<div class="layout-row">
				<div class="layout-label"><span class="layout-label-text">Flow direction</span></div>
				<select class="layout-select" id="rankdir">
					<option value="TB">TB (top-bottom)</option>
					<option value="BT">BT (bottom-top)</option>
					<option value="LR" selected>LR (left-right)</option>
					<option value="RL">RL (right-left)</option>
				</select>
			</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Rank separation</span>
					<span class="layout-value" id="ranksep-val">105</span>
				</div>
				<input type="range" class="layout-slider" id="ranksep" min="10" max="200" step="5" value="105">
			</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Node separation</span>
					<span class="layout-value" id="nodesep-val">5</span>
				</div>
				<input type="range" class="layout-slider" id="nodesep" min="5" max="80" step="5" value="5">
			</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Edge separation</span>
					<span class="layout-value" id="edgesep-val">0</span>
				</div>
				<input type="range" class="layout-slider" id="edgesep" min="0" max="40" step="2" value="0">
			</div>
			<div class="layout-row">
				<div class="layout-label"><span class="layout-label-text">Alignment</span></div>
				<select class="layout-select" id="align">
					<option value="UL">UL (upper-left)</option>
					<option value="UR">UR (upper-right)</option>
					<option value="DL">DL (down-left)</option>
					<option value="DR">DR (down-right)</option>
					<option value="none" selected>none (centered)</option>
				</select>
			</div>
			<div class="layout-row">
				<div class="layout-label"><span class="layout-label-text">Ranking algorithm</span></div>
				<select class="layout-select" id="ranker">
					<option value="network-simplex">Network simplex</option>
					<option value="tight-tree" selected>Tight tree</option>
					<option value="longest-path">Longest path</option>
				</select>
			</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Margin X</span>
					<span class="layout-value" id="marginx-val">20</span>
				</div>
				<input type="range" class="layout-slider" id="marginx" min="0" max="100" step="5" value="20">
			</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Margin Y</span>
					<span class="layout-value" id="marginy-val">10</span>
				</div>
				<input type="range" class="layout-slider" id="marginy" min="0" max="100" step="5" value="10">
			</div>
		</div>
		<div class="layout-divider"></div>
		<div class="layout-section">
			<div class="layout-section-title">Node</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Width</span>
					<span class="layout-value" id="node-width-val">140</span>
				</div>
				<input type="range" class="layout-slider" id="node-width" min="140" max="260" step="10" value="140">
			</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Vertical padding</span>
					<span class="layout-value" id="node-height-padding-val">0</span>
				</div>
				<input type="range" class="layout-slider" id="node-height-padding" min="0" max="80" step="4" value="0">
			</div>
		</div>
		<div class="layout-divider"></div>
		<div class="layout-section">
			<div class="layout-section-title">Edge</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Line width</span>
					<span class="layout-value" id="edge-stroke-width-val">0.25</span>
				</div>
				<input type="range" class="layout-slider" id="edge-stroke-width" min="0.25" max="5" step="0.25" value="0.25">
			</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Opacity</span>
					<span class="layout-value" id="edge-opacity-val">0.45</span>
				</div>
				<input type="range" class="layout-slider" id="edge-opacity" min="0.05" max="1" step="0.05" value="0.45">
			</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Minimum rank span</span>
					<span class="layout-label-text">minlen</span>
					<span class="layout-value" id="edge-minlen-val">1</span>
				</div>
				<input type="range" class="layout-slider" id="edge-minlen" min="1" max="5" step="1" value="1">
			</div>
			<div class="layout-row">
				<div class="layout-label">
					<span class="layout-label-text">Edge weight</span>
					<span class="layout-value" id="edge-weight-val">1</span>
				</div>
				<input type="range" class="layout-slider" id="edge-weight" min="1" max="10" step="1" value="1">
			</div>
		</div>
		<div class="layout-divider"></div>
		<button class="layout-copy-btn" id="layout-copy">Copy settings</button>
		<button class="layout-copy-btn" id="layout-save">Save settings</button>
		<button class="layout-reset-btn" id="layout-reset">Reset defaults</button>
	</div>
</div>
<div id="empty" class="empty-state">Open a dbt model to see its lineage graph</div>

<script nonce="${nonce}">
(function() {
	const vscode = acquireVsCodeApi();
	const canvas = document.getElementById('canvas');
	const bandsEl = document.getElementById('bands');
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
		unit_test: 'var(--vscode-charts-purple, #A97FBE)',
		exposure:  'var(--vscode-charts-orange, #E8963E)',
		metric:    'var(--vscode-charts-orange, #E8963E)',
		seed:      '#D4A516',
		snapshot:  'var(--vscode-descriptionForeground, #888)',
	};

	let panX = 0, panY = 0, scale = 1;
	let isPanning = false, startX = 0, startY = 0;
	let graphData = null;
	let lastFocusId = null;
	let lastHighlightMsg = null;
	let CARD_W = 140;
	let RANKSEP = 105;
	const expandedCards = new Set();
	const relayoutColsCountByNode = new Map();
	/* Per-model saved state: expanded cards, column trace, pan/zoom */
	const savedStates = new Map();
	const persistedWebviewState = vscode.getState() || {};
	const layoutDefaults = {
		graph: { rankdir: 'LR', ranksep: 105, nodesep: 5, edgesep: 0, align: 'none', ranker: 'tight-tree', marginx: 20, marginy: 10 },
		node: { width: 140, heightPadding: 0 },
		edge: { minlen: 1, weight: 1, strokeWidth: 0.25, opacity: 0.45 },
	};
	let storedLayoutConfig = null;
	let layoutConfig = JSON.parse(JSON.stringify(layoutDefaults));

	if (persistedWebviewState.savedStates && typeof persistedWebviewState.savedStates === 'object') {
		for (const [focusId, rawState] of Object.entries(persistedWebviewState.savedStates)) {
			if (!rawState || typeof rawState !== 'object') continue;
			const expanded = Array.isArray(rawState.expandedCards)
				? rawState.expandedCards.filter(function(v) { return typeof v === 'string'; })
				: [];
			const rawScrolls = Array.isArray(rawState.colScrollPositions) ? rawState.colScrollPositions : [];
			const colScrollPositions = new Map();
			for (const pair of rawScrolls) {
				if (!Array.isArray(pair) || pair.length !== 2) continue;
				if (typeof pair[0] !== 'string' || typeof pair[1] !== 'number') continue;
				colScrollPositions.set(pair[0], pair[1]);
			}
			savedStates.set(focusId, {
				expandedCards: new Set(expanded),
				lastHighlightMsg: rawState.lastHighlightMsg || null,
				colScrollPositions: colScrollPositions,
				panX: typeof rawState.panX === 'number' ? rawState.panX : 0,
				panY: typeof rawState.panY === 'number' ? rawState.panY : 0,
				scale: typeof rawState.scale === 'number' ? rawState.scale : 1,
			});
		}
	}

	function captureCurrentModelState() {
		if (!lastFocusId) return;
		const colScrollPositions = new Map();
		for (const nodeId of expandedCards) {
			const colList = canvas.querySelector('[data-cols="' + CSS.escape(nodeId) + '"]');
			if (colList) {
				colScrollPositions.set(nodeId, colList.scrollTop);
			}
		}
		savedStates.set(lastFocusId, {
			expandedCards: new Set(expandedCards),
			lastHighlightMsg: lastHighlightMsg,
			colScrollPositions: colScrollPositions,
			panX: panX,
			panY: panY,
			scale: scale,
		});
	}

	function persistWebviewState() {
		captureCurrentModelState();
		const serializedSavedStates = {};
		for (const [focusId, state] of savedStates.entries()) {
			serializedSavedStates[focusId] = {
				expandedCards: Array.from(state.expandedCards || []),
				lastHighlightMsg: state.lastHighlightMsg || null,
				colScrollPositions: Array.from((state.colScrollPositions || new Map()).entries()),
				panX: typeof state.panX === 'number' ? state.panX : 0,
				panY: typeof state.panY === 'number' ? state.panY : 0,
				scale: typeof state.scale === 'number' ? state.scale : 1,
			};
		}
		vscode.setState({
			savedStates: serializedSavedStates,
			lastFocusId: lastFocusId,
		});
	}

	let persistQueued = false;
	function schedulePersistState() {
		if (persistQueued) return;
		persistQueued = true;
		requestAnimationFrame(function() {
			persistQueued = false;
			persistWebviewState();
		});
	}

	function cloneLayoutConfig(cfg) {
		return JSON.parse(JSON.stringify(cfg));
	}

	function getResetLayoutConfig() {
		return storedLayoutConfig ? cloneLayoutConfig(storedLayoutConfig) : cloneLayoutConfig(layoutDefaults);
	}

	function syncLayoutControls() {
		document.getElementById('rankdir').value = layoutConfig.graph.rankdir;
		document.getElementById('ranksep').value = String(layoutConfig.graph.ranksep);
		document.getElementById('ranksep-val').textContent = String(layoutConfig.graph.ranksep);
		document.getElementById('nodesep').value = String(layoutConfig.graph.nodesep);
		document.getElementById('nodesep-val').textContent = String(layoutConfig.graph.nodesep);
		document.getElementById('edgesep').value = String(layoutConfig.graph.edgesep);
		document.getElementById('edgesep-val').textContent = String(layoutConfig.graph.edgesep);
		document.getElementById('align').value = layoutConfig.graph.align;
		document.getElementById('ranker').value = layoutConfig.graph.ranker;
		document.getElementById('marginx').value = String(layoutConfig.graph.marginx);
		document.getElementById('marginx-val').textContent = String(layoutConfig.graph.marginx);
		document.getElementById('marginy').value = String(layoutConfig.graph.marginy);
		document.getElementById('marginy-val').textContent = String(layoutConfig.graph.marginy);
		document.getElementById('node-width').value = String(layoutConfig.node.width);
		document.getElementById('node-width-val').textContent = String(layoutConfig.node.width);
		document.getElementById('node-height-padding').value = String(layoutConfig.node.heightPadding);
		document.getElementById('node-height-padding-val').textContent = String(layoutConfig.node.heightPadding);
		document.getElementById('edge-stroke-width').value = String(layoutConfig.edge.strokeWidth);
		document.getElementById('edge-stroke-width-val').textContent = String(layoutConfig.edge.strokeWidth);
		document.documentElement.style.setProperty('--edge-stroke-width', String(layoutConfig.edge.strokeWidth));
		document.getElementById('edge-opacity').value = String(layoutConfig.edge.opacity);
		document.getElementById('edge-opacity-val').textContent = String(layoutConfig.edge.opacity);
		document.documentElement.style.setProperty('--edge-opacity', String(layoutConfig.edge.opacity));
		document.getElementById('edge-minlen').value = String(layoutConfig.edge.minlen);
		document.getElementById('edge-minlen-val').textContent = String(layoutConfig.edge.minlen);
		document.getElementById('edge-weight').value = String(layoutConfig.edge.weight);
		document.getElementById('edge-weight-val').textContent = String(layoutConfig.edge.weight);
	}

	/* ── Pan & Zoom ── */
	function applyTransform() {
		bandsEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
		canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
		edgesSvg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
		edgesFgSvg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
		schedulePersistState();
	}

	function depthBandColor(depth) {
		if (depth === 0) {
			return 'linear-gradient(to right, rgba(212, 165, 22, 0.015) 0%, rgba(212, 165, 22, 0.05) 50%, rgba(212, 165, 22, 0.09) 100%)';
		}
		const level = Math.min(Math.abs(depth), 6);
		const maxAlpha = Math.max(0.04, 0.12 - (level - 1) * 0.015);
		const midAlpha = Math.max(0.02, maxAlpha * 0.55);
		const minAlpha = Math.max(0.008, maxAlpha * 0.15);
		const rgb = depth > 0 ? '91, 141, 239' : '232, 150, 62';
		return 'linear-gradient(to right, rgba(' + rgb + ', ' + minAlpha.toFixed(3) + ') 0%, rgba(' + rgb + ', ' + midAlpha.toFixed(3) + ') 50%, rgba(' + rgb + ', ' + maxAlpha.toFixed(3) + ') 100%)';
	}

	function drawDepthBands(data) {
		if (!data || !data.nodes || data.nodes.length === 0) {
			bandsEl.innerHTML = '';
			return;
		}
		bandsEl.innerHTML = '';
		const depthNodes = new Map();
		for (const node of data.nodes) {
			const depth = node.depthLevel ?? 0;
			if (!depthNodes.has(depth)) depthNodes.set(depth, []);
			depthNodes.get(depth).push(node);
		}
		const laneDepths = Array.from(depthNodes.keys()).sort(function(a, b) { return a - b; });
		if (laneDepths.length === 0) return;

		const pad = 14;
		const focusNode = data.nodes.find(function(n) { return n.isFocus; })
			|| depthNodes.get(0)?.[0]
			|| data.nodes[0];
		const focusX = focusNode.x;
		const depthStep = Math.max(RANKSEP, CARD_W + 24);

		for (let i = 0; i < laneDepths.length; i++) {
			const depth = laneDepths[i];
			const nodes = depthNodes.get(depth);
			const center = focusX - (depth * depthStep);

			let maxDeviation = 0;
			for (const n of nodes) {
				const d = Math.abs(n.x - center);
				if (d > maxDeviation) maxDeviation = d;
			}

			const halfWidth = Math.max((CARD_W / 2) + 20, maxDeviation + (CARD_W / 2) + pad);
			const left = center - halfWidth;
			const width = halfWidth * 2;
			const band = document.createElement('div');
			band.className = 'depth-band';
			band.style.left = left + 'px';
			band.style.width = width + 'px';
			band.style.top = '-10000px';
			band.style.height = '20000px';
			band.style.background = depthBandColor(depth);
			bandsEl.appendChild(band);
		}
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
		if (data.defaultLayoutConfig) {
			Object.assign(layoutDefaults.graph, data.defaultLayoutConfig.graph || {});
			Object.assign(layoutDefaults.node, data.defaultLayoutConfig.node || {});
			Object.assign(layoutDefaults.edge, data.defaultLayoutConfig.edge || {});
		}
		storedLayoutConfig = data.storedLayoutConfig ? cloneLayoutConfig(data.storedLayoutConfig) : null;
		if (data.layoutConfig) {
			layoutConfig = cloneLayoutConfig(data.layoutConfig);
			syncLayoutControls();
		}
		const focusChanged = data.focusId !== lastFocusId;

		if (focusChanged && lastFocusId) {
			/* Save view state for the model we're navigating away from */
			captureCurrentModelState();
		}

		const restoredState = focusChanged ? savedStates.get(data.focusId) : null;
		if (focusChanged) {
			expandedCards.clear();
			lastHighlightMsg = null;
			relayoutColsCountByNode.clear();
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

		/* Store original dagre positions. */
		for (var wni = 0; wni < data.nodes.length; wni++) {
			data.nodes[wni]._origX = data.nodes[wni].x;
			data.nodes[wni]._origY = data.nodes[wni].y;
		}

		CARD_W = layoutConfig.node.width;
		RANKSEP = layoutConfig.graph.ranksep;
		for (var sxi = 0; sxi < data.nodes.length; sxi++) {
			data.nodes[sxi].x = data.nodes[sxi]._origX;
			data.nodes[sxi].y = data.nodes[sxi]._origY;
			data.nodes[sxi].width = CARD_W;
		}

		emptyEl.style.display = 'none';
		wrapEl.style.display = 'block';
		bandsEl.innerHTML = '';
		canvas.innerHTML = '';
		edgesSvg.innerHTML = '';
		edgesFgSvg.innerHTML = '';

		for (const node of data.nodes) {
			const card = document.createElement('div');
			card.className = 'card' + (node.isFocus ? ' focus' : '');
			card.dataset.id = node.id;
			card.style.left = (node.x - CARD_W / 2) + 'px';
			card.style.top = (node.y - node.height / 2) + 'px';

			const mat = node.materialisation;
			const isSeed = node.type === 'seed' || mat === 'seed';
			const effectiveType = isSeed ? 'seed' : node.type;
			const color = TYPE_COLORS[effectiveType] || 'var(--vscode-descriptionForeground)';
			const subtitle = mat ? mat : node.type;
			const colCount = node.columns ? node.columns.length : 0;
			const typeBadge = effectiveType === 'model' ? 'M' : effectiveType === 'source' ? 'S' : effectiveType === 'seed' ? 'Sd' : effectiveType === 'test' ? 'T' : effectiveType === 'unit_test' ? 'U' : effectiveType.slice(0, 2).toUpperCase();

			card.innerHTML =
				'<div class="card-header" data-file="' + escHtml(node.filePath || '') + '">' +
					'<span class="type-stripe" style="background:' + color + '"></span>' +
					'<div class="card-text-wrapper">' +
						'<div class="card-title-row">' +
							'<span class="card-title" title="' + escHtml(node.label) + '">' +
								'<span class="type-badge open-file-trigger" title="Open model" style="background:' + color + '; color: white;">' + escHtml(typeBadge) + '</span>' +
								(node.depthLevel !== 0 ? '<span class="depth-label">' + (node.depthLevel > 0 ? '+' + node.depthLevel : '' + node.depthLevel) + '</span>' : '') +
								escHtml(node.label) +
							'</span>' +
						'</div>' +
						'<div class="card-subtitle-row">' +
							'<span class="card-subtitle">' + escHtml(subtitle) + '</span>' +
							(colCount > 0 ? '<button class="col-toggle" data-node="' + escHtml(node.id) + '">' + colCount + ' cols ▸</button>' : '') +
						'</div>' +
					'</div>' +
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
				/* Restore scroll position for this column list */
				if (restoredState && restoredState.colScrollPositions && restoredState.colScrollPositions.has(nodeId)) {
					colList.scrollTop = restoredState.colScrollPositions.get(nodeId);
				}
			}
		}

		drawDepthBands(data);

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
				requestAnimationFrame(function() { requestDagreRelayout(); });
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

		schedulePersistState();
	}

	/* ── Edges ── */
	function drawEdges(data) {
		edgesSvg.innerHTML = '';
		const nodeMap = {};
		for (const n of data.nodes) nodeMap[n.id] = n;

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

	function requestDagreRelayout() {
		vscode.postMessage({ command: 'setExpandedNodes', nodeIds: Array.from(expandedCards) });
	}

	/* ── Event Delegation ── */
	canvas.addEventListener('click', function(e) {
		const card = e.target.closest('.card');
		const openFileEl = e.target.closest('.open-file-trigger');
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
			if (show) {
				expandedCards.add(nodeId);
			} else {
				expandedCards.delete(nodeId);
				relayoutColsCountByNode.delete(nodeId);
			}
			requestDagreRelayout();
			return;
		}

		if (colItem) {
			const model = colItem.dataset.model;
			const col = colItem.dataset.col;
			vscode.postMessage({ command: 'traceColumn', model: model, column: col });
			return;
		}

		if (openFileEl) {
			const header = openFileEl.closest('.card-header');
			const fp = header.dataset.file;
			if (fp) vscode.postMessage({ command: 'openFile', filePath: fp });
			return;
		}

		if (card) {
			const nodeId = card.dataset.id;
			if (!nodeId) return;
			const colList = card.querySelector('[data-cols="' + CSS.escape(nodeId) + '"]');
			if (!colList) return;
			const show = colList.style.display === 'none';
			colList.style.display = show ? '' : 'none';
			const toggle = card.querySelector('.col-toggle');
			if (toggle) toggle.textContent = toggle.textContent.replace(show ? '▸' : '▾', show ? '▾' : '▸');
			if (show) {
				expandedCards.add(nodeId);
			} else {
				expandedCards.delete(nodeId);
				relayoutColsCountByNode.delete(nodeId);
			}
			requestDagreRelayout();
		}
	});

	/* Keep card positions/sizes in sync on resize. */
	new ResizeObserver(function() {
		if (!graphData) return;
		drawDepthBands(graphData);

		for (var rwi = 0; rwi < graphData.nodes.length; rwi++) {
			var rn = graphData.nodes[rwi];
			var rc = canvas.querySelector('[data-id="' + CSS.escape(rn.id) + '"]');
			if (rc) {
				rc.style.left = (rn.x - CARD_W / 2) + 'px';
				rc.style.top = (rn.y - rn.height / 2) + 'px';
				rc.style.width = CARD_W + 'px';
			}
		}
		drawEdges(graphData);
		requestAnimationFrame(redrawColumnEdges);
	}).observe(wrapEl);

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

	/* ── Layout Settings Panel ── */
	const layoutPanel = document.getElementById('layout-panel');
	const bodyEl = document.body;

	function setLayoutPanelOpen(isOpen) {
		layoutPanel.classList.toggle('hidden', !isOpen);
		bodyEl.classList.toggle('layout-panel-open', isOpen);
	}

	function postLayoutConfig() {
		vscode.postMessage({ command: 'setLayoutConfig', config: layoutConfig });
	}

	function copyLayoutConfig() {
		vscode.postMessage({ command: 'copyLayoutConfig', config: layoutConfig });
	}

	function saveLayoutConfig() {
		vscode.postMessage({ command: 'saveLayoutConfig', config: layoutConfig });
	}

	document.getElementById('layout-toggle').addEventListener('click', function() {
		setLayoutPanelOpen(layoutPanel.classList.contains('hidden'));
	});
	document.getElementById('layout-panel-close').addEventListener('click', function() {
		setLayoutPanelOpen(false);
	});

	document.getElementById('ranksep').addEventListener('input', function() {
		const v = parseInt(this.value, 10);
		layoutConfig.graph.ranksep = v;
		document.getElementById('ranksep-val').textContent = String(v);
	});
	document.getElementById('rankdir').addEventListener('change', function() {
		layoutConfig.graph.rankdir = this.value;
		postLayoutConfig();
	});
	document.getElementById('ranksep').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('nodesep').addEventListener('input', function() {
		const v = parseInt(this.value, 10);
		layoutConfig.graph.nodesep = v;
		document.getElementById('nodesep-val').textContent = String(v);
	});
	document.getElementById('nodesep').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('edgesep').addEventListener('input', function() {
		const v = parseInt(this.value, 10);
		layoutConfig.graph.edgesep = v;
		document.getElementById('edgesep-val').textContent = String(v);
	});
	document.getElementById('edgesep').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('align').addEventListener('change', function() {
		layoutConfig.graph.align = this.value;
		postLayoutConfig();
	});

	document.getElementById('ranker').addEventListener('change', function() {
		layoutConfig.graph.ranker = this.value;
		postLayoutConfig();
	});

	document.getElementById('marginx').addEventListener('input', function() {
		const v = parseInt(this.value, 10);
		layoutConfig.graph.marginx = v;
		document.getElementById('marginx-val').textContent = String(v);
	});
	document.getElementById('marginx').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('marginy').addEventListener('input', function() {
		const v = parseInt(this.value, 10);
		layoutConfig.graph.marginy = v;
		document.getElementById('marginy-val').textContent = String(v);
	});
	document.getElementById('marginy').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('node-width').addEventListener('input', function() {
		const v = parseInt(this.value, 10);
		layoutConfig.node.width = v;
		document.getElementById('node-width-val').textContent = String(v);
	});
	document.getElementById('node-width').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('node-height-padding').addEventListener('input', function() {
		const v = parseInt(this.value, 10);
		layoutConfig.node.heightPadding = v;
		document.getElementById('node-height-padding-val').textContent = String(v);
	});
	document.getElementById('node-height-padding').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('edge-stroke-width').addEventListener('input', function() {
		const v = parseFloat(this.value);
		layoutConfig.edge.strokeWidth = v;
		document.getElementById('edge-stroke-width-val').textContent = String(v);
		document.documentElement.style.setProperty('--edge-stroke-width', String(v));
	});
	document.getElementById('edge-stroke-width').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('edge-opacity').addEventListener('input', function() {
		const v = parseFloat(this.value);
		layoutConfig.edge.opacity = v;
		document.getElementById('edge-opacity-val').textContent = String(v);
		document.documentElement.style.setProperty('--edge-opacity', String(v));
	});
	document.getElementById('edge-opacity').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('edge-minlen').addEventListener('input', function() {
		const v = parseInt(this.value, 10);
		layoutConfig.edge.minlen = v;
		document.getElementById('edge-minlen-val').textContent = String(v);
	});
	document.getElementById('edge-minlen').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('edge-weight').addEventListener('input', function() {
		const v = parseInt(this.value, 10);
		layoutConfig.edge.weight = v;
		document.getElementById('edge-weight-val').textContent = String(v);
	});
	document.getElementById('edge-weight').addEventListener('change', function() {
		postLayoutConfig();
	});

	document.getElementById('layout-reset').addEventListener('click', function() {
		layoutConfig = getResetLayoutConfig();
		syncLayoutControls();
		postLayoutConfig();
	});

	document.getElementById('layout-copy').addEventListener('click', function() {
		copyLayoutConfig();
	});

	document.getElementById('layout-save').addEventListener('click', function() {
		saveLayoutConfig();
	});

	window.addEventListener('message', function(event) {
		const msg = event.data;
		if (msg.command === 'setGraph') setGraph(msg);
		if (msg.command === 'highlightColumns') highlightColumns(msg);
		if (msg.command === 'updateColumns') updateColumns(msg);
		if (msg.command === 'columnLineageStatus') showStatus(msg);
		if (msg.command === 'layoutConfigCopied') showStatus({ status: 'loading', message: msg.message || 'Copied' });
		if (msg.command === 'layoutConfigSaved') {
			storedLayoutConfig = msg.storedLayoutConfig ? cloneLayoutConfig(msg.storedLayoutConfig) : cloneLayoutConfig(layoutConfig);
			showStatus({ status: 'loading', message: msg.message || 'Saved' });
		}
		if (msg.command === 'clearFileState') {
			savedStates.delete(msg.focusId);
			schedulePersistState();
		}
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
			if (msg.message === 'Copied layout config' || msg.message === 'Saved layout config') {
				setTimeout(function() { el.style.display = 'none'; }, 1500);
			}
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
		var subtitleRow = card.querySelector('.card-subtitle-row');
		if (!toggle && subtitleRow && msg.columns.length > 0) {
			toggle = document.createElement('button');
			toggle.className = 'col-toggle';
			toggle.dataset.node = msg.nodeId;
			toggle.textContent = msg.columns.length + ' cols ▸';
			subtitleRow.appendChild(toggle);
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
		/* If this card is already expanded and column count actually changed,
		 * request one dagre refresh; dedupe identical counts to avoid refresh loops. */
		if (expandedCards.has(msg.nodeId)) {
			const nextCount = Array.isArray(msg.columns) ? msg.columns.length : 0;
			const prevRequestedCount = relayoutColsCountByNode.get(msg.nodeId);
			if (prevRequestedCount !== nextCount) {
				relayoutColsCountByNode.set(msg.nodeId, nextCount);
				requestDagreRelayout();
			}
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
			/* Defer one frame so expanded col-list DOM updates are applied,
			 * then request a fresh dagre pass from the extension host. */
			requestAnimationFrame(function() {
				requestDagreRelayout();
				requestAnimationFrame(function() {
					drawEdges(graphData);
					drawColumnEdges(highlightedEls, msg.columnEdges || []);
				});
			});
		}
	}

	function drawColumnEdges(highlightedEls, columnEdges) {
		if (highlightedEls.length < 2 || !graphData || !columnEdges.length) return;

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
