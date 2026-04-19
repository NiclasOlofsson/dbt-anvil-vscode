// Fake worker used by pyodide-worker-pool.test.ts.
//
// Behaviour driven by `workerData` so individual tests can shape the worker's
// responses without spawning a real Pyodide instance:
//
//   readyDelayMs       - delay before posting { ready: true }       (default 0)
//   workMs             - per-task processing delay                  (default 0)
//   stall              - if true, never reply to messages           (default false)
//   duplicateReplies   - if true, post each reply twice (stale msg) (default false)
//   neverReady         - if true, never post ready                  (default false)
//   exitImmediately    - if true, exit before posting ready         (default false)

import { parentPort, workerData } from 'node:worker_threads';

const opts = workerData ?? {};

if (opts.exitImmediately) {
	process.exit(1);
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

if (!opts.neverReady) {
	setTimeout(() => parentPort.postMessage({ ready: true }), opts.readyDelayMs ?? 0);
}

parentPort.on('message', async (msg) => {
	try {
		if (opts.stall) return;
		if (opts.workMs) await sleep(opts.workMs);

		const reply = buildReply(msg);
		parentPort.postMessage(reply);
		if (opts.duplicateReplies) {
			parentPort.postMessage(reply);
		}
	} catch {
		// Worker may be terminated mid-flight — postMessage on a closed port throws.
		// Swallow so the runtime doesn't surface it as a worker 'error' event.
	}
});

function buildReply(msg) {
	const id = msg.id;
	switch (msg.type) {
		case 'lineage':
		case 'lineage_v2':
			return { id, lineageResult: JSON.stringify({ success: true, sql: msg.sql ?? msg.compiledSql }) };
		case 'decompose':
			return { id, decomposeResult: JSON.stringify({ ctes: [] }) };
		case 'symbols':
			return {
				id,
				symbolsResult: JSON.stringify({ functions: ['foo'], keywordTokenTypes: ['SELECT'], types: ['INT'] }),
			};
		default:
			// parse
			return {
				id,
				result: {
					ast: [],
					scopes: [],
					warnings: [],
					sqlTokens: [],
					dialect: msg.dialect,
					timing: { parseMs: 0, totalMs: 0 },
				},
			};
	}
}
