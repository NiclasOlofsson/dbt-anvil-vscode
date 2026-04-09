import https from 'https';
import type { MetricBackendProvider, MetricBackendRequest, MetricBackendResponse } from '../backend-provider';

export interface DatabricksBackendConfig {
	host: string;
	path: string;
	token: string;
	port?: number;
	rejectUnauthorized?: boolean;
	defaultUserAgent?: string;
}

export class DatabricksBackendProvider implements MetricBackendProvider {
	readonly name = 'databricks';

	constructor(private readonly config: DatabricksBackendConfig) {}

	handle(request: MetricBackendRequest): Promise<MetricBackendResponse> {
		return new Promise((resolve, reject) => {
			const upstream = https.request({
				hostname: this.config.host,
				port: this.config.port ?? 443,
				path: this.config.path,
				method: request.method,
				rejectUnauthorized: this.config.rejectUnauthorized ?? true,
				headers: {
					'content-type': 'application/x-thrift',
					'content-length': request.body.length,
					'authorization': `Bearer ${this.config.token}`,
					'user-agent': request.headers['user-agent'] ?? this.config.defaultUserAgent ?? 'ADBCSparkDriver/1.0.0 Thrift/0.22.0 PowerBI',
					'accept': 'application/x-thrift',
					'accept-encoding': 'identity',
				},
			}, (res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					resolve({
						status: res.statusCode ?? 200,
						headers: res.headers as Record<string, string>,
						body: Buffer.concat(chunks),
					});
				});
			});

			upstream.on('error', reject);
			upstream.end(request.body);
		});
	}
}
