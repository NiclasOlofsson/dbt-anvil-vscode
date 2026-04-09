/// <reference types="node" />
import thrift from 'thrift';

const ttypes = require('./thrift-types.js') as Record<string, new () => { read(p: unknown): void; write(p: unknown): void }>;


const Thrift = (thrift as Record<string, unknown>).Thrift as {
	Type: Record<string, number>;
	MessageType: Record<string, number>;
};
const thriftRuntime = thrift as Record<string, unknown>;
// node-int64 is a transitive dependency of thrift

const Int64 = require('node-int64');

interface Protocol {
	readBool(): boolean;
	readByte(): number;
	readI16(): number;
	readI32(): number;
	readI64(): unknown;
	readDouble(): number;
	readString(): string;
	readBinary(): Buffer | string;
	readMapBegin(): { ktype: number; vtype: number; size: number };
	readMapEnd(): void;
	readListBegin(): { etype: number; size: number };
	readListEnd(): void;
	readSetBegin(): { etype: number; size: number };
	readSetEnd(): void;
	readStructBegin(): void;
	readStructEnd(): void;
	readFieldBegin(): { ftype: number; fid: number };
	readFieldEnd(): void;
	skip(fieldType: number): void;
	writeBool(value: boolean): void;
	writeByte(value: number): void;
	writeI16(value: number): void;
	writeI32(value: number): void;
	writeI64(value: unknown): void;
	writeDouble(value: number): void;
	writeString(value: string): void;
	writeBinary(value: Buffer): void;
	writeMapBegin(ktype: number, vtype: number, size: number): void;
	writeMapEnd(): void;
	writeListBegin(etype: number, size: number): void;
	writeListEnd(): void;
	writeSetBegin(etype: number, size: number): void;
	writeSetEnd(): void;
	writeStructBegin(name: string): void;
	writeStructEnd(): void;
	writeFieldBegin(name: string, ftype: number, fid: number): void;
	writeFieldEnd(): void;
	writeFieldStop(): void;
	writeMessageBegin(fname: string, mtype: number, rseqid: number): void;
	writeMessageEnd(): void;
	readMessageBegin(): { fname: string; mtype: number; rseqid: number };
	readMessageEnd(): void;
}

export type DecodedField = {
	type: string;
	value: unknown;
	isBinary?: boolean;
	keyType?: string;   // MAP: key element type
	valueType?: string; // MAP: value element type
	elemType?: string;  // LIST/SET: element type
};

export type DecodedThriftMessage = {
	name: string;
	messageType: string;
	sequenceId: number;
	fields: Record<string, DecodedField>;
};

const TYPE_NAME: Record<number, string> = {
	[Thrift.Type.STOP]: 'STOP',
	[Thrift.Type.VOID]: 'VOID',
	[Thrift.Type.BOOL]: 'BOOL',
	[Thrift.Type.BYTE]: 'BYTE',
	[Thrift.Type.DOUBLE]: 'DOUBLE',
	[Thrift.Type.I16]: 'I16',
	[Thrift.Type.I32]: 'I32',
	[Thrift.Type.I64]: 'I64',
	[Thrift.Type.STRING]: 'STRING',
	[Thrift.Type.STRUCT]: 'STRUCT',
	[Thrift.Type.MAP]: 'MAP',
	[Thrift.Type.SET]: 'SET',
	[Thrift.Type.LIST]: 'LIST',
};

const MESSAGE_TYPE_NAME: Record<number, string> = {
	[Thrift.MessageType.CALL]: 'CALL',
	[Thrift.MessageType.REPLY]: 'REPLY',
	[Thrift.MessageType.EXCEPTION]: 'EXCEPTION',
	[Thrift.MessageType.ONEWAY]: 'ONEWAY',
};

const TYPE_NUM: Record<string, number> = {
	'BOOL': Thrift.Type.BOOL,
	'BYTE': Thrift.Type.BYTE,
	'DOUBLE': Thrift.Type.DOUBLE,
	'I16': Thrift.Type.I16,
	'I32': Thrift.Type.I32,
	'I64': Thrift.Type.I64,
	'STRING': Thrift.Type.STRING,
	'STRUCT': Thrift.Type.STRUCT,
	'MAP': Thrift.Type.MAP,
	'SET': Thrift.Type.SET,
	'LIST': Thrift.Type.LIST,
};

const MESSAGE_TYPE_NUM: Record<string, number> = {
	'CALL': Thrift.MessageType.CALL,
	'REPLY': Thrift.MessageType.REPLY,
	'EXCEPTION': Thrift.MessageType.EXCEPTION,
	'ONEWAY': Thrift.MessageType.ONEWAY,
};

function typeName(type: number): string {
	return TYPE_NAME[type] ?? `TYPE_${type}`;
}

function messageTypeName(type: number): string {
	return MESSAGE_TYPE_NAME[type] ?? `MSG_${type}`;
}

function toInt64Value(value: unknown): unknown {
	if (value && typeof value === 'object') {
		return value;
	}

	if (typeof value === 'number') {
		return new Int64(value);
	}

	if (typeof value === 'string') {
		const decimal = /^-?\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
		if (!Number.isNaN(decimal) && Number.isSafeInteger(decimal)) {
			return new Int64(decimal);
		}
		return new Int64(value);
	}

	return new Int64(0);
}

function assertStringValue(value: unknown, context: string): string {
	if (typeof value !== 'string') {
		throw new Error(`${context} must be a string`);
	}
	return value;
}

function readStringField(protocol: Protocol): DecodedField {
	if (typeof protocol.readBinary !== 'function') {
		return { type: 'STRING', value: protocol.readString() };
	}

	const binaryValue = protocol.readBinary();
	const buffer = Buffer.isBuffer(binaryValue)
		? binaryValue
		: Buffer.from(String(binaryValue), 'binary');

	const utf8Value = buffer.toString('utf8');
	if (Buffer.from(utf8Value, 'utf8').equals(buffer)) {
		return { type: 'STRING', value: utf8Value };
	}

	return {
		type: 'STRING',
		value: buffer.toString('base64'),
		isBinary: true,
	};
}

// ---- READ ----

function readField(protocol: Protocol, fieldType: number): DecodedField {
	switch (fieldType) {
		case Thrift.Type.BOOL:
			return { type: 'BOOL', value: protocol.readBool() };
		case Thrift.Type.BYTE:
			return { type: 'BYTE', value: protocol.readByte() };
		case Thrift.Type.I16:
			return { type: 'I16', value: protocol.readI16() };
		case Thrift.Type.I32:
			return { type: 'I32', value: protocol.readI32() };
		case Thrift.Type.I64:
			return { type: 'I64', value: protocol.readI64() };
		case Thrift.Type.DOUBLE:
			return { type: 'DOUBLE', value: protocol.readDouble() };
		case Thrift.Type.STRING:
			return readStringField(protocol);
		case Thrift.Type.STRUCT:
			return { type: 'STRUCT', value: readStructFields(protocol) };
		case Thrift.Type.MAP: {
			const meta = protocol.readMapBegin();
			const kt = typeName(meta.ktype);
			const vt = typeName(meta.vtype);
			const entries: Array<{ key: DecodedField; value: DecodedField }> = [];
			for (let i = 0; i < meta.size; i++) {
				entries.push({ key: readField(protocol, meta.ktype), value: readField(protocol, meta.vtype) });
			}
			protocol.readMapEnd();
			return { type: 'MAP', value: entries, keyType: kt, valueType: vt };
		}
		case Thrift.Type.LIST: {
			const meta = protocol.readListBegin();
			const et = typeName(meta.etype);
			const values: DecodedField[] = [];
			for (let i = 0; i < meta.size; i++) {
				values.push(readField(protocol, meta.etype));
			}
			protocol.readListEnd();
			return { type: 'LIST', value: values, elemType: et };
		}
		case Thrift.Type.SET: {
			const meta = protocol.readSetBegin();
			const et = typeName(meta.etype);
			const values: DecodedField[] = [];
			for (let i = 0; i < meta.size; i++) {
				values.push(readField(protocol, meta.etype));
			}
			protocol.readSetEnd();
			return { type: 'SET', value: values, elemType: et };
		}
		default:
			protocol.skip(fieldType);
			return { type: `TYPE_${fieldType}`, value: '<skipped>' };
	}
}

function readStructFields(protocol: Protocol): Record<string, DecodedField> {
	const fields: Record<string, DecodedField> = {};
	protocol.readStructBegin();
	while (true) {
		const f = protocol.readFieldBegin();
		if (f.ftype === Thrift.Type.STOP) break;
		fields[String(f.fid)] = readField(protocol, f.ftype);
		protocol.readFieldEnd();
	}
	protocol.readStructEnd();
	return fields;
}

// ---- WRITE ----

function writeField(protocol: Protocol, field: DecodedField): void {
	switch (field.type) {
		case 'BOOL': protocol.writeBool(Boolean(field.value)); break;
		case 'BYTE': protocol.writeByte(Number(field.value)); break;
		case 'I16': protocol.writeI16(Number(field.value)); break;
		case 'I32': protocol.writeI32(Number(field.value)); break;
		case 'I64': protocol.writeI64(toInt64Value(field.value)); break;
		case 'DOUBLE': protocol.writeDouble(Number(field.value)); break;
		case 'STRING':
			if (field.isBinary) {
				protocol.writeBinary(Buffer.from(assertStringValue(field.value, 'Binary STRING field'), 'base64'));
			} else {
				protocol.writeString(assertStringValue(field.value, 'STRING field'));
			}
			break;
		case 'STRUCT':
			writeStructFields(protocol, field.value as Record<string, DecodedField>);
			break;
		case 'MAP': {
			const entries = field.value as Array<{ key: DecodedField; value: DecodedField }>;
			const ktype = TYPE_NUM[field.keyType ?? 'STRING'] ?? Thrift.Type.STRING;
			const vtype = TYPE_NUM[field.valueType ?? 'STRING'] ?? Thrift.Type.STRING;
			protocol.writeMapBegin(ktype, vtype, entries.length);
			for (const entry of entries) {
				writeField(protocol, entry.key);
				writeField(protocol, entry.value);
			}
			protocol.writeMapEnd();
			break;
		}
		case 'LIST': {
			const values = field.value as DecodedField[];
			const etype = TYPE_NUM[field.elemType ?? 'STRUCT'] ?? Thrift.Type.STRUCT;
			protocol.writeListBegin(etype, values.length);
			for (const v of values) writeField(protocol, v);
			protocol.writeListEnd();
			break;
		}
		case 'SET': {
			const values = field.value as DecodedField[];
			const etype = TYPE_NUM[field.elemType ?? 'STRUCT'] ?? Thrift.Type.STRUCT;
			protocol.writeSetBegin(etype, values.length);
			for (const v of values) writeField(protocol, v);
			protocol.writeSetEnd();
			break;
		}
	}
}

function writeStructFields(protocol: Protocol, fields: Record<string, DecodedField>): void {
	protocol.writeStructBegin('');
	for (const [fid, field] of Object.entries(fields)) {
		const ftype = TYPE_NUM[field.type];
		if (ftype === undefined) continue;
		protocol.writeFieldBegin('', ftype, parseInt(fid, 10));
		writeField(protocol, field);
		protocol.writeFieldEnd();
	}
	protocol.writeFieldStop();
	protocol.writeStructEnd();
}

export function encodeThriftBinaryMessage(msg: DecodedThriftMessage): Buffer {
	let result: Buffer | null = null;

	const transport = new ((thriftRuntime as Record<string, unknown>).TBufferedTransport as new (a: unknown, b: (buf: Buffer) => void) => unknown)(undefined, (buf: Buffer) => {
		result = buf;
	});

	const protocol = new ((thriftRuntime as Record<string, unknown>).TBinaryProtocol as new (t: unknown) => unknown)(transport) as Protocol;
	const mtype = MESSAGE_TYPE_NUM[msg.messageType] ?? 1;
	protocol.writeMessageBegin(msg.name, mtype, msg.sequenceId);
	writeStructFields(protocol, msg.fields);
	protocol.writeMessageEnd();

	(transport as Record<string, () => void>).flush();
	if (!result) throw new Error('encodeThriftBinaryMessage: flush produced no output');
	return result;
}

export function decodeThriftBinaryMessage(buffer: Buffer): DecodedThriftMessage {
	let decoded: DecodedThriftMessage | null = null;

	const receiver = ((thriftRuntime as Record<string, unknown>).TBufferedTransport as Record<string, (cb: (t: Record<string, unknown>) => void) => (buf: Buffer) => void>).receiver((transport: Record<string, unknown>) => {
		const protocol = new ((thriftRuntime as Record<string, unknown>).TBinaryProtocol as new (t: unknown) => unknown)(transport) as Protocol;
		const messageBegin = protocol.readMessageBegin();
		const fields = readStructFields(protocol);
		protocol.readMessageEnd();
		decoded = {
			name: messageBegin.fname,
			messageType: messageTypeName(messageBegin.mtype),
			sequenceId: messageBegin.rseqid,
			fields,
		};
	});

	(receiver as (buf: Buffer) => void)(buffer);

	if (!decoded) {
		throw new Error('Unable to decode Thrift message');
	}

	return decoded;
}

// ---- Typed decode/encode using @databricks/sql structs ----

// Maps message name → { CALL: req struct name, REPLY: resp struct name }
const TYPED_STRUCT_MAP: Record<string, { CALL: string; REPLY: string }> = {
	OpenSession:          { CALL: 'TOpenSessionReq',          REPLY: 'TOpenSessionResp' },
	CloseSession:         { CALL: 'TCloseSessionReq',         REPLY: 'TCloseSessionResp' },
	GetInfo:              { CALL: 'TGetInfoReq',              REPLY: 'TGetInfoResp' },
	GetCatalogs:          { CALL: 'TGetCatalogsReq',          REPLY: 'TGetCatalogsResp' },
	GetSchemas:           { CALL: 'TGetSchemasReq',           REPLY: 'TGetSchemasResp' },
	GetTables:            { CALL: 'TGetTablesReq',            REPLY: 'TGetTablesResp' },
	GetTableTypes:        { CALL: 'TGetTableTypesReq',        REPLY: 'TGetTableTypesResp' },
	GetColumns:           { CALL: 'TGetColumnsReq',           REPLY: 'TGetColumnsResp' },
	GetFunctions:         { CALL: 'TGetFunctionsReq',         REPLY: 'TGetFunctionsResp' },
	GetPrimaryKeys:       { CALL: 'TGetPrimaryKeysReq',       REPLY: 'TGetPrimaryKeysResp' },
	GetCrossReference:    { CALL: 'TGetCrossReferenceReq',    REPLY: 'TGetCrossReferenceResp' },
	ExecuteStatement:     { CALL: 'TExecuteStatementReq',     REPLY: 'TExecuteStatementResp' },
	GetOperationStatus:   { CALL: 'TGetOperationStatusReq',   REPLY: 'TGetOperationStatusResp' },
	CancelOperation:      { CALL: 'TCancelOperationReq',      REPLY: 'TCancelOperationResp' },
	CloseOperation:       { CALL: 'TCloseOperationReq',       REPLY: 'TCloseOperationResp' },
	GetResultSetMetadata: { CALL: 'TGetResultSetMetadataReq', REPLY: 'TGetResultSetMetadataResp' },
	FetchResults:         { CALL: 'TFetchResultsReq',         REPLY: 'TFetchResultsResp' },
};

export type TypedThriftMessage = {
	name: string;
	messageType: 'CALL' | 'REPLY' | 'EXCEPTION';
	sequenceId: number;
	struct: { read(p: unknown): void; write(p: unknown): void };
};

/**
 * Decode a Thrift binary message into a typed @databricks/sql struct.
 * The outer method-args (CALL) or method-result (REPLY) envelope is peeled;
 * the inner struct is returned fully populated.
 */
export function decodeTypedMessage(buffer: Buffer): TypedThriftMessage {
	let result: TypedThriftMessage | null = null;

	const receiver = (
		(thriftRuntime.TBufferedTransport as Record<string, (cb: (t: unknown) => void) => (buf: Buffer) => void>)
			.receiver
	)((transport) => {
		const p = new (thriftRuntime.TBinaryProtocol as new (t: unknown) => unknown)(transport) as Protocol;
		const msg = p.readMessageBegin();
		const fname = msg.fname;
		const mtype =
			msg.mtype === Thrift.MessageType.REPLY
				? 'REPLY'
				: msg.mtype === Thrift.MessageType.EXCEPTION
					? 'EXCEPTION'
					: 'CALL';

		if (mtype === 'EXCEPTION') {
			const exceptionFields = readStructFields(p);
			p.readMessageEnd();
			const struct = {
				read(_proto: unknown) {
					void _proto;
				},
				write(proto: unknown) {
					writeStructFields(proto as Protocol, exceptionFields);
				},
			};
			result = { name: fname, messageType: mtype, sequenceId: msg.rseqid, struct };
			return;
		}

		const structNames = TYPED_STRUCT_MAP[fname];
		if (!structNames) {
			throw new Error(`decodeTypedMessage: unknown method '${fname}'`);
		}
		const Ctor = ttypes[structNames[mtype]];
		if (!Ctor) {
			throw new Error(`decodeTypedMessage: no struct for ${fname} ${mtype}`);
		}

		// Peel outer envelope (CALL field 1 = req, REPLY field 0 = success)
		const outerFieldId = mtype === 'REPLY' ? 0 : 1;
		const struct = new Ctor();
		p.readStructBegin();
		while (true) {
			const f = p.readFieldBegin();
			if (f.ftype === Thrift.Type.STOP) break;
			if (f.ftype === Thrift.Type.STRUCT && f.fid === outerFieldId) {
				struct.read(p);
			} else {
				p.skip(f.ftype);
			}
			p.readFieldEnd();
		}
		p.readStructEnd();
		p.readMessageEnd();

		result = { name: fname, messageType: mtype, sequenceId: msg.rseqid, struct };
	});

	(receiver as (buf: Buffer) => void)(buffer);

	if (!result) throw new Error('decodeTypedMessage: no result produced');
	return result;
}
/**
 * Encode a TypedThriftMessage back to wire bytes.
 * Wraps the struct in the outer method-args/method-result envelope.
 */
export function encodeTypedMessage(msg: TypedThriftMessage): Buffer {
	let result: Buffer | null = null;

	const transport = new (
		thriftRuntime.TBufferedTransport as new (a: unknown, b: (buf: Buffer) => void) => unknown
	)(undefined, (buf: Buffer) => {
		result = buf;
	});

	const p = new (thriftRuntime.TBinaryProtocol as new (t: unknown) => unknown)(transport) as Protocol;
	const mtype =
		msg.messageType === 'REPLY'
			? Thrift.MessageType.REPLY
			: msg.messageType === 'EXCEPTION'
				? Thrift.MessageType.EXCEPTION
				: Thrift.MessageType.CALL;
	const outerFieldId = msg.messageType === 'REPLY' ? 0 : 1;

	p.writeMessageBegin(msg.name, mtype, msg.sequenceId);
	if (msg.messageType === 'EXCEPTION') {
		msg.struct.write(p);
		p.writeMessageEnd();
		(transport as Record<string, () => void>).flush();
		if (!result) throw new Error('encodeTypedMessage: flush produced no output');
		return result;
	}
	p.writeStructBegin('');
	p.writeFieldBegin('', Thrift.Type.STRUCT, outerFieldId);
	msg.struct.write(p);
	p.writeFieldEnd();
	p.writeFieldStop();
	p.writeStructEnd();
	p.writeMessageEnd();

	(transport as Record<string, () => void>).flush();
	if (!result) throw new Error('encodeTypedMessage: flush produced no output');
	return result;
}
