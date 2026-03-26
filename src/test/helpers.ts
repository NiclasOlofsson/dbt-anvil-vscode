import { vi } from 'vitest';
import type { ILogger } from '../types/logger';
import { LogLevel } from '../types/logger';
import type { CompileCache } from '../dbt/compile-cache';

export function createMockLogger(): ILogger {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		setLogLevel: vi.fn(),
		getLogLevel: vi.fn().mockReturnValue(LogLevel.DEBUG),
	};
}

/** Returns a CompileCache stub whose ensureCompiled returns undefined by default. */
export function createMockCompileCache(compiledCode?: string): CompileCache {
	return {
		ensureCompiled: vi.fn().mockResolvedValue(compiledCode),
		invalidate: vi.fn(),
		clear: vi.fn(),
	} as unknown as CompileCache;
}
