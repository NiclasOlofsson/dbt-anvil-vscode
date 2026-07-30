import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { StatusBarManager } from '../views/status-bar';
import type { DbtExecutionService } from '../dbt/execution-service';
import type { ILogger } from '../types/logger';

/** The manager only subscribes to these; none of them fire in these tests. */
function stubExecutionService(): DbtExecutionService {
	const never = () => ({ dispose: () => { /* no subscription to clean up */ } });
	return {
		onJobStarted: never,
		onJobCompleted: never,
		onJobFailed: never,
		onQueueChanged: never,
	} as unknown as DbtExecutionService;
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as unknown as ILogger;

function makeStatusBar(): { bar: StatusBarManager; item: vscode.StatusBarItem } {
	const bar = new StatusBarManager(stubExecutionService(), logger);
	const item = vi.mocked(vscode.window.createStatusBarItem).mock.results.at(-1)?.value as vscode.StatusBarItem;
	return { bar, item };
}

describe('StatusBarManager', () => {
	it('spins on Initializing before anything settles', () => {
		const { item } = makeStatusBar();

		expect(item.text).toContain('Initializing');
	});

	it('reports a workspace it cannot serve instead of spinning forever', () => {
		// Activation gives up on some workspaces (no project, several projects) and
		// nothing further will happen. A spinner promises progress that is not coming.
		const { bar, item } = makeStatusBar();

		bar.setUnavailable('No project', 'No dbt_project.yml found in this workspace.');

		expect(item.text).toContain('No project');
		expect(item.text).not.toContain('Initializing');
		expect(item.tooltip).toContain('dbt_project.yml');
	});

	it('offers the menu when unavailable, so the user is not stranded', () => {
		const { bar, item } = makeStatusBar();

		bar.setUnavailable('Several projects', 'Open a single project folder.');

		expect(item.command).toBe('dbt-anvil.statusBarMenu');
	});

	it('lets a setup error outrank unavailability', () => {
		// A broken Python environment is the more actionable of the two, and it is
		// the one whose remedy the user controls directly.
		const { bar, item } = makeStatusBar();

		bar.setUnavailable('No project', 'No dbt_project.yml found in this workspace.');
		bar.setError('dbt is not installed in the Python environment.');

		expect(item.text).toContain('Setup Required');
	});

	it('keeps reporting unavailable even once the index is ready', () => {
		// Ready means the manifest indexed. It does not undo "this workspace holds
		// several projects", so unavailability must not be overwritten by it.
		const { bar, item } = makeStatusBar();

		bar.setUnavailable('Several projects', 'Open a single project folder.');
		bar.setReady();

		expect(item.text).toContain('Several projects');
	});
});
