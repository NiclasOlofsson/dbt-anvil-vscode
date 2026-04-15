import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectPythonEnvironment, checkEnvManagerAvailable, getBootstrapCommand, validateDbtInstalled } from '../dbt/env-detector';
import type { PythonEnvironment } from '../dbt/env-detector';

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

describe('detectPythonEnvironment', () => {
	const tmpDir = path.join(os.tmpdir(), 'dbt-studio-env-test');

	function setup() {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		fs.mkdirSync(tmpDir, { recursive: true });
	}

	function teardown() {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	it('should detect venv when .venv directory with pyvenv.cfg exists', () => {
		setup();
		const venvDir = path.join(tmpDir, '.venv');
		fs.mkdirSync(venvDir);
		fs.writeFileSync(path.join(venvDir, 'pyvenv.cfg'), 'home = /usr/bin\n');
		if (process.platform === 'win32') {
			fs.mkdirSync(path.join(venvDir, 'Scripts'), { recursive: true });
			fs.writeFileSync(path.join(venvDir, 'Scripts', 'python.exe'), '');
		} else {
			fs.mkdirSync(path.join(venvDir, 'bin'), { recursive: true });
			fs.writeFileSync(path.join(venvDir, 'bin', 'python'), '');
		}

		const env = detectPythonEnvironment(tmpDir);
		expect(env.description).toContain('venv');
		teardown();
	});

	it('should detect uv when uv.lock exists', () => {
		setup();
		fs.writeFileSync(path.join(tmpDir, 'uv.lock'), '');

		const env = detectPythonEnvironment(tmpDir);
		expect(env.description).toContain('uv');
		expect(env.command[0]).toBe('uv');
		teardown();
	});

	it('should detect poetry when poetry.lock exists', () => {
		setup();
		fs.writeFileSync(path.join(tmpDir, 'poetry.lock'), '');

		const env = detectPythonEnvironment(tmpDir);
		expect(env.description).toContain('poetry');
		expect(env.command[0]).toBe('poetry');
		teardown();
	});

	it('should fall back to system Python when nothing found', () => {
		setup();

		const env = detectPythonEnvironment(tmpDir);
		expect(env.description).toBe('system Python');
		teardown();
	});
});

describe('getBootstrapCommand', () => {
	const dir = '/some/project';

	it('returns pipenv install for pipenv env', () => {
		const env: PythonEnvironment = { command: ['pipenv', 'run', 'python'], description: 'pipenv (Pipfile.lock)', wrapperPrefix: ['pipenv', 'run'], envVars: { PIPENV_IGNORE_VIRTUALENVS: '1' } };
		expect(getBootstrapCommand(env, dir)).toEqual(['pipenv', 'install']);
	});

	it('returns uv sync for uv env', () => {
		const env: PythonEnvironment = { command: ['uv', 'run', '--directory', dir, 'python'], description: 'uv (uv.lock)', wrapperPrefix: ['uv', 'run', '--directory', dir] };
		expect(getBootstrapCommand(env, dir)).toEqual(['uv', 'sync', '--directory', dir]);
	});

	it('returns poetry install for poetry env', () => {
		const env: PythonEnvironment = { command: ['poetry', 'run', '--directory', dir, 'python'], description: 'poetry (poetry.lock)', wrapperPrefix: ['poetry', 'run', '--directory', dir] };
		expect(getBootstrapCommand(env, dir)).toEqual(['poetry', 'install', '--directory', dir]);
	});

	it('returns null for venv env', () => {
		const env: PythonEnvironment = { command: ['/proj/.venv/bin/python'], description: 'venv at .venv', wrapperPrefix: [], venvBinDir: '/proj/.venv/bin' };
		expect(getBootstrapCommand(env, dir)).toBeNull();
	});

	it('returns null for system Python', () => {
		const env: PythonEnvironment = { command: ['python3'], description: 'system Python', wrapperPrefix: [] };
		expect(getBootstrapCommand(env, dir)).toBeNull();
	});
});

describe('checkEnvManagerAvailable', () => {
	it('returns true for venv env without spawning', async () => {
		const env: PythonEnvironment = { command: ['/proj/.venv/bin/python'], description: 'venv at .venv', wrapperPrefix: [], venvBinDir: '/proj/.venv/bin' };
		expect(await checkEnvManagerAvailable(env)).toBe(true);
	});

	it('returns true for system Python without spawning', async () => {
		const env: PythonEnvironment = { command: ['python3'], description: 'system Python', wrapperPrefix: [] };
		expect(await checkEnvManagerAvailable(env)).toBe(true);
	});

	it('returns false when manager process errors', async () => {
		mockSpawn.mockReturnValue({
			on: (event: string, cb: (...args: unknown[]) => void) => {
				if (event === 'error') cb(new Error('not found'));
			},
		});
		const env: PythonEnvironment = { command: ['pipenv', 'run', 'python'], description: 'pipenv (Pipfile.lock)', wrapperPrefix: ['pipenv', 'run'], envVars: { PIPENV_IGNORE_VIRTUALENVS: '1' } };
		expect(await checkEnvManagerAvailable(env)).toBe(false);
	});

	it('returns false when manager exits non-zero', async () => {
		mockSpawn.mockReturnValue({
			on: (event: string, cb: (...args: unknown[]) => void) => {
				if (event === 'close') cb(1);
			},
		});
		const env: PythonEnvironment = { command: ['uv', 'run', '--directory', '/p', 'python'], description: 'uv (uv.lock)', wrapperPrefix: ['uv', 'run', '--directory', '/p'] };
		expect(await checkEnvManagerAvailable(env)).toBe(false);
	});
});

describe('validateDbtInstalled', () => {
	it('returns false when dbt process errors', async () => {
		mockSpawn.mockReturnValue({
			on: (event: string, cb: (...args: unknown[]) => void) => {
				if (event === 'error') cb(new Error('not found'));
			},
		});
		const env: PythonEnvironment = { command: ['pipenv', 'run', 'python'], description: 'pipenv (Pipfile.lock)', wrapperPrefix: ['pipenv', 'run'], envVars: { PIPENV_IGNORE_VIRTUALENVS: '1' } };
		expect(await validateDbtInstalled(env, '/project')).toBe(false);
	});

	it('returns false when dbt exits non-zero', async () => {
		mockSpawn.mockReturnValue({
			on: (event: string, cb: (...args: unknown[]) => void) => {
				if (event === 'close') cb(127);
			},
		});
		const env: PythonEnvironment = { command: ['uv', 'run', '--directory', '/p', 'python'], description: 'uv (uv.lock)', wrapperPrefix: ['uv', 'run', '--directory', '/p'] };
		expect(await validateDbtInstalled(env, '/p')).toBe(false);
	});

	it('returns true when dbt exits zero', async () => {
		mockSpawn.mockReturnValue({
			on: (event: string, cb: (...args: unknown[]) => void) => {
				if (event === 'close') cb(0);
			},
		});
		const env: PythonEnvironment = { command: ['pipenv', 'run', 'python'], description: 'pipenv (Pipfile.lock)', wrapperPrefix: ['pipenv', 'run'], envVars: { PIPENV_IGNORE_VIRTUALENVS: '1' } };
		expect(await validateDbtInstalled(env, '/project')).toBe(true);
	});
});
