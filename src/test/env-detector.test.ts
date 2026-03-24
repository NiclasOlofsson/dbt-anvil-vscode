import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectPythonEnvironment } from '../dbt/env-detector';

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
