import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PythonEnvironment } from './env-detector';

/**
 * Generate dbt CLI shims for the detected Python environment and return the shims directory path.
 * Returns undefined if no shim is needed (system Python fallback).
 */
export function writeShims(shimsDir: string, pythonEnv: PythonEnvironment): string | undefined {
	// System Python: no shim needed, dbt is already globally available
	if (pythonEnv.description === 'system Python') {
		return undefined;
	}

	// Clean the shims directory
	if (fs.existsSync(shimsDir)) {
		fs.rmSync(shimsDir, { recursive: true, force: true });
	}
	
	// Create the shims directory (and parent directories if needed)
	fs.mkdirSync(shimsDir, { recursive: true });

	if (process.platform === 'win32') {
		writeWindowsShim(shimsDir, pythonEnv);
	} else {
		writeUnixShim(shimsDir, pythonEnv);
	}

	// Verify the shim was created
	const shimFile = process.platform === 'win32' ? path.join(shimsDir, 'dbt.cmd') : path.join(shimsDir, 'dbt');
	if (!fs.existsSync(shimFile)) {
		throw new Error(`Failed to create shim file: ${shimFile}`);
	}

	return shimsDir;
}

function writeWindowsShim(shimsDir: string, pythonEnv: PythonEnvironment): void {
	const shimPath = path.join(shimsDir, 'dbt.cmd');
	let shimContent: string;

	if (pythonEnv.venvBinDir) {
		// venv: call the venv's dbt.exe directly
		// Normalize path and convert to Windows backslashes
		const dbtExe = path.win32.normalize(path.join(pythonEnv.venvBinDir, 'dbt.exe'));
		shimContent = `@"${dbtExe}" %*\n`;
	} else if (pythonEnv.description.startsWith('pipenv')) {
		// pipenv: set env var before calling pipenv run dbt
		const prefix = pythonEnv.wrapperPrefix.join(' ');
		shimContent = `@echo off\nset PIPENV_IGNORE_VIRTUALENVS=1\n${prefix} dbt %*\n`;
	} else {
		// uv, poetry, conda: delegate to wrapper command
		const prefix = pythonEnv.wrapperPrefix.join(' ');
		shimContent = `@${prefix} dbt %*\n`;
	}

	fs.writeFileSync(shimPath, shimContent, 'utf-8');
}

function writeUnixShim(shimsDir: string, pythonEnv: PythonEnvironment): void {
	const shimPath = path.join(shimsDir, 'dbt');
	let shimContent: string;

	if (pythonEnv.venvBinDir) {
		// venv: call the venv's dbt directly
		const dbtBin = path.join(pythonEnv.venvBinDir, 'dbt');
		shimContent = `#!/bin/sh\nexec "${dbtBin}" "$@"\n`;
	} else if (pythonEnv.description.startsWith('pipenv')) {
		// pipenv: export env var before calling pipenv run dbt
		const prefix = pythonEnv.wrapperPrefix.join(' ');
		shimContent = `#!/bin/sh\nexport PIPENV_IGNORE_VIRTUALENVS=1\nexec ${prefix} dbt "$@"\n`;
	} else {
		// uv, poetry, conda: delegate to wrapper command
		const prefix = pythonEnv.wrapperPrefix.join(' ');
		shimContent = `#!/bin/sh\nexec ${prefix} dbt "$@"\n`;
	}

	fs.writeFileSync(shimPath, shimContent, 'utf-8');
	fs.chmodSync(shimPath, 0o755);
}
