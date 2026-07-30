import * as vscode from 'vscode';

const PYTHON_EXTENSION_ID = 'ms-python.python';
/** How long to let the Python extension finish discovery before reading its answer. */
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * The slice of the Python extension's API we use. Typed here rather than pulled
 * from `@vscode/python-extension` so the extension stays optional: users without
 * it installed still get project discovery and the `dbt-anvil.pythonPath` setting.
 */
interface PythonEnvironmentInfo {
	readonly id: string;
	readonly path: string;
	readonly environment?: { readonly name?: string; readonly folderUri?: vscode.Uri };
	readonly version?: { readonly major: number; readonly minor: number; readonly micro: number };
}

interface PythonExtensionApi {
	environments: {
		readonly known: readonly PythonEnvironmentInfo[];
		getActiveEnvironmentPath(resource?: vscode.Uri): { id: string; path: string };
		onDidChangeActiveEnvironmentPath: vscode.Event<{ id: string; path: string }>;
		refreshEnvironments(options?: { forceRefresh?: boolean }): Promise<void>;
	};
}

/**
 * Open VS Code's own interpreter picker.
 *
 * It is not reachable from a dbt project on its own: the Python extension
 * activates on Python files, and a dbt project is SQL and YAML, so its status bar
 * entry and `Python: Select Interpreter` never appear. Waking it here is the
 * whole job. The choice lands in the Python extension's own state, which is where
 * we read it from at the next activation anyway, so there is nothing to capture.
 */
export async function openInterpreterPicker(): Promise<void> {
	const extension = vscode.extensions.getExtension<PythonExtensionApi>(PYTHON_EXTENSION_ID);
	if (!extension) {
		void vscode.window.showWarningMessage(
			'dbt Anvil: install the Python extension to choose an interpreter, or set dbt-anvil.pythonPath to one.',
		);
		return;
	}

	if (!extension.isActive) {
		await extension.activate();
	}
	await vscode.commands.executeCommand('python.setInterpreter');
}

/**
 * `python.defaultInterpreterPath` ships with the literal default `python`, and
 * the Python extension hands that straight back as the "active environment" when
 * the user has never selected one. It is a command name, not a path to anything,
 * and resolving it produces a file next to whatever the host's working directory
 * happens to be. Anything without a separator means "nobody has told VS Code
 * where Python is", which is not an answer we can use.
 */
function namesAPath(candidate: string): boolean {
	return candidate.includes('/') || candidate.includes('\\');
}

/**
 * The interpreter VS Code has for this folder: the one the user selected, or the
 * `python.defaultInterpreterPath` fallback when they never selected one. The
 * Python extension resolves that fallback itself, so one call covers both.
 *
 * Undefined when VS Code has no real answer, leaving the system Python fallback
 * to say so honestly rather than failing against a fabricated path.
 *
 * Every other environment source is a fact on disk that reads the same every
 * time. This one is another extension's opinion, and it revises that opinion a
 * second or two into startup, once its own discovery finishes. Asking before
 * then returns whatever it happened to be carrying, which is how a stale global
 * virtualenv ended up being reported as the environment for a fresh project. So
 * we wait for the refresh to finish, and only then read: after that the answer
 * is stable and can be treated like every other source.
 *
 * Activating the Python extension and waiting for discovery costs time on a cold
 * start, so call this only once project discovery has come up empty.
 */
export async function getVsCodeInterpreter(resource: vscode.Uri): Promise<string | undefined> {
	const extension = vscode.extensions.getExtension<PythonExtensionApi>(PYTHON_EXTENSION_ID);
	if (!extension) {
		// Without the Python extension the setting is all the user has, and nothing
		// else reads it for us. `get` would return the packaged default, so ask which
		// values were actually set.
		const setting = vscode.workspace.getConfiguration('python', resource).inspect<string>('defaultInterpreterPath');
		const configured = setting?.workspaceFolderValue ?? setting?.workspaceValue ?? setting?.globalValue;
		return configured && namesAPath(configured) ? configured : undefined;
	}

	if (!extension.isActive) {
		await extension.activate();
	}

	// Capped: a slow disk scan must not hold activation open indefinitely. Reading
	// early is what we are fixing, but hanging is worse than reading early.
	await Promise.race([
		extension.exports.environments.refreshEnvironments(),
		new Promise<void>((resolve) => setTimeout(resolve, DISCOVERY_TIMEOUT_MS)),
	]);

	const active = extension.exports.environments.getActiveEnvironmentPath(resource).path;
	return active && namesAPath(active) ? active : undefined;
}

