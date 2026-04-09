import { describe, it, expect } from 'vitest';
import { decodeThriftBinaryMessage, encodeThriftBinaryMessage } from '../metricserver/thrift-wire-decoder';
import { OpenSessionResponse, decodeReplyEnvelope, encodeReplyEnvelope } from '../metricserver/messages';

const SEED_HEX = '800100020000000b4f70656e53657373696f6e000000010c00000c000108000100000000000800020000a5070c00030c00010b00010000001001f1342cbf381c58abd5057d4e337d880b000200000010338d529d827246eb8482cb419466839d00000f05010c000000000c05040b00010000000e686976655f6d65746173746f72650b00020000000764656661756c7400020505010000';

describe('OpenSessionResponse.decode', () => {
	it('parses decoded thrift into typed OpenSessionResponse', () => {
		const envelope = decodeReplyEnvelope(decodeThriftBinaryMessage(Buffer.from(SEED_HEX, 'hex')));
		const msg = OpenSessionResponse.decode(envelope);

		expect(msg.sequenceId).toBe(1);
		expect(msg.status.statusCode).toBe(0);
		expect(msg.serverProtocolVersion).toBe(42247);
		expect(msg.sessionHandle.sessionId.guid).toHaveLength(16);
		expect(msg.sessionHandle.sessionId.secret).toHaveLength(16);
		expect(msg.getInfos).toEqual([]);
		expect(msg.initialNamespace.catalogName).toBe('hive_metastore');
		expect(msg.initialNamespace.schemaName).toBe('default');
		expect(msg.canUseMultipleCatalogs).toBe(true);
	});
});

describe('OpenSessionResponse.encode', () => {
	it('encodes a typed OpenSessionResponse back to the seed hex', () => {
		const encoded = encodeThriftBinaryMessage(encodeReplyEnvelope(OpenSessionResponse.encode({
			sequenceId: 1,
			status: { statusCode: 0 },
			serverProtocolVersion: 42247,
			sessionHandle: {
				sessionId: {
					guid: Buffer.from('AfE0LL84HFir1QV9TjN9iA==', 'base64'),
					secret: Buffer.from('M41SnYJyRuuEgstBlGaDnQ==', 'base64'),
				},
			},
			getInfos: [],
			initialNamespace: { catalogName: 'hive_metastore', schemaName: 'default' },
			canUseMultipleCatalogs: true,
		})));

		expect(encoded.toString('hex')).toBe(SEED_HEX);
	});
});
