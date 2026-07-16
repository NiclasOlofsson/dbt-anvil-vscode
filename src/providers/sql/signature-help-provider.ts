import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ILogger } from '../../types/logger';
import type { ParseService } from '../../services/parse-service';
import { findEnclosingMacroCall } from './jinja-cursor';

const NON_MACRO_GLOBALS = new Set([
	'ref', 'source', 'config', 'var', 'env_var', 'log', 'return',
	'adapter', 'exceptions', 'modules', 'flags', 'this', 'graph',
	'invocation_id', 'run_started_at', 'target', 'is_incremental',
]);

/**
 * Signature help for dbt macros AND SQL functions. Macro hints come from the
 * manifest when the caret is inside `{{ my_macro(` (multi-line aware — the `{{`
 * may sit several lines above the cursor). When the caret is inside a plain SQL
 * call instead, sqllens's dialect-aware `signatureAt` supplies the parameter
 * hints (e.g. `date_add(start_date, num_days)`) — no hardcoded function table.
 */
export class DbtSignatureHelpProvider implements vscode.SignatureHelpProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) { }

	provideSignatureHelp(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		_context: vscode.SignatureHelpContext,
	): vscode.SignatureHelp | undefined {
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.signatureHelp', true)) return undefined;

		return this._macroSignature(document, position) ?? this._sqlSignature(document, position);
	}

	/** dbt macro signature from the manifest, or undefined when the caret is not in a macro call. */
	private _macroSignature(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
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

	/** Dialect-aware SQL function signatures from sqllens (every overload), or undefined off any call. */
	private _sqlSignature(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
		const info = this.parseService.signatureAt(document.getText(), document.offsetAt(position));
		if (!info || info.signatures.length === 0) return undefined;

		this.logger.debug(`SignatureHelp: ${info.signatures[info.activeSignature]?.label ?? info.signatures[0].label}`);
		const help = new vscode.SignatureHelp();
		help.signatures = info.signatures.map(s => {
			const sig = new vscode.SignatureInformation(s.label);
			for (const p of s.parameters) sig.parameters.push(new vscode.ParameterInformation(p.label));
			return sig;
		});
		help.activeSignature = info.activeSignature;
		help.activeParameter = info.activeParameter;
		return help;
	}
}
