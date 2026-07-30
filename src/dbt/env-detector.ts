import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PythonEnvironment {
	/** The command to invoke Python, e.g. ['/path/to/python'] or ['uv', 'run', 'python'] */
	command: string[];
	/** Human-readable description, e.g. "venv at .venv" */
	description: string;
	/** Extra environment variables needed (e.g. PIPENV_IGNORE_VIRTUALENVS=1) */
	envVars?: Record<string, string>;
	/** Wrapper command prefix before 'dbt' for shim generation (e.g. ['uv', 'run', '--directory', dir]) */
	wrapperPrefix: string[];
	/** Bin directory for venv environments (e.g. '.venv/Scripts' or '.venv/bin') */
	venvBinDir?: string;
}

/** Description prefix for an environment taken from VS Code's interpreter selection. */
const VSCODE_INTERPRETER_LABEL = 'VS Code interpreter';

/** Interpreter paths that come from outside the project directory. */
export interface PythonEnvSources {
	/** `dbt-anvil.pythonPath`. Set only when the user wants to override discovery. */
	configuredPath?: string;
	/**
	 * The interpreter VS Code has for this folder. Resolving it needs the Python
	 * extension, so callers pass it in rather than have this module import `vscode`.
	 */
	vscodeInterpreter?: string;
}

/**
 * Detect the Python environment for a dbt project.
 *
 * Priority order:
 *   0. `dbt-anvil.pythonPath`, for the case VS Code cannot express: one workspace
 *      folder holding several dbt projects that need different interpreters
 *   1. Standard venv (.venv or venv directory)
 *   2. uv (uv.lock present)
 *   3. Poetry (poetry.lock present)
 *   4. Pipenv (Pipfile.lock present)
 *   5. Conda (CONDA_DEFAULT_ENV env var)
 *   6. VS Code's interpreter, when the project itself yielded nothing
 *   7. System Python fallback
 *
 * Steps 1-5 follow dbt-core-mcp env_detector.py. Step 6 sits below them so a
 * project that resolves today keeps resolving the same way, and above step 7
 * because an interpreter the user picked always beats a bare `python` guess.
 */
export function detectPythonEnvironment(projectDir: string, sources: PythonEnvSources = {}): PythonEnvironment {
	const absProjectDir = path.resolve(projectDir);

	// 0. Explicit override. Used as given: a path that does not exist must fail
	// validation loudly, naming the setting, rather than silently fall through.
	if (sources.configuredPath) {
		return pythonEnvFromPath(sources.configuredPath, 'dbt-anvil.pythonPath');
	}

	// 1. Standard venv
	const venvPath = findVenv(absProjectDir);
	if (venvPath) {
		const pythonExe = getVenvPython(venvPath);
		const venvBinDir = process.platform === 'win32'
			? path.join(venvPath, 'Scripts')
			: path.join(venvPath, 'bin');
		return {
			command: [pythonExe],
			description: `venv at ${path.relative(absProjectDir, venvPath)}`,
			wrapperPrefix: [],
			venvBinDir,
		};
	}

	// 2. uv
	if (fs.existsSync(path.join(absProjectDir, 'uv.lock'))) {
		return {
			command: ['uv', 'run', '--directory', absProjectDir, 'python'],
			description: 'uv (uv.lock)',
			wrapperPrefix: ['uv', 'run', '--directory', absProjectDir],
		};
	}

	// 3. Poetry
	if (fs.existsSync(path.join(absProjectDir, 'poetry.lock'))) {
		return {
			command: ['poetry', 'run', '--directory', absProjectDir, 'python'],
			description: 'poetry (poetry.lock)',
			wrapperPrefix: ['poetry', 'run', '--directory', absProjectDir],
		};
	}

	// 4. Pipenv
	if (fs.existsSync(path.join(absProjectDir, 'Pipfile.lock'))) {
		return {
			command: ['pipenv', 'run', 'python'],
			description: 'pipenv (Pipfile.lock)',
			envVars: { PIPENV_IGNORE_VIRTUALENVS: '1' },
			wrapperPrefix: ['pipenv', 'run'],
		};
	}

	// 5. Conda
	const condaEnv = process.env['CONDA_DEFAULT_ENV'];
	if (condaEnv) {
		return {
			command: ['conda', 'run', '-n', condaEnv, 'python'],
			description: `conda (${condaEnv})`,
			wrapperPrefix: ['conda', 'run', '-n', condaEnv],
		};
	}

	// 6. Nothing in the project. Use whatever interpreter VS Code has for this
	// folder: the venv may be central, a sibling, or shared across repos.
	if (sources.vscodeInterpreter) {
		return pythonEnvFromPath(sources.vscodeInterpreter, VSCODE_INTERPRETER_LABEL);
	}

	// 7. Fallback to system Python
	const systemPython = process.platform === 'win32' ? 'python' : 'python3';
	return {
		command: [systemPython],
		description: 'system Python',
		wrapperPrefix: [],
	};
}

/**
 * True when the resolved environment is one that VS Code's interpreter selection
 * decides: either it already supplied the interpreter, or nothing was found and a
 * selection would be used the next time round.
 */
export function followsVsCodeInterpreter(env: PythonEnvironment): boolean {
	return env.description.startsWith(VSCODE_INTERPRETER_LABEL) || env.description === 'system Python';
}

/**
 * Build an environment from a path pointing at either a Python executable or the
 * environment directory holding one. Both shapes occur: the Python extension
 * reports a directory for conda environments and an executable for venvs, and
 * users write either into `dbt-anvil.pythonPath`.
 *
 * `venvBinDir` is set so the dbt lookup and the terminal shims call the `dbt`
 * sitting next to the interpreter, the same way a discovered venv is treated.
 */
function pythonEnvFromPath(pythonPath: string, label: string): PythonEnvironment {
	// A bare command name ("python", "python3") has no directory to resolve
	// against. Resolving it would invent a file next to the extension host's
	// working directory, so run it as the command it is and let PATH answer.
	if (!pythonPath.includes('/') && !pythonPath.includes('\\')) {
		return {
			command: [pythonPath],
			description: `${label} (${pythonPath})`,
			wrapperPrefix: [],
		};
	}

	const resolved = path.resolve(pythonPath);
	const isDirectory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
	const pythonExe = isDirectory ? getVenvPython(resolved) : resolved;
	return {
		command: [pythonExe],
		description: `${label} (${pythonExe})`,
		wrapperPrefix: [],
		venvBinDir: path.dirname(pythonExe),
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

/**
 * Check that the environment manager CLI (pipenv/uv/poetry) is available on
 * PATH. For env types that need no manager (venv, system Python, conda) this
 * always returns true.
 */
export function checkEnvManagerAvailable(env: PythonEnvironment): Promise<boolean> {
	const manager = _envManagerExecutable(env);
	if (!manager) return Promise.resolve(true);

	return new Promise((resolve) => {
		const child = spawn(manager, ['--version'], {
			env: { ...process.env, ...env.envVars },
			timeout: 10_000,
			windowsHide: true,
		});
		child.on('error', () => resolve(false));
		child.on('close', (code) => resolve(code === 0));
	});
}

/**
 * Return the shell command that installs the locked dependencies for this
 * environment. Returns null for env types that have no managed lockfile
 * (venv, system Python, conda).
 */
export function getBootstrapCommand(env: PythonEnvironment, projectDir: string): string[] | null {
	if (env.description.startsWith('pipenv')) {
		return ['pipenv', 'install'];
	}
	if (env.description.startsWith('uv')) {
		return ['uv', 'sync', '--directory', projectDir];
	}
	if (env.description.startsWith('poetry')) {
		return ['poetry', 'install', '--directory', projectDir];
	}
	return null;
}

/**
 * Validate that `dbt` is installed inside the detected Python environment by
 * running `dbt --version` through the environment's wrapper prefix.
 *
 * `dbt --version` has a slow cold start (Python import overhead) and can exceed a
 * single timeout on a busy machine. A timeout is inconclusive — "slow/busy", NOT
 * proof that dbt is missing — so we retry (the next run is usually warm and fast).
 * A spawn error or non-zero exit IS conclusive, so we fail fast without retrying.
 * After `maxAttempts` timeouts we give up (the threshold) so activation can't stall.
 */
export async function validateDbtInstalled(
	env: PythonEnvironment,
	projectDir: string,
	opts: { timeoutMs?: number; maxAttempts?: number } = {},
): Promise<boolean> {
	let cmd: string[];
	if (env.venvBinDir) {
		const dbtExe = process.platform === 'win32'
			? path.join(env.venvBinDir, 'dbt.exe')
			: path.join(env.venvBinDir, 'dbt');
		cmd = fs.existsSync(dbtExe) ? [dbtExe, '--version'] : [...env.wrapperPrefix, 'dbt', '--version'];
	} else if (env.wrapperPrefix.length > 0) {
		cmd = [...env.wrapperPrefix, 'dbt', '--version'];
	} else {
		cmd = ['dbt', '--version'];
	}

	const timeoutMs = opts.timeoutMs ?? 15_000;
	const maxAttempts = opts.maxAttempts ?? 3;

	const runOnce = (): Promise<'ok' | 'failed' | 'timeout'> => new Promise((resolve) => {
		const [executable, ...args] = cmd;
		const child = spawn(executable, args, {
			cwd: projectDir,
			env: { ...process.env, ...env.envVars },
			windowsHide: true,
		});
		let settled = false;
		const finish = (result: 'ok' | 'failed' | 'timeout') => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => { child.kill(); finish('timeout'); }, timeoutMs);
		child.on('error', () => finish('failed'));
		child.on('close', (code) => finish(code === 0 ? 'ok' : 'failed'));
	});

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = await runOnce();
		if (result === 'ok') return true;
		if (result === 'failed') return false; // spawn error / non-zero exit — retrying won't help
		// timeout: inconclusive; retry unless we've exhausted attempts
	}
	return false; // all attempts timed out — give up so activation can't hang forever
}

/** Returns the manager executable name, or null if the env needs no manager. */
function _envManagerExecutable(env: PythonEnvironment): string | null {
	if (env.description.startsWith('pipenv')) return 'pipenv';
	if (env.description.startsWith('uv')) return 'uv';
	if (env.description.startsWith('poetry')) return 'poetry';
	return null;
}
