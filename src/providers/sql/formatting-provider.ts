// Intentionally not implemented.
//
// Formatting for jinja-sql files is fully delegated to the SQLFluff extension
// (https://marketplace.visualstudio.com/items?itemName=dorzey.vscode-sqlfluff).
// SQLFluff provides DocumentFormattingProvider and fix-on-save via its own
// rules engine and dialect-aware parser, which is a better fit than anything
// we could build here.
//
// If SQLFluff is not available, users can set `editor.defaultFormatter` to
// another SQL formatter extension of their choice.
//
// If dbt Studio ever needs to override or supplement formatting (e.g. for
// Jinja-specific syntax), implement DbtFormattingProvider here and register
// it in extension.ts with:
//
//   vscode.languages.registerDocumentFormattingEditProvider(sqlSelector, formattingProvider)
