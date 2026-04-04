import { describe, expect, it, beforeEach } from 'vitest';
import { Uri } from 'vscode';
import { DataPipelineProvider } from '../dbt/debug-pipeline-provider';
import type { FrameNode } from '../dbt/debug-pipeline-provider';
import type { PipelineEventBody } from '../dbt/debug-adapter';

const stubExtensionUri = Uri.file('/stub');

// ── Helpers ──

function frames(nodes: ReturnType<typeof DataPipelineProvider.prototype['getChildren']>): FrameNode[] {
	return nodes as FrameNode[];
}

function makeEvent(overrides: Partial<PipelineEventBody> = {}): PipelineEventBody {
	return {
		frames: [
			{ name: '_main_', type: 'select', line: 20, endLine: 25 },
			{ name: 'cte_orders', type: 'cte', line: 5, endLine: 9 },
			{ name: 'cte_payments', type: 'cte', line: 10, endLine: 15 },
			{ name: 'cte_items', type: 'cte', line: 1, endLine: 4 },
		],
		refs: {
			_main_: ['cte_orders', 'cte_payments'],
			cte_orders: ['cte_items'],
			cte_payments: ['cte_items'],
			cte_items: [],
		},
		currentFrameIndex: 1,
		executedFrames: {
			cte_items: { rows: 42, executionMs: 10 },
		},
		...overrides,
	};
}

// ── Tests ──

describe('DataPipelineProvider', () => {
	let provider: DataPipelineProvider;

	beforeEach(() => {
		provider = new DataPipelineProvider(stubExtensionUri);
	});

	describe('DAG construction', () => {
		it('builds nodes from frames and refs', () => {
			provider.handlePipelineEvent(makeEvent());
			const roots = frames(provider.getChildren());
			expect(roots).toHaveLength(1);
			expect(roots[0].name).toBe('_main_');
		});

		it('expands dependencies as children', () => {
			provider.handlePipelineEvent(makeEvent());
			const roots = frames(provider.getChildren());
			const mainDeps = frames(provider.getChildren(roots[0]));
			expect(mainDeps.map(d => d.name).sort()).toEqual(['cte_orders', 'cte_payments']);
		});

		it('handles diamond dependencies', () => {
			provider.handlePipelineEvent(makeEvent());
			const roots = frames(provider.getChildren());
			const mainDeps = frames(provider.getChildren(roots[0]));
			const ordersDeps = frames(provider.getChildren(mainDeps.find(d => d.name === 'cte_orders')!));
			const paymentsDeps = frames(provider.getChildren(mainDeps.find(d => d.name === 'cte_payments')!));
			expect(ordersDeps).toHaveLength(1);
			expect(ordersDeps[0].name).toBe('cte_items');
			expect(paymentsDeps).toHaveLength(1);
			expect(paymentsDeps[0].name).toBe('cte_items');
		});

		it('returns empty for no event', () => {
			expect(provider.getChildren()).toEqual([]);
		});
	});

	describe('ancestor filtering (stack mode)', () => {
		it('includes target and all transitive deps', () => {
			provider.handlePipelineEvent(makeEvent({ currentFrameIndex: 1 }));
			// cte_orders → cte_items, and _main_ reaches cte_orders
			const ancestors = provider._ancestorsOf('cte_orders');
			expect(ancestors).toContain('cte_orders');
			expect(ancestors).toContain('cte_items');
			expect(ancestors).toContain('_main_');
			// cte_payments is NOT an ancestor of cte_orders
			expect(ancestors).not.toContain('cte_payments');
		});

		it('filters roots in stack mode', () => {
			provider.handlePipelineEvent(makeEvent({ currentFrameIndex: 1 }));
			provider.toggleMode();
			expect(provider.mode).toBe('stack');
			const roots = frames(provider.getChildren());
			expect(roots).toHaveLength(1);
			expect(roots[0].name).toBe('_main_');
			const mainDeps = frames(provider.getChildren(roots[0]));
			// In stack mode for cte_orders: only cte_orders visible, not cte_payments
			expect(mainDeps.map(d => d.name)).toEqual(['cte_orders']);
		});
	});

	describe('TreeItem rendering', () => {
		it('marks current frame with custom SVG icon', () => {
			provider.handlePipelineEvent(makeEvent({ currentFrameIndex: 1 }));
			const roots = frames(provider.getChildren());
			const mainDeps = frames(provider.getChildren(roots[0]));
			const current = mainDeps.find(d => d.name === 'cte_orders')!;
			const item = provider.getTreeItem(current);
			const icon = item.iconPath as { light: { fsPath: string }; dark: { fsPath: string } };
			expect(icon.dark.fsPath).toContain('debug-current-dark');
			expect(icon.light.fsPath).toContain('debug-current-light');
		});

		it('shows row count for executed frames', () => {
			provider.handlePipelineEvent(makeEvent());
			const roots = frames(provider.getChildren());
			const mainDeps = frames(provider.getChildren(roots[0]));
			const ordersDeps = frames(provider.getChildren(mainDeps.find(d => d.name === 'cte_orders')!));
			const items = ordersDeps.find(d => d.name === 'cte_items')!;
			const item = provider.getTreeItem(items);
			expect(item.description).toContain('42');
			expect(item.description).toContain('rows');
		});

		it('shows pending for unexecuted non-current frames', () => {
			provider.handlePipelineEvent(makeEvent({ currentFrameIndex: 0 }));
			// cte_payments is not executed, not current
			const roots = frames(provider.getChildren());
			const mainDeps = frames(provider.getChildren(roots[0]));
			const payments = mainDeps.find(d => d.name === 'cte_payments')!;
			const item = provider.getTreeItem(payments);
			expect(item.description).toBe('pending');
		});
	});

	describe('mode toggle', () => {
		it('starts in full mode', () => {
			expect(provider.mode).toBe('full');
		});

		it('toggles between full and stack', () => {
			provider.toggleMode();
			expect(provider.mode).toBe('stack');
			provider.toggleMode();
			expect(provider.mode).toBe('full');
		});
	});

	describe('clear', () => {
		it('resets all state', () => {
			provider.handlePipelineEvent(makeEvent());
			expect(provider.getChildren()).toHaveLength(1);
			provider.clear();
			expect(provider.getChildren()).toEqual([]);
		});
	});

	describe('external refs', () => {
		it('creates leaf nodes for refs not in frames', () => {
			const event = makeEvent({
				refs: {
					_main_: ['cte_orders'],
					cte_orders: ['raw_orders'],
					cte_payments: [],
					cte_items: [],
				},
			});
			provider.handlePipelineEvent(event);
			const roots = frames(provider.getChildren());
			const mainDeps = frames(provider.getChildren(roots[0]));
			const ordersDeps = frames(provider.getChildren(mainDeps.find(d => d.name === 'cte_orders')!));
			expect(ordersDeps).toHaveLength(1);
			expect(ordersDeps[0].name).toBe('raw_orders');
			// External ref is a leaf
			expect(provider.getChildren(ordersDeps[0])).toEqual([]);
		});
	});
});
