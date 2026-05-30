import { describe, it, expect } from 'vitest';
import type * as vscode from 'vscode';
import { McpToolRegistry } from '../mcp/host/registry';

/**
 * The input echo exists so a human reading a tool result in Claude Code can see
 * what arguments the tool received — Claude Code renders results but not inputs.
 * These tests pin that the echo is the first content block on every return path,
 * so a regression that drops it (or stops covering the error path) fails here.
 */
describe('McpToolRegistry input echo', () => {
	const signal = new AbortController().signal;

	function registryWith(invoke: vscode.LanguageModelTool<unknown>['invoke']): McpToolRegistry {
		const registry = new McpToolRegistry();
		registry.register({
			name: 'demo',
			description: 'demo tool',
			inputSchema: {},
			tool: { invoke } as vscode.LanguageModelTool<unknown>,
		});
		return registry;
	}

	it('prepends the received input to a successful result', async () => {
		const registry = registryWith(async () => ({ content: [{ value: 'tool output' }] }) as never);

		const result = await registry.invoke('demo', { model: 'orders', limit: 5 }, signal);

		expect(result.content[0]).toEqual({
			type: 'text',
			text: '[tool input] {"model":"orders","limit":5}',
		});
		expect(result.content[1]).toEqual({ type: 'text', text: 'tool output' });
		expect(result.isError).toBeUndefined();
	});

	it('still echoes the input when the tool throws', async () => {
		const registry = registryWith(async () => { throw new Error('boom'); });

		const result = await registry.invoke('demo', { model: 'orders' }, signal);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: 'text',
			text: '[tool input] {"model":"orders"}',
		});
		expect(result.content[1]).toEqual({ type: 'text', text: 'boom' });
	});

	it('echoes the input even for an unknown tool', async () => {
		const registry = new McpToolRegistry();

		const result = await registry.invoke('nope', { a: 1 }, signal);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: 'text', text: '[tool input] {"a":1}' });
	});

	it('falls back to an empty object when input is undefined', async () => {
		const registry = registryWith(async () => undefined as never);

		const result = await registry.invoke('demo', undefined, signal);

		expect(result.content[0]).toEqual({ type: 'text', text: '[tool input] {}' });
	});
});
