import * as crypto from 'crypto';
import { HandleIdentifier, OperationHandle, OperationResult, ResultColumn, SessionHandle } from './types';

function generateHandle(): HandleIdentifier {
	return {
		guid: crypto.randomBytes(16),
		secret: crypto.randomBytes(16),
	};
}

function handleKey(handle: HandleIdentifier): string {
	return handle.guid.toString('hex');
}

export class OperationStore {
	private operations = new Map<string, OperationResult>();

	create(
		sessionHandle: SessionHandle,
		operationType: number,
		columns: ResultColumn[],
	): OperationHandle {
		const operationId = generateHandle();
		const handle: OperationHandle = {
			operationId,
			operationType,
			hasResultSet: true,
		};
		this.operations.set(handleKey(operationId), {
			sessionHandle,
			columns,
			fetched: false,
		});
		return handle;
	}

	get(handle: OperationHandle): OperationResult | undefined {
		return this.operations.get(handleKey(handle.operationId));
	}

	markFetched(handle: OperationHandle): void {
		const op = this.get(handle);
		if (op) op.fetched = true;
	}

	remove(handle: OperationHandle): boolean {
		return this.operations.delete(handleKey(handle.operationId));
	}

	removeForSession(sessionHandle: SessionHandle): void {
		const sessionKey = sessionHandle.sessionId.guid.toString('hex');
		for (const [key, op] of this.operations) {
			if (op.sessionHandle.sessionId.guid.toString('hex') === sessionKey) {
				this.operations.delete(key);
			}
		}
	}

	get size(): number {
		return this.operations.size;
	}
}
