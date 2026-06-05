import * as vscode from 'vscode';

/**
 * Central icon/symbol registry for dbt Anvil.
 *
 * Two layers:
 *   DbtIcons   — dbt-level objects: models, sources, macros, seeds, snapshots
 *   SqlIcons   — SQL/Jinja-level constructs: CTEs, columns, aliases, args
 *
 * All Codicon names, CompletionItemKinds, and SymbolKinds are defined here.
 * Never hard-code $(icon) strings or Kind enums in provider files — import from here.
 */

// ─── Layer 1: dbt objects ────────────────────────────────────────────────────

/** Codicon names for dbt model materialisations, used in ThemeIcon and hover markdown. */
export const DbtMaterializationIcons: Record<string, string> = {
	table:       'symbol-class',
	view:        'symbol-interface',
	incremental: 'layers-dot',
	ephemeral:   'symbol-misc',
	seed:        'list-flat',
	snapshot:    'history',
	default:     'file-code',
};

/** Singleton ThemeIcon instances for model materialisations (for TreeItem iconPath). */
export function materializationIcon(mat: string): vscode.ThemeIcon {
	const name = DbtMaterializationIcons[mat] ?? DbtMaterializationIcons.default;
	return new vscode.ThemeIcon(name);
}

/** SymbolKind for workspace/document symbols per dbt resource type. */
export const DbtSymbolKind = {
	model:   vscode.SymbolKind.Class,
	source:  vscode.SymbolKind.Module,
	macro:   vscode.SymbolKind.Function,
} as const;

// ─── Layer 2: SQL / Jinja constructs ─────────────────────────────────────────

/** Codicon names for SQL/Jinja constructs, used in hover markdown. */
export const SqlIcons = {
	column:      'symbol-field',
	cte:         'symbol-variable',
	tableAlias:  'symbol-reference',
	macroArg:    'symbol-parameter',
	schema:      'symbol-namespace',
	database:    'database',
	package:     'package',
	file:        'file-code',
	tag:         'tag',
	lineage:     'arrow-right',
	source:      'symbol-module',
	macro:       'symbol-function',
} as const;

/** CompletionItemKind for each SQL/dbt completion context. */
export const DbtCompletionKind = {
	column:      vscode.CompletionItemKind.Field,
	cte:         vscode.CompletionItemKind.Variable,
	modelRef:    vscode.CompletionItemKind.Reference,
	sourceName:  vscode.CompletionItemKind.Module,
	sourceTable: vscode.CompletionItemKind.Class,
	macro:       vscode.CompletionItemKind.Function,
} as const;

/** SymbolKind for document outline symbols per SQL construct. */
export const SqlSymbolKind = {
	cte:       vscode.SymbolKind.Variable,
	column:    vscode.SymbolKind.Field,
	model:     vscode.SymbolKind.Class,
	source:    vscode.SymbolKind.Module,
} as const;
