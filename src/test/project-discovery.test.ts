import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { discoverDbtProject } from '../dbt/project-discovery';

const tmpDir = path.join(os.tmpdir(), 'dbt-anvil-discovery-test');

/** Stand in for a search hit, which is all discoverDbtProject reads from findFiles. */
function hit(...segments: string[]): vscode.Uri {
	return vscode.Uri.file(path.join(tmpDir, ...segments, 'dbt_project.yml'));
}

function findFilesReturns(uris: vscode.Uri[]): void {
	vi.mocked(vscode.workspace.findFiles).mockResolvedValue(uris);
}

describe('discoverDbtProject', () => {
	beforeEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		fs.mkdirSync(tmpDir, { recursive: true });
		findFilesReturns([]);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.mocked(vscode.workspace.findFiles).mockReset();
	});

	it('takes a root-level project without searching', async () => {
		// The common layout, and the one that must not pay for the new search.
		fs.writeFileSync(path.join(tmpDir, 'dbt_project.yml'), 'name: jaffle\n');

		const result = await discoverDbtProject(vscode.Uri.file(tmpDir));

		expect(result.projectDir).toBe(tmpDir);
		expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
	});

	it('finds a project nested in a multi-repo workspace', async () => {
		// The reported failure: the activation glob matches repos/dbt/dbt_project.yml,
		// so resolution has to reach it too or the extension activates into nothing.
		findFilesReturns([hit('dbt')]);

		const result = await discoverDbtProject(vscode.Uri.file(tmpDir));

		expect(result.projectDir).toBe(path.join(tmpDir, 'dbt'));
	});

	it('selects nothing when several projects are found, and reports them all', async () => {
		// Binding to whichever the search returned first would point the bridge,
		// the caches, and the manifest index at an arbitrary project.
		findFilesReturns([hit('warehouse'), hit('marketing')]);

		const result = await discoverDbtProject(vscode.Uri.file(tmpDir));

		expect(result.projectDir).toBeUndefined();
		expect(result.candidates).toEqual([path.join(tmpDir, 'marketing'), path.join(tmpDir, 'warehouse')]);
	});

	it('selects nothing in a workspace with no dbt project', async () => {
		const result = await discoverDbtProject(vscode.Uri.file(tmpDir));

		expect(result.projectDir).toBeUndefined();
		expect(result.candidates).toEqual([]);
	});

	it('excludes installed packages and build output from the search', async () => {
		// dbt_packages holds every dependency's own dbt_project.yml, and target
		// holds copies. Either would outnumber the real project.
		await discoverDbtProject(vscode.Uri.file(tmpDir));

		const exclude = vi.mocked(vscode.workspace.findFiles).mock.calls[0][1] as string;
		expect(exclude).toContain('dbt_packages');
		expect(exclude).toContain('target');
	});
});
