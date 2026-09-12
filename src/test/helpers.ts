import { vi } from 'vitest';
import type { ILogger } from '../types/logger';
import { LogLevel } from '../types/logger';
import type { CompileCache } from '../dbt/compile-cache';
import { parseTemplated } from '../ftl/sqllens/api';
import type { Dialect, MacroShape } from '../ftl/sqllens/api';

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

/**
 * A `makeTemplateProvider` lookup over macro definitions given as source text, the way
 * `ManifestIndexer.macroShape` derives one from `macro_sql`: sqllens reads each
 * definition and answers the `MacroShape` of the macro it declares.
 */
export function macroShapeLookup(
	lookupSql: (name: string) => string | undefined,
	dialect: Dialect,
): (name: string) => MacroShape | undefined {
	return name => {
		const sql = lookupSql(name);
		return sql === undefined ? undefined : parseTemplated(sql, dialect).macros.find(m => m.name === name);
	};
}
