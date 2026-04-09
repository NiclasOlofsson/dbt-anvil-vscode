/* eslint-disable @typescript-eslint/no-explicit-any */

// Resolved lazily on first call — avoids import-order issues
let _types: any;
let _Thrift: any;

function ensureThrift(): void {
	if (_types === undefined) {
		_types = require('hive-driver/thrift/gen-nodejs/TCLIService_types');
		_Thrift = require('thrift').Thrift;
	}
}

type OpenSessionResponseArgs = {
	status: unknown;
	serverProtocolVersion: number;
	sessionHandle: unknown;
	configuration: Record<string, string> | null;
};

type NamespaceShape = { catalogName: string; schemaName?: string };

type OpenSessionRespWithVendorFields = {
	status: any;
	serverProtocolVersion: number;
	sessionHandle: any;
	configuration: Record<string, string> | null;
	getInfos: unknown[];
	initialNamespace: NamespaceShape;
};

export function createOpenSessionResponse(args: OpenSessionResponseArgs): OpenSessionRespWithVendorFields {
	ensureThrift();
	const response = new _types.TOpenSessionResp(args) as OpenSessionRespWithVendorFields;
	response.getInfos = [];
	response.initialNamespace = { catalogName: 'hive_metastore' };
	return response;
}

/**
 * Patches TOpenSessionResp.prototype.write to emit exactly what real Databricks
 * sends — confirmed from probe-compare.mjs wire capture:
 *
 *   field 1  status
 *   field 2  serverProtocolVersion = 42242
 *   field 3  sessionHandle
 *   field 4  configuration = empty map
 *   field 1281  getInfos = empty list
 *   field 1284  initialNamespace = { catalogName: "hive_metastore" }
 *
 * Nothing else. Field 1285 is NOT sent.
 */
export function patchOpenSessionResp(): void {
	ensureThrift();
	const T = _Thrift.Type;

	_types.TOpenSessionResp.prototype.write = function (output: any) {
		const self = this as OpenSessionRespWithVendorFields;
		output.writeStructBegin('TOpenSessionResp');

		if (self.status !== null && self.status !== undefined) {
			output.writeFieldBegin('status', T.STRUCT, 1);
			self.status.write(output);
			output.writeFieldEnd();
		}
		if (self.serverProtocolVersion !== null && self.serverProtocolVersion !== undefined) {
			output.writeFieldBegin('serverProtocolVersion', T.I32, 2);
			output.writeI32(self.serverProtocolVersion);
			output.writeFieldEnd();
		}
		if (self.sessionHandle !== null && self.sessionHandle !== undefined) {
			output.writeFieldBegin('sessionHandle', T.STRUCT, 3);
			self.sessionHandle.write(output);
			output.writeFieldEnd();
		}

		// field 4: configuration — only emit when explicitly provided
		if (self.configuration !== null && self.configuration !== undefined) {
			output.writeFieldBegin('configuration', T.MAP, 4);
			const configuration = self.configuration;
			output.writeMapBegin(T.STRING, T.STRING, Object.keys(configuration).length);
			for (const key of Object.keys(configuration)) {
				output.writeString(key);
				output.writeString(configuration[key]);
			}
			output.writeMapEnd();
			output.writeFieldEnd();
		}

		// field 1281: getInfos
		const getInfos = self.getInfos ?? [];
		output.writeFieldBegin('getInfos', T.LIST, 1281);
		output.writeListBegin(T.STRUCT, getInfos.length);
		for (const getInfo of getInfos as any[]) {
			getInfo.write(output);
		}
		output.writeListEnd();
		output.writeFieldEnd();

		// field 1284: initialNamespace
		const initialNamespace = self.initialNamespace ?? { catalogName: 'hive_metastore' };
		output.writeFieldBegin('initialNamespace', T.STRUCT, 1284);
		output.writeStructBegin('TNamespace');
		output.writeFieldBegin('catalogName', T.STRING, 1);
		output.writeString(initialNamespace.catalogName);
		output.writeFieldEnd();
		if (initialNamespace.schemaName !== undefined) {
			output.writeFieldBegin('schemaName', T.STRING, 2);
			output.writeString(initialNamespace.schemaName);
			output.writeFieldEnd();
		}
		output.writeFieldStop();
		output.writeStructEnd();
		output.writeFieldEnd();

		output.writeFieldStop();
		output.writeStructEnd();
	};
}
