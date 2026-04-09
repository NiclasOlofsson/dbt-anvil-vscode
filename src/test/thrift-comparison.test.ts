/**
 * Side-by-side comparison: our generic decoder vs @databricks/sql typed structs.
 *
 * For each seed hex fixture, we decode using both approaches and assert that
 * key fields match, giving us confidence that our DecodedThriftMessage IR
 * faithfully represents the wire bytes.
 */
import { describe, it, expect } from 'vitest';
import thrift from 'thrift';
import { decodeThriftBinaryMessage } from '../metricserver/thrift-wire-decoder';


const ttypes = require('@databricks/sql/thrift/TCLIService_types') as {
	TOpenSessionResp: new () => {
		status: { statusCode: number };
		serverProtocolVersion: number;
		sessionHandle?: { sessionId: { guid: Buffer; secret: Buffer } };
		initialNamespace?: { catalogName?: string; schemaName?: string };
		canUseMultipleCatalogs?: boolean;
		getInfos?: unknown[];
		read(protocol: unknown): void;
	};
	TOpenSessionReq: new () => {
		client_protocol?: number;
		initialNamespace?: { catalogName?: string; schemaName?: string };
		canUseMultipleCatalogs?: boolean;
		read(protocol: unknown): void;
	};
	TGetInfoResp: new () => {
		status: { statusCode: number };
		infoValue?: { stringValue?: string };
		read(protocol: unknown): void;
	};
	TCloseSessionReq: new () => {
		sessionHandle?: unknown;
		read(protocol: unknown): void;
	};
};

const thriftRuntime = thrift as Record<string, unknown>;

const THRIFT_STOP = 0;
const THRIFT_STRUCT = 12;

type RawProtocol = {
	readMessageBegin(): unknown;
	readStructBegin(): void;
	readStructEnd(): void;
	readFieldBegin(): { fname: string; ftype: number; fid: number };
	readFieldEnd(): void;
	skip(ftype: number): void;
};

/**
 * Decode `buffer` using the @databricks/sql typed struct `Ctor`.
 *
 * Thrift binary REPLY messages have an outer method-result envelope:
 *   struct OpenSession_result { 0: TOpenSessionResp success; 1?: TException ... }
 * CALL messages have an outer method-args envelope:
 *   struct OpenSession_args { 1: TOpenSessionReq req; }
 *
 * `outerFieldId` selects which field to unwrap (0 = success/REPLY, 1 = first arg/CALL).
 */
function decodeWithDatabricks<T>(
	buffer: Buffer,
	Ctor: new () => T & { read(p: unknown): void },
	outerFieldId: number = 0,
): T {
	let result: T | null = null;

	const receiver = (
		(thriftRuntime.TBufferedTransport as Record<string, (cb: (t: unknown) => void) => (buf: Buffer) => void>)
			.receiver
	)((transport) => {
		const p = new (thriftRuntime.TBinaryProtocol as new (t: unknown) => unknown)(transport) as RawProtocol;
		p.readMessageBegin();
		p.readStructBegin(); // outer method-result / method-args struct
		while (true) {
			const { ftype, fid } = p.readFieldBegin();
			if (ftype === THRIFT_STOP) {
				break;
			}
			if (ftype === THRIFT_STRUCT && fid === outerFieldId) {
				const obj = new Ctor();
				obj.read(p);
				result = obj;
				p.readFieldEnd();
			} else {
				p.skip(ftype);
				p.readFieldEnd();
			}
		}
		p.readStructEnd();
	});

	(receiver as (buf: Buffer) => void)(buffer);

	if (!result) {
		throw new Error(`Databricks decode produced no result (outer field ${outerFieldId} not found)`);
	}
	return result;
}

// ─── hex fixtures (same as roundtrip seed cases) ───────────────────────────

const OPEN_SESSION_REPLY_HEX =
	'800100020000000b4f70656e53657373696f6e000000010c00000c000108000100000000000800020000a5070c00030c00010b00010000001001f1342cbf381c58abd5057d4e337d880b000200000010338d529d827246eb8482cb419466839d00000f05010c000000000c05040b00010000000e686976655f6d65746173746f72650b00020000000764656661756c7400020505010000';

const OPEN_SESSION_CALL_HEX =
	'800100010000000b4f70656e53657373696f6e000000010c00010800010000a5070d00040b0b0000000300000035737061726b2e7468726966747365727665722e6172726f774261736564526f775365742e74696d657374616d704173537472696e670000000566616c7365000000117573655f6361636865645f726573756c7400000004747275650000003c737061726b2e64617461627269636b732e73716c2e6d6574726963766965772e62692e636f6d7061746962696c6974796d6f64652e656e61626c656400000004747275650a0502000000000000a5070c05040b00020000000764656661756c7400020505010000';

const GET_INFO_REPLY_HEX =
	'8001000200000007476574496e666f000000010c00000c000108000100000000000c00020b000100000009537061726b2053514c000000';

const CLOSE_SESSION_CALL_HEX =
	'800100010000000c436c6f736553657373696f6e000000040c00010c00010c00010b00010000001001f1342cbf381c58abd5057d4e337d880b000200000010338d529d827246eb8482cb419466839d00000000';

// ─── tests ──────────────────────────────────────────────────────────────────

describe('Thrift decoder vs @databricks/sql typed structs', () => {
	describe('OpenSession REPLY', () => {
		const buf = Buffer.from(OPEN_SESSION_REPLY_HEX, 'hex');

		it('serverProtocolVersion matches', () => {
			const ours = decodeThriftBinaryMessage(buf);
			const theirs = decodeWithDatabricks(buf, ttypes.TOpenSessionResp);

			// ours: field 0 (outer struct) → field 2 (I32)
			const respFields = ours.fields['0'].value as Record<string, { value: unknown }>;
			expect(respFields['2'].value).toBe(theirs.serverProtocolVersion);
		});

		it('initialNamespace catalogName matches', () => {
			const ours = decodeThriftBinaryMessage(buf);
			const theirs = decodeWithDatabricks(buf, ttypes.TOpenSessionResp);

			const respFields = ours.fields['0'].value as Record<string, { value: unknown }>;
			// field 1284 → struct → field 1 = catalogName, field 2 = schemaName
			const ns = respFields['1284'].value as Record<string, { value: unknown }>;
			expect(ns['1'].value).toBe(theirs.initialNamespace?.catalogName);
			expect(ns['2'].value).toBe(theirs.initialNamespace?.schemaName);
		});

		it('getInfos list (empty) matches', () => {
			const ours = decodeThriftBinaryMessage(buf);
			const theirs = decodeWithDatabricks(buf, ttypes.TOpenSessionResp);

			const respFields = ours.fields['0'].value as Record<string, { value: unknown }>;
			const oursList = respFields['1281'].value as unknown[];
			expect(oursList.length).toBe(theirs.getInfos?.length ?? 0);
		});

		it('sessionHandle guid is 16 bytes in both', () => {
			const ours = decodeThriftBinaryMessage(buf);
			const theirs = decodeWithDatabricks(buf, ttypes.TOpenSessionResp);

			const respFields = ours.fields['0'].value as Record<string, { value: unknown }>;
			const sessionId = (respFields['3'].value as Record<string, { value: unknown }>)['1'].value as Record<string, { value: string; isBinary: boolean }>;
			const ourGuid = Buffer.from(sessionId['1'].value, 'base64');
			const theirGuid = theirs.sessionHandle?.sessionId.guid;

			expect(ourGuid.length).toBe(16);
			expect(theirGuid?.length).toBe(16);
			expect(ourGuid.toString('hex')).toBe(theirGuid?.toString('hex'));
		});
	});

	describe('OpenSession CALL', () => {
		const buf = Buffer.from(OPEN_SESSION_CALL_HEX, 'hex');

		it('clientProtocol matches', () => {
			const ours = decodeThriftBinaryMessage(buf);
			const theirs = decodeWithDatabricks(buf, ttypes.TOpenSessionReq, 1);

			// CALL: outer struct is at field '1' (first method arg)
			const reqFields = ours.fields['1'].value as Record<string, { value: unknown }>;
			// field 1: client_protocol (I32) — @databricks/sql uses snake_case
			expect(reqFields['1'].value).toBe(theirs.client_protocol);
		});

		it('initialNamespace schemaName matches', () => {
			const ours = decodeThriftBinaryMessage(buf);
			const theirs = decodeWithDatabricks(buf, ttypes.TOpenSessionReq, 1);

			const reqFields = ours.fields['1'].value as Record<string, { value: unknown }>;
			const ns = reqFields['1284'].value as Record<string, { value: unknown }>;
			expect(ns['2'].value).toBe(theirs.initialNamespace?.schemaName);
		});
	});

	describe('GetInfo REPLY', () => {
		const buf = Buffer.from(GET_INFO_REPLY_HEX, 'hex');

		it('stringValue matches', () => {
			const ours = decodeThriftBinaryMessage(buf);
			const theirs = decodeWithDatabricks(buf, ttypes.TGetInfoResp);

			const respFields = ours.fields['0'].value as Record<string, { value: unknown }>;
			// field 2: infoValue struct → field 1: stringValue
			const infoVal = respFields['2'].value as Record<string, { value: unknown }>;
			expect(infoVal['1'].value).toBe(theirs.infoValue?.stringValue);
		});
	});

	describe('CloseSession CALL', () => {
		const buf = Buffer.from(CLOSE_SESSION_CALL_HEX, 'hex');

		it('sessionHandle is present in both', () => {
			const ours = decodeThriftBinaryMessage(buf);
			const theirs = decodeWithDatabricks(buf, ttypes.TCloseSessionReq, 1);

			// CALL: outer struct is at field '1'
			const reqFields = ours.fields['1'].value as Record<string, { value: unknown }>;
			// field 1: sessionHandle struct present
			expect(reqFields['1']).toBeDefined();
			expect(theirs.sessionHandle).toBeDefined();
		});
	});
});
