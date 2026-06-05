import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { PythonEnvironment } from './env-detector';

export interface DbtLogEvent {
	info?: { name?: string; msg?: string; level?: string };
	data?: Record<string, unknown>;
}

export interface DbtCommandResult {
	success: boolean;
	stdout: string;
	stderr: string;
	error?: Error;
	/** Parsed JSON payload from the bridge response (for structured commands like get_columns). */
	data?: Record<string, unknown>;
	/** Streaming log events captured during the command (--log-format json). */
	events?: DbtLogEvent[];
}

interface BridgeRequest {
	command: string[];
}

interface BridgeReadyMessage {
	type: 'ready';
}

interface BridgeCompletionMessage {
	success: boolean;
}

interface BridgeErrorMessage {
	type: 'error';
	error: string;
}

type BridgeMessage = BridgeReadyMessage | BridgeCompletionMessage | BridgeErrorMessage;

/**
 * Manages a persistent Python bridge process for dbt execution.
 *
 * Spawns bridge.py in the user's Python environment once, then sends JSON
 * commands over stdin and reads structured responses from stdout.
 */
export class BridgeRunner {
	private _process: ChildProcessWithoutNullStreams | null = null;
	private _ready = false;
	private _pendingResolve: ((result: DbtCommandResult) => void) | null = null;
	private _stdoutBuffer = '';
	private _stderrBuffer = '';
	private _stdoutLines: string[] = [];
	private _stderrLines: string[] = [];
	private _eventLines: DbtLogEvent[] = [];
	private readonly _onCommandEvent = new vscode.EventEmitter<DbtLogEvent>();
	readonly onCommandEvent = this._onCommandEvent.event;
	/** Serialise commands — only one dbt command at a time */
	private _queue: (() => Promise<void>)[] = [];
	private _running = false;
	private _currentCommandLabel = '';

	constructor(
		private readonly bridgePyPath: string,
		private readonly projectDir: string,
		private readonly env: PythonEnvironment,
		private readonly logger: ILogger,
		private readonly stateDir: string = projectDir,
		private readonly extensionTargetDir: string = path.join(projectDir, 'target'),
	) {}

	/**
	 * Ensure the bridge process is started and ready.
	 */
	private async ensureStarted(): Promise<void> {
		if (this._process && this._ready) {
			return;
		}

		await this._start();
	}

	private async _start(): Promise<void> {
		this.logger.info(`Starting dbt bridge process (Python: ${this.env.command[0]})`);

		const [python, ...pythonArgs] = this.env.command;

		// Bridge.py is the last arg; any pythonArgs precede the bridge script
		const args = [...pythonArgs, this.bridgePyPath];

		const envVars: NodeJS.ProcessEnv = {
			...process.env,
			PYTHONIOENCODING: 'utf-8',
			DBT_PROJECT_DIR: this.projectDir,
			DBT_EXTENSION_TARGET_PATH: this.extensionTargetDir,
			DBT_USE_COLORS: '0',
			DBT_LOG_LEVEL_FILE: 'none',
			...buildDbtLogDir(this.projectDir),
			...(this.env.envVars ?? {}),
		};

		this._process = spawn(python, args, {
			cwd: this.projectDir,
			env: envVars,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this._stdoutBuffer = '';
		this._stderrBuffer = '';
		this._ready = false;

		this._process.stdout.setEncoding('utf-8');
		this._process.stderr.setEncoding('utf-8');

		this._process.stderr.on('data', (chunk: string) => {
			this._stderrBuffer += chunk;
			const lines = this._stderrBuffer.split('\n');
			this._stderrBuffer = lines.pop() ?? '';
			for (const line of lines) {
				if (line && line.trim()) {
					this.logger.trace(`[bridge stderr] ${line}`);
					this._stderrLines.push(line);
				}
			}
		});

		this._process.on('exit', (code) => {
			this.logger.info(`Bridge process exited (code=${code})`);
			this._process = null;
			this._ready = false;
			// Reject any pending command
			if (this._pendingResolve) {
				const resolve = this._pendingResolve;
				this._pendingResolve = null;
				resolve({
					success: false,
					stdout: this._stdoutLines.join('\n'),
					stderr: this._stderrLines.join('\n'),
					error: new Error(`Bridge process exited unexpectedly (code=${code})`),
				});
			}
		});

		// Wait for the ready signal
		await this._waitForReady();
		this.logger.info('dbt bridge is ready');
	}

	private _waitForReady(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('Timeout waiting for bridge ready signal (30s)'));
			}, 30_000);

			const onData = (chunk: string) => {
				this._stdoutBuffer += chunk;
				const lines = this._stdoutBuffer.split('\n');
				this._stdoutBuffer = lines.pop() ?? '';

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line) as BridgeMessage;
						if ('type' in msg && msg.type === 'ready') {
							clearTimeout(timeout);
							this._process?.stdout.removeListener('data', onData);
							// Hook up the main data handler
							this._process?.stdout.on('data', this._onStdoutData.bind(this));
							this._ready = true;
							resolve();
							return;
						} else if ('type' in msg && msg.type === 'error') {
							clearTimeout(timeout);
							this._process?.stdout.removeListener('data', onData);
							reject(new Error((msg as BridgeErrorMessage).error));
							return;
						}
					} catch {
						this.logger.warn(`[bridge] Non-JSON startup line: ${line}`);
					}
				}
			};

			this._process?.stdout.on('data', onData);
		});
	}

	private _onStdoutData(chunk: string): void {
		this._stdoutBuffer += chunk;
		const lines = this._stdoutBuffer.split('\n');
		this._stdoutBuffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) continue;

			// Try to parse every line as JSON
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;

				// __bridge__ sentinel marks command completion
				if (parsed['__bridge__'] === true) {
					if (this._pendingResolve) {
						const resolve = this._pendingResolve;
						this._pendingResolve = null;
						const stdout = this._eventLines
							.map(e => e.info?.msg ?? '')
							.filter(Boolean)
							.join('\n');
						const result: DbtCommandResult = {
							success: parsed['success'] as boolean,
							data: parsed,
							stdout,
							stderr: this._stderrLines.join('\n'),
							events: [...this._eventLines],
						};
						const label = this._currentCommandLabel || 'bridge request';
						const status = result.success ? 'succeeded' : 'failed';
						this.logger.info(`${label} — ${status}`);
						this._currentCommandLabel = '';
						resolve(result);
					}
					return;
				}

				// Regular dbt JSON log event — collect and forward
				const event = parsed as DbtLogEvent;
				this._eventLines.push(event);
				this._onCommandEvent.fire(event);
				this.logger.trace(`[bridge] ${event.info?.msg ?? line}`);
				continue;
			} catch {
				// Not JSON (e.g. compile text output) — treat as plain stdout
			}

			this._stdoutLines.push(line);
			this.logger.trace(`[bridge] ${line}`);
		}
	}

	/**
	 * Run a dbt command (e.g. ['run', '--select', 'my_model']).
	 * Commands are serialised — concurrent calls are queued.
	 */
	invoke(args: string[]): Promise<DbtCommandResult> {
		return new Promise((resolve, reject) => {
			const run = async () => {
				try {
					const result = await this._invokeInternal(args);
					resolve(result);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				} finally {
					this._running = false;
					const next = this._queue.shift();
					if (next) {
						this._running = true;
						void next();
					}
				}
			};

			if (this._running) {
				this._queue.push(run);
			} else {
				this._running = true;
				void run();
			}
		});
	}

	private async _invokeInternal(args: string[]): Promise<DbtCommandResult> {
		await this.ensureStarted();

		if (!this._process) {
			throw new Error('Bridge process is not running');
		}

		this._stdoutLines = [];
		this._stderrLines = [];
		this._eventLines = [];

		const request: BridgeRequest = { command: args };
		const line = JSON.stringify(request) + '\n';

		this._currentCommandLabel = `dbt ${args.join(' ')}`;
		this.logger.info(`Bridge command: ${this._currentCommandLabel}`);

		return new Promise<DbtCommandResult>((resolve) => {
			this._pendingResolve = resolve;
			this._process!.stdin.write(line, 'utf-8');
		});
	}

	/**
	 * Compile a Jinja SQL string without executing it.
	 * Returns the compiled SQL or throws if compilation fails.
	 */
	async compileInlineSql(sql: string): Promise<string> {
		const result = await this.invokeRaw({ compile_inline: sql });
		if (!result.success || !result.data) {
			throw new Error(`compile_inline failed: ${result.stderr || 'unknown error'}`);
		}
		const compiled = result.data['compiled_sql'];
		if (typeof compiled !== 'string') {
			throw new Error('compile_inline: missing compiled_sql in bridge response');
		}
		return compiled;
	}

	/**
	 * Save current manifest as run state for state-based selection.
	 * Copies <extension target>/manifest.json → <storageUri>/state_last_run/manifest.json.
	 */
	async saveRunState(): Promise<void> {
		const src = path.join(this.extensionTargetDir, 'manifest.json');
		const destDir = path.join(this.stateDir, 'state_last_run');
		const dest = path.join(destDir, 'manifest.json');
		try {
			await fs.mkdir(destDir, { recursive: true });
			await fs.copyFile(src, dest);
			this.logger.info(`Saved run state to ${dest}`);
		} catch (err) {
			this.logger.warn(`Failed to save run state: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Send a custom JSON message to the bridge (non-command).
	 */
	invokeRaw(request: Record<string, unknown>): Promise<DbtCommandResult> {
		return new Promise((resolve, reject) => {
			const run = async () => {
				try {
					const result = await this._invokeRawInternal(request);
					resolve(result);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				} finally {
					this._running = false;
					const next = this._queue.shift();
					if (next) {
						this._running = true;
						void next();
					}
				}
			};

			if (this._running) {
				this._queue.push(run);
			} else {
				this._running = true;
				void run();
			}
		});
	}

	private async _invokeRawInternal(request: Record<string, unknown>): Promise<DbtCommandResult> {
		await this.ensureStarted();

		if (!this._process) {
			throw new Error('Bridge process is not running');
		}

		this._stdoutLines = [];
		this._stderrLines = [];

		const line = JSON.stringify(request) + '\n';

		const reqKeys = Object.keys(request).filter(k => k !== 'schema_mapping' && k !== 'upstream_sql');
		const upstreamCount = 'upstream_sql' in request ? ` upstream_sql[${Object.keys((request as Record<string, unknown>)['upstream_sql'] as object).length}]` : '';
		this.logger.debug(`Bridge raw request: {${reqKeys.join(', ')}}${upstreamCount}`);

		return new Promise<DbtCommandResult>((resolve) => {
			this._pendingResolve = resolve;
			this._process!.stdin.write(line, 'utf-8');
		});
	}

	/**
	 * Notify the bridge that the dbt manifest has been rebuilt so it discards
	 * the cached Manifest object.  The next compile_inline call will re-parse.
	 */
	async invalidateManifestCache(): Promise<void> {
		if (!this.isRunning) return;
		await this.invokeRaw({ invalidate_manifest: true });
	}

	async shutdown(): Promise<void> {
		if (!this._process) return;

		try {
			this._process.stdin.write(JSON.stringify({ shutdown: true }) + '\n', 'utf-8');
			await waitForExit(this._process, 5_000);
		} catch {
			this._process.kill('SIGKILL');
		} finally {
			this._process = null;
			this._ready = false;
		}
	}

	/**
	 * Hard-kill the bridge process while a command is in-flight. Resolves the
	 * pending request with a failure result before killing so callers don't
	 * hang. The next invoke will respawn the bridge via ensureStarted().
	 *
	 * Returns false if there is no in-flight command to cancel.
	 */
	killActive(reason = 'Cancelled by user'): boolean {
		if (!this._process || !this._pendingResolve) return false;

		const resolve = this._pendingResolve;
		const proc = this._process;

		this._pendingResolve = null;
		this._process = null;
		this._ready = false;

		this.logger.info(`Killing bridge process: ${reason}`);

		resolve({
			success: false,
			stdout: this._stdoutLines.join('\n'),
			stderr: this._stderrLines.join('\n'),
			error: new Error(reason),
		});

		proc.kill('SIGKILL');
		return true;
	}

	get isRunning(): boolean {
		return this._process !== null && this._ready;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Process exit timeout')), timeoutMs);
		proc.once('exit', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function buildDbtLogDir(projectDir: string): Record<string, string> {
	const crypto = require('node:crypto') as typeof import('node:crypto');
	const hash = crypto.createHash('md5').update(projectDir).digest('hex').slice(0, 8);
	const logDir = path.join(os.tmpdir(), `dbt_anvil_logs_${hash}`);
	return { DBT_LOG_PATH: logDir };
}
