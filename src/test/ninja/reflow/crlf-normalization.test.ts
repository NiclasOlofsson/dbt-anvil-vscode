/**
 * Regression test: CRLF leakage from comment token source text must not
 * survive to the printer's output. The printer emits its own breaks as LF;
 * a single CRLF leaking through (e.g. a Windows-checked-out file whose
 * comments retain CRLF endings) flips the trailing-newline rule's EOL
 * detection heuristic and causes spurious violations on clean LF files.
 *
 * The fix lives in `printer.ts`: after trailing-whitespace cleanup and
 * before the final-newline guard, any `\r\n` in the buffer is replaced
 * with `\n`.
 */
import * as path from 'path';
import { describe, expect, it, beforeAll } from 'vitest';

import { initPyodide } from '../../../ftl/pyodide-loader';
import { PyodideSqlParser } from '../../../ftl/pyodide-sql-parser';
import { FtlDocumentParser } from '../../../ftl/ftl-document-parser';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { DEFAULT_CONFIG } from '../../../ninja/config';
import { mockDocument } from '../helpers';

const PYODIDE_DIR = path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR  = path.join(__dirname, '..', '..', '..', '..', 'resources', 'ftl', 'vendor');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', '..', 'resources', 'ftl');

let documentParser: FtlDocumentParser;

beforeAll(async () => {
	const runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
	documentParser = new FtlDocumentParser(PyodideSqlParser.create(runtime.pyodide), { adapterType: 'duckdb' });
}, 60_000);

describe('CRLF normalization', () => {
	it('strips leaked CRLF from comments so output is pure LF', async () => {
		// Source has CRLF endings — this is what a Windows-checked-out file
		// looks like when comments preserve their original line endings
		// through the printer.
		const sql = '-- a crlf comment\r\nselect 1\r\nfrom t\r\n';
		const symbols = await documentParser.getDialectSymbols();
		const model = await documentParser.parse(sql);
		const doc = mockDocument(sql);
		const reflow = reflowDocument(doc, model, DEFAULT_CONFIG, symbols);
		expect(reflow.edit).not.toBeNull();
		const out = reflow.edit!.newText;
		// No CRLF should appear anywhere in the output.
		expect(out.includes('\r\n'), `Output still contains CRLF: ${JSON.stringify(out)}`).toBe(false);
		expect(out.includes('\r'), `Output still contains bare CR: ${JSON.stringify(out)}`).toBe(false);
		// Output ends with exactly one LF.
		expect(out.endsWith('\n')).toBe(true);
	});
});
