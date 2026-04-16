/**
 * Worker thread entry point. Each worker loads its own Pyodide instance and
 * processes parse and lineage tasks serially.  Communication with the pool is via
 * message passing (structured clone).
 *
 * workerData: { pyodideDir: string; vendorDir: string }
 *
 * Inbound messages (parse):   { id: number; sql: string; dialect: string; schemaJson: string }
 * Inbound messages (lineage): { id: number; type: 'lineage'; compiledSql: string; columnName: string; dialect: string; schemaJson: string }
 * Outbound messages: { id: number; result: ParseResult }
 *               or: { id: number; lineageResult: string }
 *               or: { id: number; error: string }
 * Startup message:   { ready: true }
 */
import { workerData, parentPort } from 'node:worker_threads';
import { initPyodide } from './pyodide-loader';
import { PyodideSqlParser } from './pyodide-sql-parser';
import type { ParseResult } from './parse-result';

interface WorkerData {
	pyodideDir: string;
	vendorDir: string;
	scriptsDir: string;
}

interface ParseTask {
	id: number;
	sql: string;
	dialect: string;
	schemaJson: string;
}

interface LineageTask {
	id: number;
	type: 'lineage';
	compiledSql: string;
	columnName: string;
	dialect: string;
	schemaJson: string;
}

interface LineageV2Task {
	id: number;
	type: 'lineage_v2';
	sql: string;
	columnName: string;
	dialect: string;
	schemaJson: string;
}

interface DecomposeTask {
	id: number;
	type: 'decompose';
	compiledSql: string;
	dialect: string;
}

interface SymbolsTask {
	id: number;
	type: 'symbols';
	dialect: string;
}

type Task = ParseTask | LineageTask | LineageV2Task | DecomposeTask | SymbolsTask;

const { pyodideDir, vendorDir, scriptsDir } = workerData as WorkerData;

async function main(): Promise<void> {
	const { pyodide } = await initPyodide(pyodideDir, vendorDir, scriptsDir);
	const parser = PyodideSqlParser.create(pyodide);

	parentPort!.postMessage({ ready: true });

	parentPort!.on('message', async (task: Task) => {
		if ('type' in task && task.type === 'lineage') {
			try {
				const raw = parser.traceLineage(task.compiledSql, task.columnName, task.dialect, task.schemaJson);
				parentPort!.postMessage({ id: task.id, lineageResult: raw });
			} catch (err) {
				parentPort!.postMessage({ id: task.id, error: String(err) });
			}
		} else if ('type' in task && task.type === 'lineage_v2') {
			try {
				const raw = parser.traceLineageV2(task.sql, task.columnName, task.dialect, task.schemaJson);
				parentPort!.postMessage({ id: task.id, lineageResult: raw });
			} catch (err) {
				parentPort!.postMessage({ id: task.id, error: String(err) });
			}
		} else if ('type' in task && task.type === 'decompose') {
			try {
				const raw = parser.decomposeQuery(task.compiledSql, task.dialect);
				parentPort!.postMessage({ id: task.id, decomposeResult: raw });
			} catch (err) {
				parentPort!.postMessage({ id: task.id, error: String(err) });
			}
		} else if ('type' in task && task.type === 'symbols') {
			try {
				const symbols = await parser.getDialectSymbols(task.dialect);
				parentPort!.postMessage({ id: task.id, symbolsResult: JSON.stringify({
					functions: [...symbols.functions],
					keywordTokenTypes: [...symbols.keywordTokenTypes],
					types: [...symbols.types],
				}) });
			} catch (err) {
				parentPort!.postMessage({ id: task.id, error: String(err) });
			}
		} else {
			const parseTask = task as ParseTask;
			try {
				const schema = parseTask.schemaJson ? JSON.parse(parseTask.schemaJson) as Record<string, Record<string, string>> : undefined;
				const result: ParseResult = await parser.parse(parseTask.sql, parseTask.dialect, schema);
				parentPort!.postMessage({ id: parseTask.id, result });
			} catch (err) {
				parentPort!.postMessage({ id: parseTask.id, error: String(err) });
			}
		}
	});
}

void main();
