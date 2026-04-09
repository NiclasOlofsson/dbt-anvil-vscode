export interface MetricBackendRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Buffer;
}

export interface MetricBackendResponse {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
}

export interface MetricBackendProvider {
	readonly name: string;
	handle(request: MetricBackendRequest): Promise<MetricBackendResponse>;
}
