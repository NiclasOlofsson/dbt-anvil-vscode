import * as vscode from 'vscode';
import type { PipelineClauseStep, PipelineEventBody } from './debug-adapter';

// ── DAG node used as TreeItem element identity ──

export interface FrameNode {
	kind: 'frame';
	name: string;
	type: 'cte' | 'select' | 'subquery';
	line: number;
	/** Direct dependencies (tables/CTEs referenced by this frame's FROM/JOIN). */
	deps: string[];
}

interface ClauseNode {
	kind: 'clause';
	/** Display label e.g. "from nba_teams", "join cte_wins" */
	label: string;
	line: number;
	executed: boolean;
	rows: number | undefined;
	isCurrent: boolean;
	fanOut: boolean;
}

type PipelineNode = FrameNode | ClauseNode;

type ViewMode = 'full' | 'stack';

/**
 * TreeDataProvider for the "Data Pipeline" view in the Run and Debug sidebar.
 *
 * Shows the CTE dependency DAG during a dbt-sql debug session.
 * Two modes:
 *  - `full`  — entire DAG rooted at _main_, expanding shows dependencies
 *  - `stack` — only ancestors of the current frame (the dependency path)
 */
export class DataPipelineProvider implements vscode.TreeDataProvider<PipelineNode> {
	static readonly viewId = 'dbt-anvil.dataPipeline';

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<PipelineNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly _currentIcon: { light: vscode.Uri; dark: vscode.Uri };

	// ── State populated by pipeline events from the debug adapter ──
	private _nodes = new Map<string, FrameNode>();
	private _currentFrameName: string | undefined;
	private _executedFrames = new Map<string, { rows: number; executionMs: number }>();
	private _clauseSteps: PipelineClauseStep[] | undefined;
	private _mode: ViewMode = 'full';
	private _sourceUri: string | undefined;

	constructor(extensionUri: vscode.Uri) {
		this._currentIcon = {
			light: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'debug-current-light.svg'),
			dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'debug-current-dark.svg'),
		};
	}

	// ──────────────────────────────────────────────────────────────
	// Public API — called from extension.ts
	// ──────────────────────────────────────────────────────────────

	handlePipelineEvent(body: PipelineEventBody, sourceUri?: string): void {
		this._sourceUri = sourceUri;
		this._buildDag(body.frames, body.refs);
		this._currentFrameName = body.frames[body.currentFrameIndex]?.name;
		this._executedFrames.clear();
		for (const [name, info] of Object.entries(body.executedFrames)) {
			this._executedFrames.set(name, info);
		}
		this._clauseSteps = body.clauseSteps;
		this._onDidChangeTreeData.fire();
	}

	clear(): void {
		this._nodes.clear();
		this._currentFrameName = undefined;
		this._executedFrames.clear();
		this._clauseSteps = undefined;
		this._sourceUri = undefined;
		this._onDidChangeTreeData.fire();
	}

	toggleMode(): void {
		this._mode = this._mode === 'full' ? 'stack' : 'full';
		void vscode.commands.executeCommand('setContext', 'dbt-anvil.pipelineModeStack', this._mode === 'stack');
		this._onDidChangeTreeData.fire();
	}

	get mode(): ViewMode {
		return this._mode;
	}

	// ──────────────────────────────────────────────────────────────
	// TreeDataProvider
	// ──────────────────────────────────────────────────────────────

	getTreeItem(element: PipelineNode): vscode.TreeItem {
		// ── Clause step node ──
		if (element.kind === 'clause') {
			const item = new vscode.TreeItem(
				element.label,
				vscode.TreeItemCollapsibleState.None,
			);
			if (element.isCurrent) {
				item.iconPath = this._currentIcon;
				item.description = element.rows !== undefined ? `${element.rows.toLocaleString()} rows` : '…';
			} else if (element.executed) {
				if (element.fanOut) {
					item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
					item.description = element.rows !== undefined ? `${element.rows.toLocaleString()} rows ⚠ fan-out` : '⚠ fan-out';
				} else {
					item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
					item.description = element.rows !== undefined ? `${element.rows.toLocaleString()} rows` : '';
				}
			} else {
				item.iconPath = new vscode.ThemeIcon('circle-outline');
				item.description = 'pending';
			}
			if (this._sourceUri) {
				item.command = {
					command: 'dbt-anvil.dataPipeline.goToFrame',
					title: 'Go to Line',
					arguments: [this._sourceUri, element.line],
				};
			}
			item.contextValue = element.isCurrent ? 'pipelineClauseCurrent' : element.executed ? 'pipelineClauseExecuted' : 'pipelineClausePending';
			return item;
		}

		// ── Frame node ──
		const isCurrent = element.name === this._currentFrameName;
		const executed = this._executedFrames.get(element.name);
		const hasDeps = element.deps.some(d => this._nodes.has(d));
		// Current frame shows clause steps as children when clause-stepping.
		const clauseChildren = isCurrent && this._clauseSteps !== undefined;
		const visibleDeps = clauseChildren ? [] : this._visibleDeps(element);

		const item = new vscode.TreeItem(
			element.name,
			clauseChildren || visibleDeps.length > 0
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None,
		);

		// Icon
		if (isCurrent) {
			item.iconPath = this._currentIcon;
		} else if (executed) {
			item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
		} else if (hasDeps || element.type === 'select') {
			item.iconPath = new vscode.ThemeIcon('circle-outline');
		} else {
			// Leaf with no deps — likely a source/ref to external table
			item.iconPath = new vscode.ThemeIcon('database');
		}

		// Description — row count for executed frames, clause progress for current frame
		if (isCurrent && this._clauseSteps !== undefined) {
			const done = this._clauseSteps.filter(c => c.executed).length;
			const total = this._clauseSteps.length;
			item.description = `${done}/${total} clauses`;
		} else if (executed) {
			const prev = this._previousFrameRows(element);
			if (prev !== undefined && executed.rows > prev) {
				item.description = `${executed.rows.toLocaleString()} rows ⚠ fan-out`;
				item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
			} else {
				item.description = `${executed.rows.toLocaleString()} rows`;
			}
		} else if (!isCurrent) {
			item.description = 'pending';
		}

		// Click → navigate to source line
		if (this._sourceUri) {
			item.command = {
				command: 'dbt-anvil.dataPipeline.goToFrame',
				title: 'Go to Frame',
				arguments: [this._sourceUri, element.line],
			};
		}

		item.contextValue = isCurrent ? 'pipelineCurrent' : executed ? 'pipelineExecuted' : 'pipelinePending';

		return item;
	}

	getChildren(element?: PipelineNode): PipelineNode[] {
		if (this._nodes.size === 0) return [];

		if (!element) {
			// Root: find the top-level frame(s) — nodes that nothing else depends on.
			// Typically just _main_.
			const roots = this._findRoots();
			if (this._mode === 'stack' && this._currentFrameName) {
				const ancestors = this._ancestorsOf(this._currentFrameName);
				return roots.filter(r => ancestors.has(r.name));
			}
			return roots;
		}

		// Clause nodes have no children.
		if (element.kind === 'clause') return [];

		// Current frame in clause-stepping mode: show clause steps instead of CTE deps.
		if (element.name === this._currentFrameName && this._clauseSteps !== undefined) {
			return this._clauseSteps.map((step): ClauseNode => ({
				kind: 'clause',
				label: step.label,
				line: step.line,
				executed: step.executed,
				rows: step.rows,
				isCurrent: step.isCurrent,
				fanOut: step.fanOut,
			}));
		}

		const deps = this._visibleDeps(element);
		return deps.map(name => this._nodes.get(name)!);
	}

	// ──────────────────────────────────────────────────────────────
	// DAG construction
	// ──────────────────────────────────────────────────────────────

	private _buildDag(frames: PipelineEventBody['frames'], refs: Record<string, string[]>): void {
		this._nodes.clear();

		// First pass: add leaf nodes for external refs that aren't frames.
		const frameNames = new Set(frames.map(f => f.name));
		for (const frame of frames) {
			for (const ref of refs[frame.name] ?? []) {
				if (!frameNames.has(ref)) {
					this._nodes.set(ref, {
						kind: 'frame',
						name: ref,
						type: 'select',
						line: 0,
						deps: [],
					});
				}
			}
		}

		// Second pass: add frame nodes with all deps (both frames and external refs).
		for (const frame of frames) {
			this._nodes.set(frame.name, {
				kind: 'frame',
				name: frame.name,
				type: frame.type,
				line: frame.line,
				deps: refs[frame.name] ?? [],
			});
		}
	}

	/** Find root nodes — frames that no other frame depends on. */
	private _findRoots(): FrameNode[] {
		const referenced = new Set<string>();
		for (const node of this._nodes.values()) {
			for (const dep of node.deps) referenced.add(dep);
		}
		const roots: FrameNode[] = [];
		for (const node of this._nodes.values()) {
			if (!referenced.has(node.name)) roots.push(node);
		}
		// If nothing is unreferenced (shouldn't happen), return _main_ or first frame.
		if (roots.length === 0) {
			const main = this._nodes.get('_main_');
			if (main) return [main];
			const first = this._nodes.values().next().value;
			return first ? [first] : [];
		}
		return roots;
	}

	/** Collect all nodes on any path from a root to `name` (inclusive). */
	_ancestorsOf(name: string): Set<string> {
		// First: collect the target and all its transitive dependencies.
		const result = new Set<string>();
		const visitDeps = (n: string) => {
			if (result.has(n)) return;
			result.add(n);
			const node = this._nodes.get(n);
			if (node) {
				for (const dep of node.deps) visitDeps(dep);
			}
		};
		visitDeps(name);

		// Second: include any root that can reach the target, plus all nodes
		// on the path between root and target. We walk from each root and
		// only follow edges that lead toward the target.
		for (const root of this._findRoots()) {
			if (root.name !== name && this._reaches(root.name, name)) {
				this._collectPathNodes(root.name, name, result);
			}
		}
		return result;
	}

	/** Add all nodes on paths from `from` to `to` into `result`. */
	private _collectPathNodes(from: string, to: string, result: Set<string>): void {
		result.add(from);
		if (from === to) return;
		const node = this._nodes.get(from);
		if (!node) return;
		for (const dep of node.deps) {
			if (dep === to || this._reaches(dep, to)) {
				this._collectPathNodes(dep, to, result);
			}
		}
	}

	/** Check if `from` transitively reaches `to` via deps. */
	private _reaches(from: string, to: string): boolean {
		if (from === to) return true;
		const node = this._nodes.get(from);
		if (!node) return false;
		return node.deps.some(d => this._reaches(d, to));
	}

	/** Get deps for an element, filtered by mode. */
	private _visibleDeps(element: FrameNode): string[] {
		if (this._mode === 'full') return element.deps.filter((d: string) => this._nodes.has(d));
		if (!this._currentFrameName) return [];
		const ancestors = this._ancestorsOf(this._currentFrameName);
		return element.deps.filter((d: string) => this._nodes.has(d) && ancestors.has(d));
	}

	/** Get the row count of the "previous" frame (first dep) for fan-out detection. */
	private _previousFrameRows(element: FrameNode): number | undefined {
		for (const dep of element.deps) {
			const info = this._executedFrames.get(dep);
			if (info) return info.rows;
		}
		return undefined;
	}
}
