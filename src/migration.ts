import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ILogger } from './types/logger';

/**
 * One-time migration from the previous extension identity ("dbt Studio",
 * id `nickeolofsson.dbt-studio-vscode`, config namespace `dbt-studio.*`,
 * MCP server `dbt-studio`, discovery dir `~/.dbt-studio`) to "dbt Anvil".
 *
 * Because the rename ships under a NEW extension identifier, an existing user
 * installs dbt Anvil as a fresh extension while their old `dbt-studio.*`
 * settings still live in settings.json. This copies them to `dbt-anvil.*`,
 * repoints the default SQL formatter, and removes the stale MCP wiring left
 * by the old extension. Runs once, guarded by globalState.
 */

const MIGRATION_FLAG = 'dbtAnvil.migratedFromDbtStudio.v1';
const OLD_ID = 'nickeolofsson.dbt-studio-vscode';
const NEW_ID = 'nickeolofsson.dbt-anvil';
const OLD_MCP_SERVER = 'dbt-studio';

// Leaf config keys (sub-paths under the namespace), derived from package.json.
const CONFIG_KEYS = [
	'database.preferNativeAdapter',
	'layers',
	'lineage.showTests',
	'logLevel',
	'mcp.registration',
	'ninja.autoFix.applyOnFixAll',
	'ninja.autoFix.applyOnFormat',
	'ninja.autoFix.rules',
	'ninja.capitalisation.functions',
	'ninja.capitalisation.identifiers.acronyms',
	'ninja.capitalisation.identifiers.style',
	'ninja.capitalisation.identifiers.words',
	'ninja.capitalisation.keywords',
	'ninja.capitalisation.literals',
	'ninja.capitalisation.types',
	'ninja.convention.explicitAs',
	'ninja.convention.explicitInnerJoin',
	'ninja.convention.notEqual',
	'ninja.convention.unionStyle',
	'ninja.diagnostics.enabled',
	'ninja.disabledRules',
	'ninja.enabled',
	'ninja.format.preset',
	'ninja.indentation.indentedCtes',
	'ninja.indentation.indentedJoins',
	'ninja.indentation.indentedOn',
	'ninja.indentation.indentedThen',
	'ninja.indentation.size',
	'ninja.indentation.unit',
	'ninja.layout.alwaysWrap.case',
	'ninja.layout.alwaysWrap.groupBy',
	'ninja.layout.alwaysWrap.having',
	'ninja.layout.alwaysWrap.orderBy',
	'ninja.layout.alwaysWrap.select',
	'ninja.layout.alwaysWrap.where',
	'ninja.layout.alwaysWrap.windowOrderBy',
	'ninja.layout.alwaysWrap.windowPartitionBy',
	'ninja.layout.commaPosition',
	'ninja.layout.operatorPosition',
	'ninja.maxBlankLines',
	'ninja.maxLineLength',
	'ninja.rules',
	'ninja.structure.allowStarInCte',
	'ninja.workspaceDiagnostics',
	'notifications.suppressAutoSaveWarning',
	'notifications.suppressFormatterWarning',
	'notifications.suppressSqlFluffWarning',
	'profilesDir',
	'providers.codeLens',
	'providers.documentSymbols',
	'providers.sql.codeActions',
	'providers.sql.completion',
	'providers.sql.definition',
	'providers.sql.diagnostics',
	'providers.sql.hover',
	'providers.sql.references',
	'providers.sql.rename',
	'providers.sql.signatureHelp',
	'providers.workspaceSymbols',
	'providers.yaml.completion',
	'providers.yaml.hover',
	'queryEditor.defaultLimit',
	'queryEditor.resultLocation',
	'queryEditor.stopOnError',
	'terminal.contributeCliShim',
	'terminal.externalCommandMonitor.enabled',
];

export async function migrateLegacySettings(
	context: vscode.ExtensionContext,
	logger: ILogger,
): Promise<void> {
	if (context.globalState.get<boolean>(MIGRATION_FLAG)) { return; }
	try {
		await migrateConfigKeys(logger);
		await migrateFormatterId(logger);
		await cleanupLegacyMcp(logger);
	} catch (err) {
		logger.warn(`dbt-studio→dbt-anvil migration failed: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		await context.globalState.update(MIGRATION_FLAG, true);
	}
}

/**
 * Warn if the previous "dbt Studio" extension is still installed AND enabled.
 * The two extensions collide on globally-named resources (language-model tool
 * names, the kept `dbt-sql` debugger type + data-pipeline view), so running
 * both produces "already registered" / "duplicate view id" errors and leaves
 * dbt Anvil's tools half-broken. Offer a one-click uninstall. Runs every
 * activation while the conflict exists; goes away once the old one is removed.
 * `getExtension` returns undefined for a disabled extension, so a user who
 * merely disabled (not uninstalled) the old one is not nagged.
 */
export function warnIfLegacyExtensionInstalled(logger: ILogger): void {
	if (!vscode.extensions.getExtension(OLD_ID)) { return; }
	logger.warn(`Legacy extension ${OLD_ID} is still enabled — it conflicts with dbt Anvil.`);
	void vscode.window.showWarningMessage(
		'"dbt Studio" has been renamed to dbt Anvil, and the old extension is still installed. ' +
		'Running both conflicts (duplicate tools and views) — please uninstall dbt Studio.',
		'Uninstall dbt Studio',
		'Dismiss',
	).then(async (choice) => {
		if (choice !== 'Uninstall dbt Studio') { return; }
		try {
			await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_ID);
			const reload = await vscode.window.showInformationMessage(
				'dbt Studio uninstalled. Reload the window to clear the conflict.',
				'Reload Window',
			);
			if (reload === 'Reload Window') {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		} catch (err) {
			logger.warn(`Could not uninstall ${OLD_ID}: ${err instanceof Error ? err.message : String(err)}`);
			void vscode.commands.executeCommand('extension.open', OLD_ID);
		}
	});
}

async function migrateConfigKeys(logger: ILogger): Promise<void> {
	const cfg = vscode.workspace.getConfiguration();
	let migrated = 0;

	const copy = async (
		from: string | undefined,
		exists: boolean,
		newKey: string,
		target: vscode.ConfigurationTarget,
		overrideInLanguage?: boolean,
	) => {
		if (from === undefined || exists) { return; }
		await cfg.update(newKey, from, target, overrideInLanguage);
		migrated++;
	};

	for (const sub of CONFIG_KEYS) {
		const oldKey = `dbt-studio.${sub}`;
		const newKey = `dbt-anvil.${sub}`;
		const oldInfo = cfg.inspect(oldKey);
		const newInfo = cfg.inspect(newKey);
		if (!oldInfo) { continue; }
		await copy(oldInfo.globalValue as string | undefined, newInfo?.globalValue !== undefined, newKey, vscode.ConfigurationTarget.Global);
		await copy(oldInfo.workspaceValue as string | undefined, newInfo?.workspaceValue !== undefined, newKey, vscode.ConfigurationTarget.Workspace);
		await copy(oldInfo.workspaceFolderValue as string | undefined, newInfo?.workspaceFolderValue !== undefined, newKey, vscode.ConfigurationTarget.WorkspaceFolder);
	}

	// The Ninja house-style preset value was also renamed (`dbt-studio` → `dbt-anvil`).
	const presetKey = 'dbt-anvil.ninja.format.preset';
	const presetInfo = cfg.inspect<string>(presetKey);
	if (presetInfo?.globalValue === 'dbt-studio') {
		await cfg.update(presetKey, 'dbt-anvil', vscode.ConfigurationTarget.Global);
	}
	if (presetInfo?.workspaceValue === 'dbt-studio') {
		await cfg.update(presetKey, 'dbt-anvil', vscode.ConfigurationTarget.Workspace);
	}

	if (migrated > 0) {
		logger.info(`Migrated ${migrated} legacy dbt-studio.* setting(s) to dbt-anvil.*`);
	}
}

async function migrateFormatterId(logger: ILogger): Promise<void> {
	let changed = false;

	// Language-scoped (how the extension sets it for jinja-sql).
	const langCfg = vscode.workspace.getConfiguration('editor', { languageId: 'jinja-sql' });
	const li = langCfg.inspect<string>('defaultFormatter');
	if (li?.globalValue === OLD_ID) {
		await langCfg.update('defaultFormatter', NEW_ID, vscode.ConfigurationTarget.Global, true);
		changed = true;
	}
	if (li?.workspaceValue === OLD_ID) {
		await langCfg.update('defaultFormatter', NEW_ID, vscode.ConfigurationTarget.Workspace, true);
		changed = true;
	}

	// Global (non-language) default formatter, just in case.
	const cfg = vscode.workspace.getConfiguration('editor');
	const gi = cfg.inspect<string>('defaultFormatter');
	if (gi?.globalValue === OLD_ID) {
		await cfg.update('defaultFormatter', NEW_ID, vscode.ConfigurationTarget.Global);
		changed = true;
	}
	if (gi?.workspaceValue === OLD_ID) {
		await cfg.update('defaultFormatter', NEW_ID, vscode.ConfigurationTarget.Workspace);
		changed = true;
	}

	if (changed) { logger.info('Repointed default SQL formatter to dbt-anvil'); }
}

async function cleanupLegacyMcp(logger: ILogger): Promise<void> {
	// Remove the old discovery directory (~/.dbt-studio).
	try {
		await fs.promises.rm(path.join(os.homedir(), '.dbt-studio'), { recursive: true, force: true });
	} catch { /* best effort */ }

	// Remove stale `dbt-studio` server entries from ~/.claude.json (all projects).
	const claude = path.join(os.homedir(), '.claude.json');
	try {
		const cfg = JSON.parse(await fs.promises.readFile(claude, 'utf8')) as {
			projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
		};
		let changed = false;
		for (const project of Object.values(cfg.projects ?? {})) {
			if (project?.mcpServers?.[OLD_MCP_SERVER]) {
				delete project.mcpServers[OLD_MCP_SERVER];
				changed = true;
			}
		}
		if (changed) {
			await writeJsonAtomic(claude, cfg);
			logger.info('Removed legacy dbt-studio MCP entries from ~/.claude.json');
		}
	} catch { /* no file / unparseable — ignore */ }

	// Remove the stale server from any workspace `.mcp.json`.
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const mcpJson = path.join(folder.uri.fsPath, '.mcp.json');
		try {
			const cfg = JSON.parse(await fs.promises.readFile(mcpJson, 'utf8')) as {
				mcpServers?: Record<string, unknown>;
			};
			if (cfg?.mcpServers?.[OLD_MCP_SERVER]) {
				delete cfg.mcpServers[OLD_MCP_SERVER];
				await writeJsonAtomic(mcpJson, cfg);
				logger.info('Removed legacy dbt-studio server from workspace .mcp.json');
			}
		} catch { /* no file / unparseable — ignore */ }
	}
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
	const tmp = `${target}.${process.pid}.tmp`;
	await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
	await fs.promises.rename(tmp, target);
}
