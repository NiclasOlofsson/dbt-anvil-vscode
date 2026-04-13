import { randomBytes } from 'crypto';
import { MetricBackendResponse } from '../backend-provider';
import type { MetricBackendProvider, MetricBackendRequest } from '../backend-provider';
import {
	decodeThriftBinaryMessage,
	encodeThriftBinaryMessage,
	decodeTypedMessage,
	encodeTypedMessage,
	type DecodedThriftMessage,
} from '../thrift-wire-decoder';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Int64: new(n: number) => any = require('node-int64');

import { TOpenSessionResp, THandleIdentifier, TSessionHandle, TStatus, TNamespace, TStatusCode, TProtocolVersion, TGetInfoReq, TGetInfoResp, TGetInfoValue, TGetInfoType, TGetCatalogsResp, TOperationHandle, TOperationType, TSparkDirectResults, TGetOperationStatusResp, TOperationState, TGetResultSetMetadataResp, TSparkRowSetType, TTableSchema, TColumnDesc, TTypeDesc, TTypeEntry, TPrimitiveTypeEntry, TTypeId, TFetchResultsResp, TRowSet, TColumn, TStringColumn, TCloseOperationResp } from '../thrift-types.js';

export type MockMessageHandlerContext = {
	request: MetricBackendRequest;
	requestMessage: DecodedThriftMessage;
	downstreamResponse: MetricBackendResponse;
	downstreamMessage?: DecodedThriftMessage;
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
	return new MetricBackendResponse(200, { 'content-type': 'application/x-thrift', ...fallbackHeaders }, encoded);
}

export class MockBackendProvider implements MetricBackendProvider {
	readonly name = 'mock';

	private readonly _handlers = new Map<string, MockMessageHandler>();

	constructor(private readonly downstream: MetricBackendProvider) {}

	setMessageHandler(messageName: string, handler: MockMessageHandler): void {
		this._handlers.set(messageName, handler);
	}

	removeMessageHandler(messageName: string): void {
		this._handlers.delete(messageName);
	}

	clearMessageHandlers(): void {
		this._handlers.clear();
	}

	private _buildOpenSessionOverride(sequenceId: number, downstreamBody: Buffer): MetricBackendResponse {
		const downstreamResp = decodeTypedMessage(downstreamBody).struct as TOpenSessionResp;

		const response = new MetricBackendResponse(
			200,
			{ 'content-type': 'application/x-thrift', 'x-content-type-options': 'nosniff', 'server': this.name },
			encodeTypedMessage({
				name: 'OpenSession',
				messageType: 'REPLY',
				sequenceId,
				struct: new TOpenSessionResp({
					status: new TStatus({ statusCode: TStatusCode.SUCCESS_STATUS }),
					serverProtocolVersion: TProtocolVersion.SPARK_CLI_SERVICE_PROTOCOL_V7,
					sessionHandle: new TSessionHandle({ sessionId: new THandleIdentifier(downstreamResp.sessionHandle!.sessionId) }),
					initialNamespace: new TNamespace({ catalogName: 'hive_metastore', schemaName: 'default' }),
					canUseMultipleCatalogs: true,
					getInfos: [],
				}),
			}),
		);

		return response;
	}

	private _buildGetCatalogsOverride(sequenceId: number): MetricBackendResponse {
		const catalogs = ['dev', 'hive_metastore', 'prod', 'samples', 'system', 'test'];

		const resp = new TGetCatalogsResp({
			status: new TStatus({ statusCode: TStatusCode.SUCCESS_STATUS }),
			// operationId is an opaque async-operation handle. The client uses it to poll status,
			// fetch results, and close the operation. With directResults follow-up calls are never
			// made, so this value is unused -- any random bytes are fine.
			operationHandle: new TOperationHandle({
				operationId: new THandleIdentifier({ guid: randomBytes(16), secret: randomBytes(16) }),
				operationType: TOperationType.GET_CATALOGS,
				hasResultSet: true,
			}),
			directResults: new TSparkDirectResults({
				operationStatus: new TGetOperationStatusResp({
					status: new TStatus({ statusCode: TStatusCode.SUCCESS_STATUS }),
					operationState: TOperationState.FINISHED_STATE,
					hasResultSet: true,
				}),
				resultSetMetadata: new TGetResultSetMetadataResp({
					status: new TStatus({ statusCode: TStatusCode.SUCCESS_STATUS }),
					schema: new TTableSchema({
						columns: [
							new TColumnDesc({
								columnName: 'TABLE_CAT',
								typeDesc: new TTypeDesc({
									types: [new TTypeEntry({ primitiveEntry: new TPrimitiveTypeEntry({ type: TTypeId.STRING_TYPE }) })],
								}),
								position: 1,
								comment: 'Catalog name. NULL if not applicable.',
							}),
						],
					}),
					resultFormat: TSparkRowSetType.COLUMN_BASED_SET,
				}),
				resultSet: new TFetchResultsResp({
					status: new TStatus({ statusCode: TStatusCode.SUCCESS_STATUS }),
					hasMoreRows: false,
					results: new TRowSet({
						startRowOffset: new Int64(0),
						rows: [],
						columns: [
							new TColumn({
								stringVal: new TStringColumn({
									values: catalogs,
									// Null bitmap: 1 bit per row packed into bytes, all zeros = no nulls.
									// e.g. 6 rows -> Math.ceil(6/8) = 1 byte = 0b00000000
									nulls: Buffer.alloc(Math.ceil(catalogs.length / 8)),
								}),
							}),
						],
					}),
				}),
				closeOperation: new TCloseOperationResp({
					status: new TStatus({ statusCode: TStatusCode.SUCCESS_STATUS }),
				}),
			}),
		});

		return new MetricBackendResponse(
			200,
			{ 'content-type': 'application/x-thrift', 'x-content-type-options': 'nosniff', 'server': this.name },
			encodeTypedMessage({ name: 'GetCatalogs', messageType: 'REPLY', sequenceId, struct: resp }),
		);
	}

	private _buildGetInfoOverride(sequenceId: number, requestBody: Buffer): MetricBackendResponse {
		const req = decodeTypedMessage(requestBody).struct as TGetInfoReq;

		const infoValues: Record<number, string> = {
			[TGetInfoType.CLI_DBMS_NAME]: 'Spark SQL',
			[TGetInfoType.CLI_DBMS_VER]: '3.0.0',
			[TGetInfoType.CLI_SERVER_NAME]: 'Databricks',
		};

		const stringValue = infoValues[req.infoType] ?? '';

		return new MetricBackendResponse(
			200,
			{ 'content-type': 'application/x-thrift', 'x-content-type-options': 'nosniff', 'server': this.name },
			encodeTypedMessage({
				name: 'GetInfo',
				messageType: 'REPLY',
				sequenceId,
				struct: new TGetInfoResp({
					status: new TStatus({ statusCode: TStatusCode.SUCCESS_STATUS }),
					infoValue: new TGetInfoValue({ stringValue }),
				}),
			}),
		);
	}

	async handle(request: MetricBackendRequest): Promise<MetricBackendResponse> {
		const requestMessage = tryDecodeThrift(request.body);

		if (!requestMessage) {
			const downstreamResponse = await this.downstream.handle(request);
			return downstreamResponse;
		}

		const handler = this._handlers.get(requestMessage.name);

		const downstreamResponse = await this.downstream.handle(request);

		if (!handler && requestMessage.name === 'OpenSession' && requestMessage.messageType === 'CALL') {
			return this._buildOpenSessionOverride(requestMessage.sequenceId, downstreamResponse.body);
		}

		if (!handler && requestMessage.name === 'GetInfo' && requestMessage.messageType === 'CALL') {
			return this._buildGetInfoOverride(requestMessage.sequenceId, request.body);
		}

		if (!handler && requestMessage.name === 'GetCatalogs' && requestMessage.messageType === 'CALL') {
			return this._buildGetCatalogsOverride(requestMessage.sequenceId);
		}

		if (handler) {
			const downstreamMessage = tryDecodeThrift(downstreamResponse.body);
			const override = await handler({
				request,
				requestMessage,
				downstreamResponse,
				downstreamMessage,
			});

			if (!override) {
				return downstreamResponse;
			}

			return toBackendResponse(override, downstreamResponse.headers);
		}

		return downstreamResponse;
	}
}
