export interface MetricBackendRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Buffer;
}

export class MetricBackendResponse {
	constructor(
		public status: number,
		public headers: Record<string, string>,
		public body: Buffer,
	) {}
}

export interface MetricBackendProvider {
	readonly name: string;
	handle(request: MetricBackendRequest): Promise<MetricBackendResponse>;
}
