/**
 * Stdio ↔ HTTP proxy. Spawned by Claude Code as the MCP server binary.
 *
 * Role: turn JSON-RPC messages arriving on stdin into HTTP POSTs against the
 * extension host's in-process MCP server, and write the responses back to
 * stdout. Zero knowledge of tools, schemas, or dbt — just a pipe with
 * auth, retry, and line framing.
 *
 * Lazy connection: `initialize` is answered immediately so Claude Code shows
 * "Connected" right away. All other requests wait (up to 60 s) for the
 * extension host to activate and write the discovery file. This means the
 * proxy can be spawned before VS Code has finished activating the dbt Studio
 * extension and the handshake still succeeds.
 */
import * as http from 'node:http';
import { readDiscoveryFile } from '../shared/discovery';
import { JSONRPC_VERSION, MCP_PROTOCOL_VERSION, JsonRpcErrorCode, type DiscoveryFile } from '../shared/protocol';

const CONNECT_RETRY_MS = 1000;
const CONNECT_MAX_ATTEMPTS = 60; // ~60 s before giving up

interface ProxyArgs { workspace: string }

function parseArgs(argv: string[]): ProxyArgs {
	let workspace: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--workspace' && i + 1 < argv.length) {
			workspace = argv[i + 1];
		}
	}
	if (!workspace) {
		process.stderr.write('dbt-studio mcp-proxy: --workspace <path> is required\n');
		process.exit(2);
	}
	return { workspace };
}

async function waitForDiscovery(workspacePath: string): Promise<DiscoveryFile> {
	for (let attempt = 0; attempt < CONNECT_MAX_ATTEMPTS; attempt++) {
		const file = await readDiscoveryFile(workspacePath);
		if (file) { return file; }
		await sleep(CONNECT_RETRY_MS);
	}
	throw new Error(
		`dbt Studio extension not responding — is the workspace open and the extension activated?`,
	);
}

function postJson(port: number, token: string, body: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: '127.0.0.1',
			port,
			path: '/mcp',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
				Authorization: `Bearer ${token}`,
			},
		}, res => {
			const chunks: Buffer[] = [];
			res.on('data', c => chunks.push(c as Buffer));
			res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			res.on('error', reject);
		});
		req.on('error', reject);
		signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
		req.write(body);
		req.end();
	});
}

function* frames(chunk: string, tail: { buf: string }): Generator<string> {
	tail.buf += chunk;
	let idx: number;
	while ((idx = tail.buf.indexOf('\n')) >= 0) {
		const line = tail.buf.slice(0, idx).trim();
		tail.buf = tail.buf.slice(idx + 1);
		if (line.length > 0) { yield line; }
	}
}

function extractId(line: string): string | number | null {
	try {
		return (JSON.parse(line) as { id?: string | number | null }).id ?? null;
	} catch {
		return null;
	}
}

function isInitialize(line: string): boolean {
	try {
		return (JSON.parse(line) as { method?: string }).method === 'initialize';
	} catch {
		return false;
	}
}

function makeInitializeResponse(id: string | number | null): string {
	return JSON.stringify({
		jsonrpc: JSONRPC_VERSION,
		id,
		result: {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: 'dbt-studio', version: '0.0.0' },
		},
	});
}

async function main(): Promise<void> {
	const { workspace } = parseArgs(process.argv.slice(2));

	// Start discovery in the background immediately — don't block stdin.
	const discoveryPromise = waitForDiscovery(workspace);

	process.stdin.setEncoding('utf8');
	const tail = { buf: '' };
	const stopSignal = new AbortController();
	process.on('SIGTERM', () => stopSignal.abort());
	process.on('SIGINT', () => stopSignal.abort());

	process.stdin.on('data', (chunk: string) => {
		for (const line of frames(chunk, tail)) {
			void forward(line);
		}
	});
	process.stdin.on('end', () => process.exit(0));

	async function forward(line: string): Promise<void> {
		// Respond to `initialize` immediately without waiting for the host.
		// This lets Claude Code complete the MCP handshake (and show "Connected")
		// even while the extension is still starting up.
		if (isInitialize(line)) {
			process.stdout.write(`${makeInitializeResponse(extractId(line))}\n`);
			return;
		}

		// All other requests wait for the host to be ready.
		let discovery: DiscoveryFile;
		try {
			discovery = await discoveryPromise;
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			process.stdout.write(`${JSON.stringify({
				jsonrpc: JSONRPC_VERSION,
				id: extractId(line),
				error: { code: JsonRpcErrorCode.InternalError, message: errMsg },
			})}\n`);
			return;
		}

		try {
			const response = await postJson(discovery.port, discovery.token, line, stopSignal.signal);
			if (response.length > 0) {
				process.stdout.write(`${response}\n`);
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			process.stdout.write(`${JSON.stringify({
				jsonrpc: JSONRPC_VERSION,
				id: extractId(line),
				error: { code: JsonRpcErrorCode.InternalError, message: `proxy: ${errMsg}` },
			})}\n`);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
	process.stderr.write(`mcp-proxy fatal: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
