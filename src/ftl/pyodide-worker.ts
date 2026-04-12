/**
 * Worker thread entry point. Each worker loads its own Pyodide instance and
 * processes parse tasks serially.  Communication with the pool is via
 * message passing (structured clone).
 *
 * workerData: { pyodideDir: string; vendorDir: string }
 *
 * Inbound messages:  { id: number; sql: string; dialect: string; schemaJson: string }
 * Outbound messages: { id: number; result: ParseResult }
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
}

interface ParseTask {
    id: number;
    sql: string;
    dialect: string;
    schemaJson: string;
}

const { pyodideDir, vendorDir } = workerData as WorkerData;

async function main(): Promise<void> {
    const { pyodide } = await initPyodide(pyodideDir, vendorDir);
    const parser = PyodideSqlParser.create(pyodide);

    parentPort!.postMessage({ ready: true });

    parentPort!.on('message', async (task: ParseTask) => {
        try {
            const schema = task.schemaJson ? JSON.parse(task.schemaJson) as Record<string, Record<string, string>> : undefined;
            const result: ParseResult = await parser.parse(task.sql, task.dialect, schema);
            parentPort!.postMessage({ id: task.id, result });
        } catch (err) {
            parentPort!.postMessage({ id: task.id, error: String(err) });
        }
    });
}

void main();
