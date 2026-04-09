import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeThriftBinaryMessage, encodeThriftBinaryMessage, decodeTypedMessage, encodeTypedMessage } from '../metricserver/thrift-wire-decoder';


type RoundtripCase = {
	name: string;
	messageType: string;
	hex: string;
};

const seedCases: RoundtripCase[] = [
	{
		name: 'OpenSession',
		messageType: 'REPLY',
		hex: '800100020000000b4f70656e53657373696f6e000000010c00000c000108000100000000000800020000a5070c00030c00010b00010000001001f1342cbf381c58abd5057d4e337d880b000200000010338d529d827246eb8482cb419466839d00000f05010c000000000c05040b00010000000e686976655f6d65746173746f72650b00020000000764656661756c7400020505010000',
	},
	{
		name: 'OpenSession',
		messageType: 'CALL',
		hex: '800100010000000b4f70656e53657373696f6e000000010c00010800010000a5070d00040b0b0000000300000035737061726b2e7468726966747365727665722e6172726f774261736564526f775365742e74696d657374616d704173537472696e670000000566616c7365000000117573655f6361636865645f726573756c7400000004747275650000003c737061726b2e64617461627269636b732e73716c2e6d6574726963766965772e62692e636f6d7061746962696c6974796d6f64652e656e61626c656400000004747275650a0502000000000000a5070c05040b00020000000764656661756c7400020505010000',
	},
	{
		name: 'GetInfo',
		messageType: 'REPLY',
		hex: '8001000200000007476574496e666f000000010c00000c000108000100000000000c00020b000100000009537061726b2053514c000000',
	},
	{
		name: 'GetInfo',
		messageType: 'CALL',
		hex: '8001000100000007476574496e666f000000020c00010c00010c00010b00010000001001f1342cbf381c58abd5057d4e337d880b000200000010338d529d827246eb8482cb419466839d0000080002000000110000',
	},
	{
		name: 'GetCatalogs',
		messageType: 'CALL',
		hex: '800100010000000b476574436174616c6f6773000000010c00010c00010c00010b00010000001001f1342cbf381c58abd5057d4e337d880b000200000010338d529d827246eb8482cb419466839d00000c05010a0001000000000007a1200a00020000000000a0000000020502000000',
	},
	{
		name: 'CloseSession',
		messageType: 'CALL',
		hex: '800100010000000c436c6f736553657373696f6e000000040c00010c00010c00010b00010000001001f1342cbf381c58abd5057d4e337d880b000200000010338d529d827246eb8482cb419466839d00000000',
	},
];

const variantsPath = path.join(__dirname, 'fixtures', 'metricserver-roundtrip-variants.json');
const logCases: RoundtripCase[] = JSON.parse(fs.readFileSync(variantsPath, 'utf8')) as RoundtripCase[];

const dedupedCases: RoundtripCase[] = [];
const seenHex = new Set<string>();
for (const testCase of [...seedCases, ...logCases]) {
	if (seenHex.has(testCase.hex)) {
		continue;
	}
	seenHex.add(testCase.hex);
	dedupedCases.push(testCase);
}

const variantCounter = new Map<string, number>();

describe('Thrift Binary Roundtrip with Real Proxy Data', () => {
	for (const testCase of dedupedCases) {
		const groupKey = `${testCase.name}:${testCase.messageType}`;
		const nextCount = (variantCounter.get(groupKey) ?? 0) + 1;
		variantCounter.set(groupKey, nextCount);

		it(`${testCase.name} ${testCase.messageType} variant ${nextCount}: hex matches after encode/decode/encode cycle`, () => {
			const buffer = Buffer.from(testCase.hex, 'hex');
			const decoded = decodeThriftBinaryMessage(buffer);
			const reEncoded = encodeThriftBinaryMessage(decoded);
			expect(reEncoded.toString('hex')).toBe(testCase.hex);
		});
	}
});

describe('Thrift Binary decode session response to model', () => {
	it('decodes OpenSession REPLY into raw DecodedThriftMessage fields', () => {
		const hex = '800100020000000b4f70656e53657373696f6e000000010c00000c000108000100000000000800020000a5070c00030c00010b00010000001001f1342cbf381c58abd5057d4e337d880b000200000010338d529d827246eb8482cb419466839d00000f05010c000000000c05040b00010000000e686976655f6d65746173746f72650b00020000000764656661756c7400020505010000';
		const decoded = decodeThriftBinaryMessage(Buffer.from(hex, 'hex'));

		expect(decoded.name).toBe('OpenSession');
		expect(decoded.messageType).toBe('REPLY');
		expect(decoded.sequenceId).toBe(1);

		const resp = decoded.fields['0'].value as Record<string, { value: unknown; type: string; isBinary?: boolean }>;

		// field 2: serverProtocolVersion (I32)
		expect(resp['2'].value).toBe(42247);

		// field 3: sessionHandle — sessionId guid and secret are 16-byte binary blobs
		const sessionId = (resp['3'].value as Record<string, { value: unknown }>)['1'].value as Record<string, { value: unknown; isBinary?: boolean }>;
		expect(sessionId['1'].isBinary).toBe(true);
		expect(Buffer.from(sessionId['1'].value as string, 'base64')).toHaveLength(16);
		expect(sessionId['2'].isBinary).toBe(true);
		expect(Buffer.from(sessionId['2'].value as string, 'base64')).toHaveLength(16);

		// field 1281: getInfos (empty list in seed hex)
		expect(resp['1281'].type).toBe('LIST');
		expect((resp['1281'].value as unknown[]).length).toBe(0);

		// field 1284: initialNamespace
		const ns = resp['1284'].value as Record<string, { value: unknown }>;
		expect(ns['1'].value).toBe('hive_metastore');
		expect(ns['2'].value).toBe('default');
	});
});

describe('Thrift Binary encode session response from model', () => {
	it('encodes a hand-built DecodedThriftMessage back to the seed hex', () => {
		const model = {
			name: 'OpenSession',
			messageType: 'REPLY',
			sequenceId: 1,
			fields: {
				'0': {
					type: 'STRUCT',
					value: {
						'1': { type: 'STRUCT', value: { '1': { type: 'I32', value: 0 } } },
						'2': { type: 'I32', value: 42247 },
						'3': {
							type: 'STRUCT',
							value: {
								'1': {
									type: 'STRUCT',
									value: {
										'1': { type: 'STRING', value: 'AfE0LL84HFir1QV9TjN9iA==', isBinary: true },
										'2': { type: 'STRING', value: 'M41SnYJyRuuEgstBlGaDnQ==', isBinary: true },
									},
								},
							},
						},
						'1281': { type: 'LIST', elemType: 'STRUCT', value: [] },
						'1284': {
							type: 'STRUCT',
							value: {
								'1': { type: 'STRING', value: 'hive_metastore' },
								'2': { type: 'STRING', value: 'default' },
							},
						},
						'1285': { type: 'BOOL', value: true },
					},
				},
			},
		};

		const encoded = encodeThriftBinaryMessage(model);
		expect(encoded.toString('hex')).toBe('800100020000000b4f70656e53657373696f6e000000010c00000c000108000100000000000800020000a5070c00030c00010b00010000001001f1342cbf381c58abd5057d4e337d880b000200000010338d529d827246eb8482cb419466839d00000f05010c000000000c05040b00010000000e686976655f6d65746173746f72650b00020000000764656661756c7400020505010000');
	});
});

describe('Typed struct roundtrip (decodeTypedMessage → encodeTypedMessage)', () => {
	for (const testCase of dedupedCases) {
		it(`${testCase.name} ${testCase.messageType}: typed roundtrip preserves all fields`, () => {
			const buf = Buffer.from(testCase.hex, 'hex');
			const typed = decodeTypedMessage(buf);
			const reEncoded = encodeTypedMessage(typed);
			const originalSum = [...buf].reduce((a, b) => a + b, 0);
			const reEncodedSum = [...reEncoded].reduce((a, b) => a + b, 0);
			expect(reEncodedSum).toBe(originalSum);
			expect(buf).toEqual(reEncoded);
		});
	}
});
