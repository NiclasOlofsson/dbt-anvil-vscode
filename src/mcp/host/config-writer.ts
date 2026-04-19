import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ILogger } from '../../types/logger';

const CLAUDE_CONFIG = path.join(os.homedir(), '.claude.json');
const MCP_JSON_FILE = '.mcp.json';
const SERVER_NAME = 'dbt-studio';

interface McpServerEntry {
	type?: 'stdio';
	command: string;
	args: string[];
	env?: Record<string, string>;
}

interface ClaudeConfig {
	projects?: Record<string, {
		mcpServers?: Record<string, McpServerEntry>;
		[key: string]: unknown;
	}>;
	[key: string]: unknown;
}

export interface ConfigWriteInput {
	workspacePath: string;
	nodePath: string;
	proxyScriptPath: string;
}

export interface ConfigWriteResult {
	changed: boolean;
}

/**
 * Writes `.mcp.json` in the workspace root.
 *
 * This is what the Claude Code VS Code extension reads for project-scoped MCP
 * servers. The `projects` section of `~/.claude.json` is CLI-only; the VS Code
 * extension ignores it and looks here instead.
 *
 * The file contains an absolute proxy path so it should not be committed. The
 * extension adds a `.gitignore` entry for it automatically.
 */
export async function writeMcpJson(
	input: ConfigWriteInput,
	logger: ILogger,
): Promise<ConfigWriteResult> {
	const target = path.join(input.workspacePath, MCP_JSON_FILE);
	const desired: McpServerEntry = {
		type: 'stdio',
		command: input.nodePath,
		args: [input.proxyScriptPath, '--workspace', input.workspacePath],
	};

	let existing: { mcpServers?: Record<string, McpServerEntry> } = {};
	try {
		existing = JSON.parse(await fs.promises.readFile(target, 'utf8')) as typeof existing;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
	}

	existing.mcpServers ??= {};
	if (serversEqual(existing.mcpServers[SERVER_NAME], desired)) {
		return { changed: false };
	}

	existing.mcpServers[SERVER_NAME] = desired;
	const tmp = `${target}.${process.pid}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(existing, null, 2), 'utf8');
	await fs.promises.rename(tmp, target);
	logger.info(`Updated ${MCP_JSON_FILE} in workspace`);

	await ensureGitignored(input.workspacePath, MCP_JSON_FILE, logger);
	return { changed: true };
}

/**
 * Also writes the `projects[path].mcpServers` entry in `~/.claude.json` for
 * users who invoke Claude Code from the CLI (`claude`) rather than the VS Code
 * extension. The VS Code extension ignores this but the CLI reads it.
 */
export async function writeClaudeMcpEntry(
	input: ConfigWriteInput,
	logger: ILogger,
): Promise<ConfigWriteResult> {
	const desired: McpServerEntry = {
		type: 'stdio',
		command: input.nodePath,
		args: [input.proxyScriptPath, '--workspace', input.workspacePath],
	};

	const config = await readConfig();
	config.projects ??= {};
	const projectEntry = (config.projects[input.workspacePath] ??= {});
	projectEntry.mcpServers ??= {};

	if (serversEqual(projectEntry.mcpServers[SERVER_NAME], desired)) {
		return { changed: false };
	}

	projectEntry.mcpServers[SERVER_NAME] = desired;
	await writeConfigAtomic(config);
	logger.info(`Updated ~/.claude.json MCP entry (project: ${input.workspacePath})`);
	return { changed: true };
}

export async function removeClaudeMcpEntry(
	workspacePath: string,
	logger: ILogger,
): Promise<void> {
	try {
		const config = await readConfig();
		const project = config.projects?.[workspacePath];
		if (!project?.mcpServers?.[SERVER_NAME]) { return; }
		delete project.mcpServers[SERVER_NAME];
		await writeConfigAtomic(config);
		logger.info(`Removed ~/.claude.json MCP entry for ${workspacePath}`);
	} catch (err) {
		logger.warn(`Failed to remove MCP entry: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Appends `pattern` to `.gitignore` in `dir` if it isn't already listed.
 * `.mcp.json` contains an absolute machine-specific proxy path and must not
 * be committed.
 */
async function ensureGitignored(dir: string, pattern: string, logger: ILogger): Promise<void> {
	const gitignore = path.join(dir, '.gitignore');
	try {
		const existing = await fs.promises.readFile(gitignore, 'utf8').catch(() => '');
		const lines = existing.split('\n').map(l => l.trim());
		if (lines.includes(pattern)) { return; }
		const appended = existing.endsWith('\n') || existing === ''
			? `${existing}${pattern}\n`
			: `${existing}\n${pattern}\n`;
		await fs.promises.writeFile(gitignore, appended, 'utf8');
		logger.info(`Added ${pattern} to .gitignore`);
	} catch (err) {
		logger.warn(`Could not update .gitignore: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function readConfig(): Promise<ClaudeConfig> {
	try {
		const raw = await fs.promises.readFile(CLAUDE_CONFIG, 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		return (parsed && typeof parsed === 'object') ? parsed as ClaudeConfig : {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return {}; }
		throw err;
	}
}

async function writeConfigAtomic(config: ClaudeConfig): Promise<void> {
	const tmp = `${CLAUDE_CONFIG}.${process.pid}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
	await fs.promises.rename(tmp, CLAUDE_CONFIG);
}

function serversEqual(a: McpServerEntry | undefined, b: McpServerEntry): boolean {
	if (!a) { return false; }
	if (a.command !== b.command || a.type !== b.type) { return false; }
	const aa = a.args ?? [];
	if (aa.length !== b.args.length) { return false; }
	return b.args.every((v, i) => aa[i] === v);
}
