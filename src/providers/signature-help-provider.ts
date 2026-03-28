import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Signature help for dbt macros: shows parameter hints when typing
 * {{ my_macro( or after commas in macro calls.
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
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.signatureHelp', true)) return undefined;
		const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

		// Match {{ macro_name( ... with cursor after ( or after a comma
		// Walk backwards to find the macro name before the opening (
		const callMatch = /\{\{[^}]*?(\w+)\s*\(([^)]*)$/.exec(linePrefix);
		if (!callMatch) return undefined;

		const macroName = callMatch[1];
		const argsTyped = callMatch[2];

		// Skip built-in Jinja/dbt functions
		if (/^(ref|source|config|var|env_var|log|return|adapter|exceptions|modules|flags|this|graph|invocation_id|run_started_at|target|is_incremental)$/i.test(macroName)) {
			return undefined;
		}

		const macro = this.indexer.findMacroByName(macroName);

		if (!macro || macro.arguments.length === 0) return undefined;

		this.logger.debug(`SignatureHelp: ${macroName}(${macro.arguments.map(a => a.name).join(', ')})`);

		const sig = new vscode.SignatureInformation(
			`${macroName}(${macro.arguments.map(a => a.name).join(', ')})`,
			macro.description,
		);

		for (const arg of macro.arguments) {
			sig.parameters.push(new vscode.ParameterInformation(
				arg.name,
				arg.description,
			));
		}

		const help = new vscode.SignatureHelp();
		help.signatures = [sig];
		help.activeSignature = 0;
		// Count commas to determine active parameter
		help.activeParameter = (argsTyped.match(/,/g) ?? []).length;

		return help;
	}
}
