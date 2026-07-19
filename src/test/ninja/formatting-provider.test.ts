import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { NinjaFormattingProvider } from '../../providers/sql/formatting-provider';
import { SqllensDocumentParser } from '../../ftl/sqllens/document-parser';
import { LogLevel, type ILogger } from '../../types/logger';
import { mockDocument } from './helpers';

const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

const noopLogger: ILogger = {
	trace() {}, debug() {}, info() {}, warn() {}, error() {},
	setLogLevel() {}, getLogLevel: () => LogLevel.INFO,
};

/** The provider only reads getDocumentModel/getDialectSymbols off ParseService. */
const parseServiceShim = {
	getDocumentModel: (doc: vscode.TextDocument) => parser.parse(doc.getText()),
	getDialectSymbols: () => parser.getDialectSymbols(),
};

/** Point loadConfig() at a controllable settings map (mock lacks inspect()). */
function stubConfig(values: Record<string, unknown>): void {
	vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => ({
		get: (key: string, dflt?: unknown) => (key in values ? values[key] : dflt),
		inspect: () => undefined,
		has: () => true,
		update: async () => {},
	}) as never);
}

async function formatEdits(sql: string): Promise<vscode.TextEdit[]> {
	const provider = new NinjaFormattingProvider(parseServiceShim as never, noopLogger);
	return provider.provideDocumentFormattingEdits(
		mockDocument(sql),
		{ tabSize: 4, insertSpaces: false } as vscode.FormattingOptions,
		{ isCancellationRequested: false } as vscode.CancellationToken,
	);
}

const UGLY_SQL = 'select a,b,c from t where a=1 and b=2 and c=3 and d=4 and e=5 and f=6 and g=7\n';

describe('NinjaFormattingProvider', () => {
	beforeEach(() => {
		vi.mocked(vscode.workspace.getConfiguration).mockReset();
	});

	it('formats the document through the reflow engine', async () => {
		stubConfig({});
		const edits = await formatEdits(UGLY_SQL);
		expect(edits.length).toBeGreaterThan(0);
	});

	// Format Document is an explicit user gesture and is reflow-only; the
	// retired autoFix.applyOnFormat setting must not silently kill it for
	// users who still carry the key in settings.json.
	it('ignores a leftover autoFix.applyOnFormat=false', async () => {
		stubConfig({ 'autoFix.applyOnFormat': false });
		const edits = await formatEdits(UGLY_SQL);
		expect(edits.length).toBeGreaterThan(0);
	});

	it('returns no edits when ninja.enabled is false', async () => {
		stubConfig({ enabled: false });
		const edits = await formatEdits(UGLY_SQL);
		expect(edits).toEqual([]);
	});
});
