import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ILogger } from '../../types/logger';
import { deleteDiscoveryFile, writeDiscoveryFile } from '../shared/discovery';
import { removeClaudeMcpEntry, writeClaudeMcpEntry, writeMcpJson } from './config-writer';
import { McpToolRegistry } from './registry';
import { McpHostServer } from './server';

/** Known VS Code extension IDs for Claude Code. */
const CLAUDE_CODE_EXTENSION_IDS = ['anthropics.claude-code', 'anthropic.claude-code'];

/**
 * Returns true when Claude Code appears to be present.
 * Checks (in order): explicit setting, VS Code extension registry, ~/.claude.json existence.
 */
function shouldRegisterMcp(): boolean {
	const setting = vscode.workspace.getConfiguration('dbt-anvil').get<string>('mcp.registration', 'auto');
	if (setting === 'enabled') { return true; }
	if (setting === 'disabled') { return false; }
	// auto: check for Claude Code extension or prior usage
	const hasExtension = CLAUDE_CODE_EXTENSION_IDS.some(id => !!vscode.extensions.getExtension(id));
	if (hasExtension) { return true; }
	const claudeJson = path.join(os.homedir(), '.claude.json');
	return fs.existsSync(claudeJson);
}

/**
 * Lifecycle container for the MCP subsystem.
 *
 * Owns the registry, the HTTP server, and the side-effects on ~/.claude.json
 * and the discovery file. Callers just call `start` at activation and push the
 * returned disposable onto the extension's subscriptions.
 */
export class McpSubsystem implements vscode.Disposable {
	readonly registry: McpToolRegistry = new McpToolRegistry();
	private server: McpHostServer | null = null;
	private workspacePath: string | null = null;

	constructor(private readonly logger: ILogger) {}

	/**
	 * Starts the HTTP server and writes discovery + Claude Code config.
	 *
	 * Returns `null` on unsupported runtimes (no workspace folder, no home dir)
	 * — the caller should log a warning but continue activation.
	 */
	async start(context: vscode.ExtensionContext): Promise<{ configChanged: boolean } | null> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			this.logger.warn('MCP: no workspace folder — skipping MCP server startup');
			return null;
		}

		if (!shouldRegisterMcp()) {
			this.logger.info('MCP subsystem skipped (dbt-anvil.mcp.registration = disabled or Claude Code not detected) — no server, no discovery file, no config writes');
			return { configChanged: false };
		}

		// Use the raw fsPath as the ~/.claude.json key so it matches whatever
		// path Claude Code derives from cwd when it runs in this workspace.
		// Discovery file naming uses workspaceHash() internally, which normalises
		// (lowercases on Windows) before hashing — so the file is always found
		// regardless of casing.
		// Use native filesystem casing so the key matches what Claude Code
		// derives from process.cwd() when launched in this workspace.
		// On Windows, folder.uri.fsPath has lowercase drive letter; realpathSync.native
		// returns the actual on-disk casing (e.g. C:\Development\...).
		this.workspacePath = fs.realpathSync.native(folder.uri.fsPath);

		const server = new McpHostServer(this.registry, this.logger);
		await server.start();
		this.server = server;

		const version = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0';
		await writeDiscoveryFile({
			port: server.getPort(),
			token: server.getToken(),
			pid: process.pid,
			version,
			startedAt: Date.now(),
			workspacePath: this.workspacePath,
		});

		const proxyScriptPath = path.join(context.extensionPath, 'dist', 'mcp-proxy.js');
		const input = { workspacePath: this.workspacePath, nodePath: 'node', proxyScriptPath };

		// .mcp.json  → VS Code extension reads this (projects[path] in ~/.claude.json is CLI-only)
		// ~/.claude.json → CLI reads this (claude mcp / terminal usage)
		const [mcpJson, claudeJson] = await Promise.all([
			writeMcpJson(input, this.logger),
			writeClaudeMcpEntry(input, this.logger),
		]);
		const result = { changed: mcpJson.changed || claudeJson.changed };

		if (result.changed) {
			this.logger.info('Claude Code MCP entry updated — restart Claude Code to pick up the new server.');
		}
		return { configChanged: result.changed };
	}

	async dispose(): Promise<void> {
		const ws = this.workspacePath;
		this.workspacePath = null;
		if (this.server) {
			await this.server.stop().catch(err => {
				this.logger.warn(`MCP stop failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			this.server = null;
		}
		if (ws) {
			await deleteDiscoveryFile(ws).catch(() => undefined);
		}
	}

	/** Fully removes the Claude Code MCP entry for this workspace. */
	async unregister(): Promise<void> {
		if (!this.workspacePath) { return; }
		await removeClaudeMcpEntry(this.workspacePath, this.logger);
	}
}
