import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Directories holding copies of other projects' files. A `dbt_project.yml` in
 * any of them belongs to an installed package or a build artifact, never to the
 * project the user opened.
 */
const EXCLUDED_DIRS = '**/{dbt_packages,target,node_modules,.venv,venv,site-packages}/**';

/** Enough hits to tell "one project" from "several", and to name them. */
const MAX_RESULTS = 16;

export interface DbtProjectDiscovery {
	/** The project to work on. Undefined when the folder holds none, or more than one. */
	projectDir?: string;
	/** Every project found by searching. Empty when the workspace root is itself the project. */
	candidates: string[];
}

/**
 * Find the dbt project inside a workspace folder.
 *
 * A `dbt_project.yml` at the root wins outright, without a search: it is the
 * project, and anything nested under it belongs to it. Otherwise the folder is
 * searched, which is the multi-repo layout where the dbt project sits a level or
 * two down next to the BI and orchestration repos it belongs with.
 *
 * Several projects is #25's problem. Choosing one here would bind the bridge,
 * the caches, and the manifest index to whichever the search happened to return
 * first, so this reports them all and selects none.
 */
export async function discoverDbtProject(folder: vscode.Uri): Promise<DbtProjectDiscovery> {
	if (fs.existsSync(path.join(folder.fsPath, 'dbt_project.yml'))) {
		return { projectDir: folder.fsPath, candidates: [] };
	}

	const found = await vscode.workspace.findFiles(
		new vscode.RelativePattern(folder, '**/dbt_project.yml'),
		EXCLUDED_DIRS,
		MAX_RESULTS,
	);
	const candidates = found.map((uri) => path.dirname(uri.fsPath)).sort();

	return {
		projectDir: candidates.length === 1 ? candidates[0] : undefined,
		candidates,
	};
}
