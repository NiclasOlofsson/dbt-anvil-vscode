import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PythonEnvironment {
	/** The command to invoke Python, e.g. ['/path/to/python'] or ['uv', 'run', 'python'] */
	command: string[];
	/** Human-readable description, e.g. "venv at .venv" */
	description: string;
	/** Extra environment variables needed (e.g. PIPENV_IGNORE_VIRTUALENVS=1) */
	envVars?: Record<string, string>;
}

/**
 * Detect the Python environment for a dbt project.
 *
 * Priority order follows dbt-core-mcp env_detector.py:
 *   1. Standard venv (.venv or venv directory)
 *   2. uv (uv.lock present)
 *   3. Poetry (poetry.lock present)
 *   4. Pipenv (Pipfile.lock present)
 *   5. Conda (CONDA_DEFAULT_ENV env var)
 *   6. System Python fallback
 */
export function detectPythonEnvironment(projectDir: string): PythonEnvironment {
	const absProjectDir = path.resolve(projectDir);

	// 1. Standard venv
	const venvPath = findVenv(absProjectDir);
	if (venvPath) {
		const pythonExe = getVenvPython(venvPath);
		return {
			command: [pythonExe],
			description: `venv at ${path.relative(absProjectDir, venvPath)}`,
		};
	}

	// 2. uv
	if (fs.existsSync(path.join(absProjectDir, 'uv.lock'))) {
		return {
			command: ['uv', 'run', '--directory', absProjectDir, 'python'],
			description: 'uv (uv.lock)',
		};
	}

	// 3. Poetry
	if (fs.existsSync(path.join(absProjectDir, 'poetry.lock'))) {
		return {
			command: ['poetry', 'run', '--directory', absProjectDir, 'python'],
			description: 'poetry (poetry.lock)',
		};
	}

	// 4. Pipenv
	if (fs.existsSync(path.join(absProjectDir, 'Pipfile.lock'))) {
		return {
			command: ['pipenv', 'run', 'python'],
			description: 'pipenv (Pipfile.lock)',
			envVars: { PIPENV_IGNORE_VIRTUALENVS: '1' },
		};
	}

	// 5. Conda
	const condaEnv = process.env['CONDA_DEFAULT_ENV'];
	if (condaEnv) {
		return {
			command: ['conda', 'run', '-n', condaEnv, 'python'],
			description: `conda (${condaEnv})`,
		};
	}

	// 6. Fallback to system Python
	const systemPython = process.platform === 'win32' ? 'python' : 'python3';
	return {
		command: [systemPython],
		description: 'system Python',
	};
}

function findVenv(projectDir: string): string | null {
	for (const name of ['.venv', 'venv', '.env']) {
		const candidate = path.join(projectDir, name);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
			// Verify it looks like a venv (has pyvenv.cfg or Scripts/Lib)
			if (
				fs.existsSync(path.join(candidate, 'pyvenv.cfg')) ||
				fs.existsSync(path.join(candidate, 'Scripts')) ||
				fs.existsSync(path.join(candidate, 'bin'))
			) {
				return candidate;
			}
		}
	}
	return null;
}

function getVenvPython(venvPath: string): string {
	if (process.platform === 'win32') {
		const winPython = path.join(venvPath, 'Scripts', 'python.exe');
		if (fs.existsSync(winPython)) return winPython;
		const winPythonAlt = path.join(venvPath, 'Scripts', 'python');
		if (fs.existsSync(winPythonAlt)) return winPythonAlt;
	}
	const unixPython = path.join(venvPath, 'bin', 'python');
	if (fs.existsSync(unixPython)) return unixPython;
	const unixPython3 = path.join(venvPath, 'bin', 'python3');
	if (fs.existsSync(unixPython3)) return unixPython3;

	// Fallback
	return path.join(venvPath, 'bin', 'python');
}

/**
 * Detect the dbt profiles directory for a project.
 * Checks the project dir first, then falls back to ~/.dbt.
 */
export function detectProfilesDir(projectDir: string): string {
	const projectProfiles = path.join(projectDir, 'profiles.yml');
	if (fs.existsSync(projectProfiles)) {
		return projectDir;
	}
	return path.join(os.homedir(), '.dbt');
}

/**
 * Validate that the detected Python environment is actually functional by
 * running `<env.command> --version` with a 10s timeout.
 *
 * Returns true if the command exits with code 0, false otherwise.
 */
export function validatePythonEnvironment(env: PythonEnvironment): Promise<boolean> {
	return new Promise((resolve) => {
		const [executable, ...args] = env.command;
		const child = spawn(executable, [...args, '--version'], {
			env: { ...process.env, ...env.envVars },
			timeout: 10_000,
			windowsHide: true,
		});

		child.on('error', () => resolve(false));
		child.on('close', (code) => resolve(code === 0));
	});
}

/**
 * Returns true if the dbt_packages directory exists in the project,
 * indicating that `dbt deps` has been run.
 */
export function dbtPackagesExist(projectDir: string): boolean {
	return fs.existsSync(path.join(projectDir, 'dbt_packages'));
}
