import * as vscode from 'vscode';

const PYTHON_EXTENSION_ID = 'ms-python.python';

/**
 * The slice of the Python extension's API we use. Typed here rather than pulled
 * from `@vscode/python-extension` so the extension stays optional: users without
 * it installed still get project discovery and the `dbt-anvil.pythonPath` setting.
 */
interface PythonExtensionApi {
	environments: {
		getActiveEnvironmentPath(resource?: vscode.Uri): { id: string; path: string };
		onDidChangeActiveEnvironmentPath: vscode.Event<{ id: string; path: string }>;
	};
}

/**
 * The interpreter VS Code has for this folder: the one the user selected, or the
 * `python.defaultInterpreterPath` fallback when they never selected one. The
 * Python extension resolves that fallback itself, so one call covers both.
 *
 * Activating the Python extension costs time on a cold start, so call this only
 * once project discovery has come up empty.
 */
export async function getVsCodeInterpreter(resource: vscode.Uri): Promise<string | undefined> {
	const extension = vscode.extensions.getExtension<PythonExtensionApi>(PYTHON_EXTENSION_ID);
	if (!extension) {
		// Without the Python extension the setting is all the user has, and nothing
		// else reads it for us.
		return vscode.workspace.getConfiguration('python', resource).get<string>('defaultInterpreterPath') || undefined;
	}

	if (!extension.isActive) {
		await extension.activate();
	}
	return extension.exports.environments.getActiveEnvironmentPath(resource).path || undefined;
}

/**
 * Fire when the user picks a different interpreter. Nothing re-resolves the
 * environment mid-session, so the handler's job is to offer a reload.
 */
export function onDidChangeVsCodeInterpreter(handler: () => void): vscode.Disposable {
	const extension = vscode.extensions.getExtension<PythonExtensionApi>(PYTHON_EXTENSION_ID);
	if (!extension?.isActive) {
		return new vscode.Disposable(() => { /* no Python extension: nothing to listen to */ });
	}
	return extension.exports.environments.onDidChangeActiveEnvironmentPath(handler);
}
