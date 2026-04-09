import type { DecodedField, DecodedThriftMessage } from './thrift-wire-decoder';

// The raw inner-field map used by envelope bodies
type DecodedFields = Record<string, DecodedField>;

// Unpacked CALL envelope: name + sequenceId + inner args from fields["1"]
export type ThriftCallMessage = {
	name: string;
	messageType: 'CALL';
	sequenceId: number;
	args: DecodedFields;
};

// Unpacked REPLY envelope: name + sequenceId + status + inner result from fields["0"]
export type ThriftReplyMessage = {
	name: string;
	messageType: 'REPLY';
	sequenceId: number;
	status: TStatus;
	result: DecodedFields;
};

export type ThriftMessageDecoder<T> = {
	decode(msg: ThriftReplyMessage | ThriftCallMessage): T;
};

export type ThriftMessageEncoder<T> = {
	encode(msg: T): ThriftReplyMessage | ThriftCallMessage;
};

export type TStatus = {
	statusCode: number;
};

export type THandleIdentifier = {
	guid: Buffer;
	secret: Buffer;
};

export type TSessionHandle = {
	sessionId: THandleIdentifier;
};

export type GetInfoValue = {
	stringValue: string;
};

export type TNamespace = {
	catalogName: string;
	schemaName?: string;
};

// --- Envelope helpers ---

export function decodeReplyEnvelope(decoded: DecodedThriftMessage): ThriftReplyMessage {
	const outer = decoded.fields['0'].value as DecodedFields;
	const statusFields = outer['1'].value as DecodedFields;
	return {
		name: decoded.name,
		messageType: 'REPLY',
		sequenceId: decoded.sequenceId,
		status: { statusCode: statusFields['1'].value as number },
		result: outer,
	};
}

export function decodeCallEnvelope(decoded: DecodedThriftMessage): ThriftCallMessage {
	return {
		name: decoded.name,
		messageType: 'CALL',
		sequenceId: decoded.sequenceId,
		args: decoded.fields['1'].value as DecodedFields,
	};
}

export function encodeReplyEnvelope(msg: ThriftReplyMessage): DecodedThriftMessage {
	return {
		name: msg.name,
		messageType: msg.messageType,
		sequenceId: msg.sequenceId,
		fields: { '0': { type: 'STRUCT', value: msg.result } },
	};
}

export function encodeCallEnvelope(msg: ThriftCallMessage): DecodedThriftMessage {
	return {
		name: msg.name,
		messageType: msg.messageType,
		sequenceId: msg.sequenceId,
		fields: { '1': { type: 'STRUCT', value: msg.args } },
	};
}

export class OpenSessionResponse {
	constructor(
		public sequenceId: number,
		public status: TStatus,
		public serverProtocolVersion: number,
		public sessionHandle: TSessionHandle,
		public getInfos: GetInfoValue[],
		public initialNamespace: TNamespace,
		public canUseMultipleCatalogs?: boolean,
	) {}

	static encode(msg: OpenSessionResponse): ThriftReplyMessage {
		const { sessionId } = msg.sessionHandle;
		const ns = msg.initialNamespace;

		return {
			name: 'OpenSession',
			messageType: 'REPLY',
			sequenceId: msg.sequenceId,
			status: msg.status,
			result: {
				'1': {
					type: 'STRUCT',
					value: {
						'1': { type: 'I32', value: msg.status.statusCode },
					},
				},
				'2': { type: 'I32', value: msg.serverProtocolVersion },
				'3': {
					type: 'STRUCT',
					value: {
						'1': {
							type: 'STRUCT',
							value: {
								'1': { type: 'STRING', value: sessionId.guid.toString('base64'), isBinary: true },
								'2': { type: 'STRING', value: sessionId.secret.toString('base64'), isBinary: true },
							},
						},
					},
				},
				'1281': {
					type: 'LIST',
					elemType: 'STRUCT',
					value: msg.getInfos.map(info => ({
						type: 'STRUCT',
						value: {
							'1': { type: 'STRING', value: info.stringValue },
						},
					})),
				},
				'1284': {
					type: 'STRUCT',
					value: {
						'1': { type: 'STRING', value: ns.catalogName },
						...(ns.schemaName !== undefined ? { '2': { type: 'STRING', value: ns.schemaName } } : {}),
					},
				},
				'1285': { type: 'BOOL', value: msg.canUseMultipleCatalogs ?? true },
			},
		};
	}

	static decode(msg: ThriftReplyMessage): OpenSessionResponse {
		const resp = msg.result as DecodedFields;
		const sessionHandle = resp['3'].value as DecodedFields;
		const sessionId = sessionHandle['1'].value as DecodedFields;
		const getInfosList = resp['1281'].value as Array<{ value: DecodedFields }>;
		const ns = resp['1284'].value as DecodedFields;

		return new OpenSessionResponse(
			msg.sequenceId,
			msg.status,
			resp['2'].value as number,
			{
				sessionId: {
					guid: Buffer.from(sessionId['1'].value as string, 'base64'),
					secret: Buffer.from(sessionId['2'].value as string, 'base64'),
				},
			},
			getInfosList.map(item => ({ stringValue: item.value['1'].value as string })),
			{
				catalogName: ns['1'].value as string,
				...(ns['2'] !== undefined ? { schemaName: ns['2'].value as string } : {}),
			},
			resp['1285']?.value as boolean | undefined,
		);
	}
}

export function buildOpenSessionResponse(msg: OpenSessionResponse): DecodedThriftMessage {
	return encodeReplyEnvelope(OpenSessionResponse.encode(msg));
}
