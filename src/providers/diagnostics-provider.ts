// SQL linting diagnostics (style/syntax) are delegated to SQLFluff.
// This provider surfaces dbt-specific semantic errors: unknown refs, parse
// failures, and compilation errors detected by `dbt parse`.

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DbtExecutionService } from '../dbt/execution-service';
import type { StatusBarManager } from '../views/status-bar';
import type { ILogger } from '../types/logger';

interface DbtErrorLocation {
	filePath: string;
	line: number;
	message: string;
}

export class DbtDiagnosticsProvider implements vscode.Disposable {
	private readonly _collection: vscode.DiagnosticCollection;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		service: DbtExecutionService,
		private readonly statusBar: StatusBarManager,
		private readonly projectDir: string,
		private readonly logger: ILogger,
	) {
		this._collection = vscode.languages.createDiagnosticCollection('dbt-studio');

		this._disposables.push(
			service.onJobCompleted(({ job, result }) => {
				if (job.type === 'parse') {
					if (result.success) {
						this._collection.clear();
						this.statusBar.setErrorCount(0);
						this.logger.debug('Parse succeeded — diagnostics cleared');
					} else {
						this._handleParseFailure(result.stderr);
					}
				}
			}),
			service.onJobFailed(({ job, error }) => {
				if (job.type === 'parse') {
					this._handleParseFailure(error.message);
				}
			}),
		);
	}

	private _handleParseFailure(output: string): void {
		this._collection.clear();
		const errors = this._parseErrors(output);

		const byFile = new Map<string, vscode.Diagnostic[]>();
		for (const err of errors) {
			const filePath = path.isAbsolute(err.filePath)
				? err.filePath
				: path.join(this.projectDir, err.filePath);
			const uri = vscode.Uri.file(filePath);
			const key = uri.toString();
			if (!byFile.has(key)) byFile.set(key, []);
			const range = new vscode.Range(
				new vscode.Position(Math.max(0, err.line - 1), 0),
				new vscode.Position(Math.max(0, err.line - 1), Number.MAX_SAFE_INTEGER),
			);
			const diagnostic = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
			diagnostic.source = 'dbt';
			byFile.get(key)!.push(diagnostic);
		}

		for (const [uriStr, diags] of byFile) {
			this._collection.set(vscode.Uri.parse(uriStr), diags);
		}

		this.statusBar.setErrorCount(errors.length);
		this.logger.info(`Parse failed — ${errors.length} diagnostic(s) created`);
	}

	private _parseErrors(output: string): DbtErrorLocation[] {
		const errors: DbtErrorLocation[] = [];

		// dbt error patterns:
		// "Compilation Error in model X (models/path/file.sql)"
		// "YAML Parsing Error in file path/to/file.yml"
		// "Syntax Error in model X (models/path/file.sql)"
		const errorPattern = /(?:Compilation|Database|Parsing|Syntax|Runtime) Error.*?\(([^)]+\.(?:sql|yml|yaml))\)/g;
		let match;
		while ((match = errorPattern.exec(output)) !== null) {
			const filePath = match[1];
			const surroundingText = output.substring(match.index, match.index + 500);
			const lineMatch = /line (\d+)/i.exec(surroundingText);
			const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;

			const afterHeader = output.substring(match.index);
			const msgLines = afterHeader.split('\n').slice(1).map(l => l.trim()).filter(l => l);
			const message = msgLines[0] || match[0];

			errors.push({ filePath, line, message });
		}

		return errors;
	}

	clearAll(): void {
		this._collection.clear();
		this.statusBar.setErrorCount(0);
	}

	dispose(): void {
		for (const d of this._disposables) d.dispose();
		this._collection.dispose();
	}
}
