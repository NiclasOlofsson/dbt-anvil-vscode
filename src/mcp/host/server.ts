import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ILogger } from '../../types/logger';
import {
	JSONRPC_VERSION,
	JsonRpcErrorCode,
	MCP_PROTOCOL_VERSION,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from '../shared/protocol';
import type { McpToolRegistry } from './registry';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — generous for large tool results

export interface McpServerInfo {
	port: number;
	token: string;
}

/**
 * In-process HTTP server that speaks MCP (JSON-RPC 2.0) on /mcp.
 *
 * Bound to 127.0.0.1 only. Requests must carry `Authorization: Bearer <token>`
 * matching the random token minted at start(). The token is published via the
 * discovery file so only the paired stdio proxy can call us.
 *
 * One POST = one JSON-RPC message. Streaming / SSE is not used; if Claude Code
 * ever needs server-initiated events we'd add a parallel GET endpoint.
 */
export class McpHostServer {
	private readonly token: string = crypto.randomBytes(24).toString('hex');
	private server: http.Server | null = null;
	private port = 0;
	private readonly activeRequests = new Set<AbortController>();

	constructor(
		private readonly registry: McpToolRegistry,
		private readonly logger: ILogger,
	) {}

	getToken(): string { return this.token; }
	getPort(): number { return this.port; }

	async start(): Promise<McpServerInfo> {
		if (this.server) {
			return { port: this.port, token: this.token };
		}
		const server = http.createServer((req, res) => { void this.handleRequest(req, res); });
		this.server = server;

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.removeListener('error', reject);
				resolve();
			});
		});

		this.port = (server.address() as AddressInfo).port;
		this.logger.info(`MCP host server listening on 127.0.0.1:${this.port}`);
		return { port: this.port, token: this.token };
	}

	async stop(): Promise<void> {
		if (!this.server) { return; }
		for (const ctrl of this.activeRequests) { ctrl.abort(); }
		this.activeRequests.clear();
		await new Promise<void>(resolve => this.server!.close(() => resolve()));
		this.server = null;
		this.port = 0;
	}

	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (req.method !== 'POST' || req.url !== '/mcp') {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('Not found');
			return;
		}
		const auth = req.headers['authorization'];
		if (typeof auth !== 'string' || !this.authMatches(auth)) {
			res.writeHead(401, { 'Content-Type': 'text/plain' });
			res.end('Unauthorized');
			return;
		}

		const body = await readBody(req).catch(err => ({ err }));
		if (typeof body !== 'string') {
			res.writeHead(413, { 'Content-Type': 'text/plain' });
			res.end('Payload too large or unreadable');
			return;
		}

		let message: JsonRpcMessage;
		try {
			message = JSON.parse(body);
		} catch {
			writeJsonRpcError(res, null, JsonRpcErrorCode.ParseError, 'Invalid JSON');
			return;
		}

		// Notifications have no id and expect no response.
		if (!('id' in message) || message.id === undefined) {
			res.writeHead(204);
			res.end();
			return;
		}

		const controller = new AbortController();
		this.activeRequests.add(controller);
		req.on('close', () => {
			if (res.writableEnded) { return; }
			controller.abort();
		});
		try {
			const response = await this.dispatch(message as JsonRpcRequest, controller.signal);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(response));
		} catch (err) {
			this.logger.error(`MCP dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
			writeJsonRpcError(
				res,
				(message as JsonRpcRequest).id ?? null,
				JsonRpcErrorCode.InternalError,
				err instanceof Error ? err.message : 'Internal error',
			);
		} finally {
			this.activeRequests.delete(controller);
		}
	}

	private authMatches(header: string): boolean {
		const prefix = 'Bearer ';
		if (!header.startsWith(prefix)) { return false; }
		const presented = header.slice(prefix.length);
		// Constant-time compare to avoid trivial timing leaks.
		const a = Buffer.from(presented);
		const b = Buffer.from(this.token);
		if (a.length !== b.length) { return false; }
		return crypto.timingSafeEqual(a, b);
	}

	private async dispatch(req: JsonRpcRequest, signal: AbortSignal): Promise<JsonRpcResponse> {
		switch (req.method) {
			case 'initialize':
				return ok(req.id, {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: 'dbt-anvil', version: '0.0.0' },
				});
			case 'tools/list':
				return ok(req.id, { tools: this.registry.describe() });
			case 'tools/call': {
				const params = req.params as { name?: string; arguments?: unknown } | undefined;
				if (!params || typeof params.name !== 'string') {
					return err(req.id, JsonRpcErrorCode.InvalidParams, '`name` is required');
				}
				const result = await this.registry.invoke(params.name, params.arguments ?? {}, signal);
				return ok(req.id, result);
			}
			case 'ping':
				return ok(req.id, {});
			default:
				return err(req.id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${req.method}`);
		}
	}
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return { jsonrpc: JSONRPC_VERSION, id, result };
}

function err(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

function writeJsonRpcError(res: http.ServerResponse, id: JsonRpcId, code: number, message: string): void {
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(err(id, code, message)));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on('data', (chunk: Buffer) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error('payload too large'));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}
