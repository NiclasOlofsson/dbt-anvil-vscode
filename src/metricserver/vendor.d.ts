declare module 'thrift' {
	import * as http from 'http'

	export const TBufferedTransport: unknown
	export const TBinaryProtocol: unknown

	export interface WebServerOptions {
		services: Record<string, {
			transport: unknown
			protocol: unknown
			processor: unknown
			handler: unknown
		}>
		cors?: string[]
		tls?: object
	}

	export function createWebServer(options: WebServerOptions): http.Server
	export function createClient(service: unknown, connection: unknown): unknown
	export function createConnection(host: string, port: number, options?: object): unknown
	export function createHttpConnection(host: string, port: number, options?: object): unknown

	export class Int64 {
		constructor(value: number | string)
	}
}

declare module 'hive-driver' {
	export const thrift: {
		TCLIService: unknown
		TCLIService_types: unknown
	}
	export const auth: unknown
	export const connections: unknown
}
