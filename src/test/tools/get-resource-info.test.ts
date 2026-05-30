import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GetResourceInfoTool } from '../../tools/get-resource-info';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ManifestLoader } from '../../dbt/manifest-loader';
import type { DbtExecutionService } from '../../dbt/execution-service';
import { createMockLogger, createMockCompileCache } from '../helpers';

const TEST_DIR = path.join(__dirname, '..', '..', 'fixtures', 'test-project-get-resource-info');

interface FakeRawNode {
	unique_id: string;
	name: string;
	resource_type: 'model';
	package_name: string;
	original_file_path: string;
	raw_code: string;
	columns: Record<string, never>;
	tags: string[];
}

function makeTool(node: FakeRawNode): GetResourceInfoTool {
	const indexer = {
		projectDir: TEST_DIR,
		findResource: vi.fn().mockReturnValue([{ uniqueId: node.unique_id }]),
		getRawNode: vi.fn().mockReturnValue(node),
	} as unknown as ManifestIndexer;
	return new GetResourceInfoTool(
		indexer,
		{} as DbtExecutionService,
		{} as ManifestLoader,
		createMockLogger(),
		createMockCompileCache(),
	);
}

async function invokeAndParse(tool: GetResourceInfoTool, name: string): Promise<Record<string, unknown>> {
	const result = await tool.invoke(
		{ input: { name } } as never,
		{ isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
	);
	const part = (result.content as Array<{ value: string }>)[0];
	return JSON.parse(part.value);
}

const BASE_NODE: FakeRawNode = {
	unique_id: 'model.p.foo',
	name: 'foo',
	resource_type: 'model',
	package_name: 'p',
	original_file_path: 'models/foo.sql',
	raw_code: 'select 1 -- STALE FROM MANIFEST',
	columns: {},
	tags: [],
};

describe('GetResourceInfoTool raw_sql', () => {
	beforeEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
		fs.mkdirSync(path.join(TEST_DIR, 'models'), { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it('returns live disk content as raw_sql, not the manifest raw_code', async () => {
		fs.writeFileSync(path.join(TEST_DIR, 'models', 'foo.sql'), 'select 1 -- LIVE FROM DISK');
		const parsed = await invokeAndParse(makeTool(BASE_NODE), 'foo');

		expect(parsed.raw_sql).toBe('select 1 -- LIVE FROM DISK');
	});

	it('falls back to manifest raw_code when the file is missing from disk', async () => {
		// intentionally do not write the .sql file
		const parsed = await invokeAndParse(makeTool(BASE_NODE), 'foo');

		expect(parsed.raw_sql).toBe('select 1 -- STALE FROM MANIFEST');
	});
});
