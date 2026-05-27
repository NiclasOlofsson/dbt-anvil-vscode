import type * as vscode from 'vscode';
import type { McpToolAnnotations, McpToolCallResult, McpToolDescriptor } from '../shared/protocol';

/**
 * A single registry entry. The handler is intentionally the existing
 * `vscode.LanguageModelTool` instance — both the Copilot surface and the MCP
 * server share the same object, so business logic never diverges between the
 * two consumers.
 */
export interface RegistryEntry<TInput = unknown> {
	name: string;
	title?: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: McpToolAnnotations;
	tool: vscode.LanguageModelTool<TInput>;
}

/**
 * In-memory tool registry. Populated at extension activation from the
 * `languageModelTools` block of `package.json` plus the concrete tool
 * instances constructed with their dependencies.
 */
export class McpToolRegistry {
	private readonly entries = new Map<string, RegistryEntry>();

	register<T>(entry: RegistryEntry<T>): void {
		this.entries.set(entry.name, entry as RegistryEntry);
	}

	get(name: string): RegistryEntry | undefined {
		return this.entries.get(name);
	}

	list(): RegistryEntry[] {
		return [...this.entries.values()];
	}

	describe(): McpToolDescriptor[] {
		return this.list().map(e => ({
			name: e.name,
			...(e.title ? { title: e.title } : {}),
			description: e.description,
			inputSchema: e.inputSchema,
			...(e.annotations ? { annotations: e.annotations } : {}),
		}));
	}

	/**
	 * Invokes a registered tool with MCP-shaped input and returns an
	 * MCP-shaped result. Translates from the `vscode.LanguageModelToolResult`
	 * content-part model to MCP content blocks.
	 */
	async invoke(
		name: string,
		input: unknown,
		abortSignal: AbortSignal,
	): Promise<McpToolCallResult> {
		const entry = this.entries.get(name);
		if (!entry) {
			return {
				isError: true,
				content: [{ type: 'text', text: `Unknown tool: ${name}` }],
			};
		}

		const token = abortSignalToCancellationToken(abortSignal);
		try {
			const result = await entry.tool.invoke(
				{
					input: input as never,
					toolInvocationToken: undefined,
				},
				token,
			);
			if (!result) {
				return { content: [{ type: 'text', text: '' }] };
			}
			return { content: toMcpContent(result) };
		} catch (err) {
			return {
				isError: true,
				content: [{
					type: 'text',
					text: err instanceof Error ? err.message : String(err),
				}],
			};
		}
	}
}

/**
 * Converts a `vscode.LanguageModelToolResult` into MCP content blocks.
 * Text parts are passed through; other part shapes are best-effort stringified
 * so no information is silently dropped.
 */
function toMcpContent(result: vscode.LanguageModelToolResult): McpToolCallResult['content'] {
	const parts = (result as { content?: unknown[] }).content;
	if (!Array.isArray(parts)) {
		return [{ type: 'text', text: JSON.stringify(result) }];
	}
	return parts.map((part): McpToolCallResult['content'][number] => {
		if (part && typeof part === 'object' && 'value' in part && typeof (part as { value: unknown }).value === 'string') {
			return { type: 'text', text: (part as { value: string }).value };
		}
		return { type: 'text', text: JSON.stringify(part) };
	});
}

/**
 * Bridges Node's AbortSignal to VS Code's CancellationToken shape.
 * The MCP server runs in the extension host, so we can synthesise a token
 * without importing the `vscode` namespace at module top-level (keeps the
 * registry importable from the proxy if we ever need shared code there).
 */
function abortSignalToCancellationToken(signal: AbortSignal): vscode.CancellationToken {
	const listeners = new Set<(e: unknown) => void>();
	const fire = (): void => { for (const l of listeners) { l(undefined); } };
	if (signal.aborted) {
		queueMicrotask(fire);
	} else {
		signal.addEventListener('abort', fire, { once: true });
	}
	return {
		get isCancellationRequested() { return signal.aborted; },
		onCancellationRequested: (listener: (e: unknown) => void) => {
			listeners.add(listener);
			return {
				dispose: () => { listeners.delete(listener); },
			};
		},
	} as vscode.CancellationToken;
}
