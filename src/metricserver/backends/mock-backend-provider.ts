import type { MetricBackendProvider, MetricBackendRequest, MetricBackendResponse } from '../backend-provider';
import { decodeThriftBinaryMessage, encodeThriftBinaryMessage, type DecodedThriftMessage } from '../thrift-wire-decoder';

export type MockMessageHandlerContext = {
	request: MetricBackendRequest;
	requestMessage: DecodedThriftMessage;
	upstreamResponse: MetricBackendResponse;
	upstreamMessage?: DecodedThriftMessage;
};

export type MockMessageHandler = (
	context: MockMessageHandlerContext,
) => Promise<MetricBackendResponse | DecodedThriftMessage | undefined> | MetricBackendResponse | DecodedThriftMessage | undefined;

function tryDecodeThrift(buffer: Buffer): DecodedThriftMessage | undefined {
	try {
		return decodeThriftBinaryMessage(buffer);
	} catch {
		return undefined;
	}
}

function toBackendResponse(value: MetricBackendResponse | DecodedThriftMessage, fallbackHeaders: Record<string, string>): MetricBackendResponse {
	if ('body' in value && Buffer.isBuffer(value.body)) {
		return value;
	}
	const encoded = encodeThriftBinaryMessage(value as DecodedThriftMessage);
	return {
		status: 200,
		headers: {
			'content-type': 'application/x-thrift',
			...fallbackHeaders,
		},
		body: encoded,
	};
}

export class MockBackendProvider implements MetricBackendProvider {
	readonly name = 'mock';

	private readonly _handlers = new Map<string, MockMessageHandler>();

	constructor(private readonly upstream: MetricBackendProvider) {}

	setMessageHandler(messageName: string, handler: MockMessageHandler): void {
		this._handlers.set(messageName, handler);
	}

	removeMessageHandler(messageName: string): void {
		this._handlers.delete(messageName);
	}

	clearMessageHandlers(): void {
		this._handlers.clear();
	}

	async handle(request: MetricBackendRequest): Promise<MetricBackendResponse> {
		const requestMessage = tryDecodeThrift(request.body);
		const upstreamResponse = await this.upstream.handle(request);

		if (!requestMessage) {
			return upstreamResponse;
		}

		const handler = this._handlers.get(requestMessage.name);
		if (!handler) {
			return upstreamResponse;
		}

		const upstreamMessage = tryDecodeThrift(upstreamResponse.body);
		const override = await handler({
			request,
			requestMessage,
			upstreamResponse,
			upstreamMessage,
		});

		if (!override) {
			return upstreamResponse;
		}

		return toBackendResponse(override, upstreamResponse.headers);
	}
}
