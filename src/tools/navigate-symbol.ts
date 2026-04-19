import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { resolvePathToUri, toolResult } from './tool-helpers';

type NavigationKind = 'definition' | 'references' | 'implementations' | 'type_definition' | 'declaration';

interface NavigateSymbolInput {
	path: string;
	line: number;
	character: number;
	kind: NavigationKind;
	max_results?: number;
}

const COMMAND_BY_KIND: Record<NavigationKind, string> = {
	definition: 'vscode.executeDefinitionProvider',
	references: 'vscode.executeReferenceProvider',
	implementations: 'vscode.executeImplementationProvider',
	type_definition: 'vscode.executeTypeDefinitionProvider',
	declaration: 'vscode.executeDeclarationProvider',
};

export class NavigateSymbolTool implements vscode.LanguageModelTool<NavigateSymbolInput> {
	constructor(private readonly logger: ILogger) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<NavigateSymbolInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { path, line, character, kind, max_results = 200 } = options.input;
		this.logger.info(`LM Tool: navigateSymbol kind=${kind} ${path}:${line}:${character}`);

		const command = COMMAND_BY_KIND[kind];
		if (!command) {
			return toolResult({ error: `Unknown kind: ${kind}. Expected: ${Object.keys(COMMAND_BY_KIND).join(', ')}` });
		}

		const uri = resolvePathToUri(path);
		const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, character - 1));

		const raw = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
			command, uri, position,
		) ?? [];

		const locations = raw.slice(0, max_results).map(locationToJson);

		return toolResult({
			kind,
			count: locations.length,
			total: raw.length,
			...(raw.length > locations.length ? { truncated: true } : {}),
			locations,
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<NavigateSymbolInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const { path, line, character, kind } = options.input;
		return { invocationMessage: `Finding ${kind.replace('_', ' ')} at ${path}:${line}:${character}...` };
	}
}

function locationToJson(loc: vscode.Location | vscode.LocationLink): Record<string, unknown> {
	const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
	const range = 'targetRange' in loc ? loc.targetRange : loc.range;
	return {
		file: vscode.workspace.asRelativePath(uri, false),
		line: range.start.line + 1,
		column: range.start.character + 1,
		end_line: range.end.line + 1,
		end_column: range.end.character + 1,
	};
}
