import * as path from 'path';
import { loadPyodide } from 'pyodide';
import type { PyodideInterface } from 'pyodide';

export interface PyodideRuntime {
	pyodide: PyodideInterface;
}

/**
 * Load Pyodide and mount vendored sqlglot into the Python path.
 *
 * @param pyodideDir  Directory of the pyodide npm package (contains pyodide.asm.wasm).
 * @param vendorDir   Directory to mount at /vendor (must contain sqlglot/).
 * @param scriptsDir  Directory to mount at /scripts (contains .py source files).
 */
export async function initPyodide(pyodideDir: string, vendorDir: string, scriptsDir: string): Promise<PyodideRuntime> {
	const pyodide = await loadPyodide({
		indexURL: pyodideDir + path.sep,
	});

	pyodide.FS.mkdir('/vendor');
	pyodide.FS.mount((pyodide.FS.filesystems as Record<string, unknown>)['NODEFS'] as object, { root: vendorDir }, '/vendor');
	pyodide.runPython('import sys; sys.path.insert(0, "/vendor")');

	pyodide.FS.mkdir('/scripts');
	pyodide.FS.mount((pyodide.FS.filesystems as Record<string, unknown>)['NODEFS'] as object, { root: scriptsDir }, '/scripts');

	return { pyodide };
}
