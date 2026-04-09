import { createMetricServer } from './server';
import { MetricLogger } from './logger';
import path from 'path';

const LOG_FILE = path.resolve(__dirname, '../../temp_auto/metricserver.log');
const logger = new MetricLogger(LOG_FILE);

const port = 443;
logger.info('[metricserver] Starting in proxy-only mode');

const server = createMetricServer({ port, logger });

process.on('SIGINT', () => {
	logger.info('Shutting down...');
	server.close(() => {
		logger.info('Stopped');
		process.exit(0);
	});
});

process.on('SIGTERM', () => {
	server.close(() => {
		process.exit(0);
	});
});
