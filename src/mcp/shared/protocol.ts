/**
 * MCP wire protocol shared types.
 *
 * The in-host HTTP server speaks the Model Context Protocol directly over
 * JSON-RPC 2.0 (see https://spec.modelcontextprotocol.io/).
 * The stdio proxy is a dumb byte-forwarder — it does not interpret frames.
 *
 * Only the subset needed for tool use is modelled: initialize, tools/list,
 * tools/call. Other MCP features (resources, prompts, elicitation) can be
 * added later without breaking the wire format.
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const JSONRPC_VERSION = '2.0';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
	jsonrpc: typeof JSONRPC_VERSION;
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: typeof JSONRPC_VERSION;
	method: string;
	params?: unknown;
}

export interface JsonRpcSuccessResponse {
	jsonrpc: typeof JSONRPC_VERSION;
	id: JsonRpcId;
	result: unknown;
}

export interface JsonRpcErrorResponse {
	jsonrpc: typeof JSONRPC_VERSION;
	id: JsonRpcId;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * Behavioural hints clients can use to render tools with appropriate
 * affordances (e.g. confirmation prompts on destructive ops, richer display
 * on read-only ones). All fields optional per the MCP spec.
 */
export interface McpToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** MCP tool descriptor returned by `tools/list`. */
export interface McpToolDescriptor {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: McpToolAnnotations;
}

/** MCP tool result returned by `tools/call`. */
export interface McpToolCallResult {
	content: Array<McpContentBlock>;
	isError?: boolean;
}

export type McpContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string };

/** JSON-RPC standard error codes, plus MCP-specific ones. */
export const JsonRpcErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
} as const;

/**
 * Shape of the discovery file written by the extension and read by the proxy.
 * Lives at `~/.dbt-anvil/mcp/<workspace-hash>.json`.
 */
export interface DiscoveryFile {
	port: number;
	token: string;
	pid: number;
	version: string;
	startedAt: number;
	workspacePath: string;
}
