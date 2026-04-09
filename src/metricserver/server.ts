import fs from 'fs';
import https from 'https';
import path from 'path';
import { MetricLogger, SchemaObserver } from './logger';
import { decodeThriftBinaryMessage } from './thrift-wire-decoder';
import type { MetricBackendProvider } from './backend-provider';
import { DatabricksBackendProvider } from './backends/databricks-backend-provider';
import { MockBackendProvider } from './backends/mock-backend-provider';

// Default cert paths — generated once with:
// openssl req -x509 -newkey rsa:2048 -keyout temp_auto/server.key -out temp_auto/server.crt -days 3650 -nodes -subj "//CN=localhost"
const DEFAULT_CERT_DIR = path.resolve(__dirname, '../../temp_auto');

const DEFAULT_DATABRICKS_UPSTREAM = {
	host: 'adb-4210642710565830.10.azuredatabricks.net',
	path: '/sql/1.0/warehouses/6c5a83495c78969e',
	token: 'dapi20476ae8dfb794a421229a096378272d-2',
};

export interface MetricServerOptions {
	port: number;
	logger: MetricLogger;
	tls?: { key: string; cert: string };
	backend?: MetricBackendProvider;
}

type AnyServer = { listen: (port: number, cb?: () => void) => unknown; close: (cb?: () => void) => unknown };

function toBuffer(chunk: unknown): Buffer {
	if (Buffer.isBuffer(chunk)) return chunk;
	if (typeof chunk === 'string') return Buffer.from(chunk, 'binary');
	return Buffer.alloc(0);
}

function createDefaultBackend(): MetricBackendProvider {
	const databricksBackend = new DatabricksBackendProvider(DEFAULT_DATABRICKS_UPSTREAM);
	return new MockBackendProvider(databricksBackend);
}

function logThriftBinary(logger: MetricLogger, observer: SchemaObserver, label: string, buffer: Buffer): void {
	const hex = buffer.toString('hex');
	logger.debug(`${label} [HEX] ${hex}`);
	try {
		const decoded = decodeThriftBinaryMessage(buffer);
		logger.debug(`${label} [JSON] ${JSON.stringify(decoded, null, 2)}`);
		observer.observe(decoded);
	} catch (error) {
		logger.debug(`${label} [JSON] decode failed: ${(error as Error).message}`);
	}
}

export function createMetricServer(options: MetricServerOptions): AnyServer {
	const { port } = options;
	const logger = options.logger;
	const observer = new SchemaObserver(path.join(DEFAULT_CERT_DIR, 'TCLIService.inferred.thrift'));
	const backend = options.backend ?? createDefaultBackend();

	// Load TLS cert — use provided paths or default temp_auto/ location
	const tlsOpt = options.tls ?? {
		key: path.join(DEFAULT_CERT_DIR, 'server.key'),
		cert: path.join(DEFAULT_CERT_DIR, 'server.crt'),
	};
	const tls = {
		key: fs.readFileSync(tlsOpt.key),
		cert: fs.readFileSync(tlsOpt.cert),
	};

	const server = https.createServer(tls, (req, res) => {
		const headerLines = Object.entries(req.headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
		logger.debug(`HTTPS ${req.method} ${req.url}\nHeaders:\n${headerLines}`);

		const chunks: Buffer[] = [];
		req.on('data', (chunk: unknown) => chunks.push(toBuffer(chunk)));
		req.on('end', async () => {
			const reqBody = Buffer.concat(chunks);
			if (reqBody.length === 0) {
				res.writeHead(400);
				res.end();
				return;
			}

			logThriftBinary(logger, observer, `>> WIRE ${req.method} ${req.url}`, reqBody);

			let upstream;
			try {
				upstream = await backend.handle({
					method: req.method ?? 'POST',
					url: req.url ?? '/cliservice',
					headers: req.headers as Record<string, string>,
					body: reqBody,
				});
			} catch (error) {
				logger.error(`${backend.name} backend error: ${(error as Error).message}`);
				res.writeHead(502);
				res.end();
				return;
			}

			logThriftBinary(logger, observer, `<< WIRE upstream ${req.method} ${req.url}`, upstream.body);

			const respOutbound = upstream.body;

			res.writeHead(upstream.status, {
				'content-type': 'application/x-thrift',
				'content-length': respOutbound.length,
				'x-databricks-org-id': upstream.headers['x-databricks-org-id'] ?? '',
				'x-content-type-options': 'nosniff',
				'server': upstream.headers['server'] ?? backend.name,
			});

			const rawHeader: string = (res as unknown as Record<string, unknown>)['_header'] as string ?? '';
			logger.debug(`<< RESPONSE ${upstream.status} ${req.method} ${req.url}\n${rawHeader.trimEnd()}`);
			res.end(respOutbound);
		});
	});

	server.listen(port, () => {
		logger.info(`MetricServer (${backend.name} backend) listening on https://localhost:${port}/cliservice`);
	});

	return server;
}
