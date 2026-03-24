import { vi } from 'vitest';
import type { ILogger } from '../types/logger';
import { LogLevel } from '../types/logger';

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
