import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DescribeCache } from '../../dbt/describe-cache';
import type { DbtExecutionService } from '../../dbt/execution-service';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import { createMockLogger } from '../helpers';

const mockLogger = createMockLogger();

function createMockService(columns?: string[]): DbtExecutionService {
	return {
		submit: vi.fn().mockResolvedValue({
			data: { columns: columns ?? ['id', 'name'] },
		}),
	} as unknown as DbtExecutionService;
}

function createMockIndexer(storedColumns?: string[]): ManifestIndexer {
	const store = new Map<string, string[]>();
	if (storedColumns) store.set('model.project.orders', storedColumns);
	return {
		getColumns: vi.fn((uid: string) => store.get(uid) ?? undefined),
		setColumns: vi.fn((uid: string, cols: string[]) => { store.set(uid, cols); }),
		isManifestOnly: vi.fn(() => false),
	} as unknown as ManifestIndexer;
}

describe('DescribeCache', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const UID = 'model.project.orders';
	const NAME = 'orders';

	it('returns cached columns from indexer without bridge call', async () => {
		const service = createMockService();
		const indexer = createMockIndexer(['id', 'amount']);
		const cache = new DescribeCache(service, indexer, mockLogger);

		const result = await cache.describeTable(UID, NAME);

		expect(result).toEqual(['id', 'amount']);
		expect(service.submit).not.toHaveBeenCalled();
	});

	it('calls bridge on cache miss and stores result', async () => {
		const service = createMockService(['id', 'status', 'total']);
		const indexer = createMockIndexer();
		const cache = new DescribeCache(service, indexer, mockLogger);

		const result = await cache.describeTable(UID, NAME);

		expect(result).toEqual(['id', 'status', 'total']);
		expect(service.submit).toHaveBeenCalledOnce();
		expect(indexer.setColumns).toHaveBeenCalledWith(UID, ['id', 'status', 'total']);
	});

	it('passes source_name for source nodes', async () => {
		const service = createMockService(['col1']);
		const indexer = createMockIndexer();
		const cache = new DescribeCache(service, indexer, mockLogger);

		await cache.describeTable('source.project.raw.orders', 'orders', 'raw');

		const call = (service.submit as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.raw).toEqual({ describe_table: true, name: 'orders', source_name: 'raw' });
	});

	it('omits source_name for model nodes', async () => {
		const service = createMockService(['col1']);
		const indexer = createMockIndexer();
		const cache = new DescribeCache(service, indexer, mockLogger);

		await cache.describeTable(UID, NAME);

		const call = (service.submit as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.raw).toEqual({ describe_table: true, name: 'orders' });
	});

	it('deduplicates concurrent requests for the same uniqueId', async () => {
		let resolveSubmit: ((v: unknown) => void) | undefined;
		const service = {
			submit: vi.fn().mockImplementation(
				() => new Promise(r => { resolveSubmit = r; }),
			),
		} as unknown as DbtExecutionService;
		const indexer = createMockIndexer();
		const cache = new DescribeCache(service, indexer, mockLogger);

		const p1 = cache.describeTable(UID, NAME);
		const p2 = cache.describeTable(UID, NAME);

		expect(service.submit).toHaveBeenCalledOnce();

		resolveSubmit!({ data: { columns: ['id', 'amount'] } });
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toEqual(['id', 'amount']);
		expect(r2).toEqual(['id', 'amount']);
		expect(indexer.setColumns).toHaveBeenCalledOnce();
	});

	it('returns undefined and does not store when bridge returns empty columns', async () => {
		const service: DbtExecutionService = {
			submit: vi.fn().mockResolvedValue({ data: { columns: [] } }),
		} as unknown as DbtExecutionService;
		const indexer = createMockIndexer();
		const cache = new DescribeCache(service, indexer, mockLogger);

		const result = await cache.describeTable(UID, NAME);

		expect(result).toBeUndefined();
		expect(indexer.setColumns).not.toHaveBeenCalled();
	});

	it('returns undefined and does not store when bridge errors', async () => {
		const service: DbtExecutionService = {
			submit: vi.fn().mockRejectedValue(new Error('bridge error')),
		} as unknown as DbtExecutionService;
		const indexer = createMockIndexer();
		const cache = new DescribeCache(service, indexer, mockLogger);

		const result = await cache.describeTable(UID, NAME);

		expect(result).toBeUndefined();
		expect(indexer.setColumns).not.toHaveBeenCalled();
	});

	it('retries after a failed fetch (inflight cleared after error)', async () => {
		const service: DbtExecutionService = {
			submit: vi.fn()
				.mockRejectedValueOnce(new Error('transient'))
				.mockResolvedValueOnce({ data: { columns: ['id'] } }),
		} as unknown as DbtExecutionService;
		const indexer = createMockIndexer();
		const cache = new DescribeCache(service, indexer, mockLogger);

		const first = await cache.describeTable(UID, NAME);
		expect(first).toBeUndefined();

		const second = await cache.describeTable(UID, NAME);
		expect(second).toEqual(['id']);
		expect(service.submit).toHaveBeenCalledTimes(2);
	});
});
