import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ILogger } from '../../types/logger';
import { findEnclosingMacroCall } from './jinja-cursor';

const NON_MACRO_GLOBALS = new Set([
	'ref', 'source', 'config', 'var', 'env_var', 'log', 'return',
	'adapter', 'exceptions', 'modules', 'flags', 'this', 'graph',
	'invocation_id', 'run_started_at', 'target', 'is_incremental',
]);

/**
 * Signature help for dbt macros: shows parameter hints when typing
 * `{{ my_macro(` or after commas in macro calls. Multi-line aware — the
 * `{{` may sit several lines above the cursor.
 */
export class DbtSignatureHelpProvider implements vscode.SignatureHelpProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) { }

	provideSignatureHelp(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		_context: vscode.SignatureHelpContext,
	): vscode.SignatureHelp | undefined {
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.signatureHelp', true)) return undefined;

		const call = findEnclosingMacroCall(document.getText(), document.offsetAt(position));
		if (!call) return undefined;
		if (NON_MACRO_GLOBALS.has(call.name)) return undefined;

		const macro = this.indexer.findMacroByName(call.name);
		if (!macro || macro.arguments.length === 0) return undefined;

		this.logger.debug(`SignatureHelp: ${call.name}(${macro.arguments.map(a => a.name).join(', ')})`);

		const sig = new vscode.SignatureInformation(
			`${call.name}(${macro.arguments.map(a => a.name).join(', ')})`,
			macro.description,
		);
		for (const arg of macro.arguments) {
			sig.parameters.push(new vscode.ParameterInformation(arg.name, arg.description));
		}

		const help = new vscode.SignatureHelp();
		help.signatures = [sig];
		help.activeSignature = 0;
		help.activeParameter = call.activeArg;
		return help;
	}
}
