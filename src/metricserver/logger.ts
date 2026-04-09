import fs from 'fs';
import type { DecodedThriftMessage, DecodedField } from './thrift-wire-decoder';

/* eslint-disable no-console */

// ---------------------------------------------------------------------------
// Schema observer — infers a .thrift IDL from live decoded messages
// ---------------------------------------------------------------------------

type FieldSchema = { id: number; type: string; isBinary?: boolean; elemType?: string; structRef?: string; example?: string };

export class SchemaObserver {
	private readonly structs = new Map<string, Map<number, FieldSchema>>();
	private readonly outPath: string;

	constructor(outPath: string) {
		this.outPath = outPath;
	}

	observe(msg: DecodedThriftMessage): void {
		const envelopeKey = msg.messageType === 'CALL' ? '1' : '0';
		const envelope = msg.fields[envelopeKey];
		if (!envelope?.value || typeof envelope.value !== 'object') return;
		const key = `T${msg.name}_${msg.messageType === 'CALL' ? 'args' : 'result'}`;
		this._observeFields(key, envelope.value as Record<string, DecodedField>);
		this._write();
	}

	private _observeFields(key: string, fields: Record<string, DecodedField>): void {
		if (!this.structs.has(key)) this.structs.set(key, new Map());
		const schema = this.structs.get(key)!;
		for (const [fieldId, decoded] of Object.entries(fields)) {
			const id = parseInt(fieldId, 10);
			if (!schema.has(id)) {
				schema.set(id, { id, type: decoded.type, isBinary: decoded.isBinary, elemType: decoded.elemType });
			}
			const entry = schema.get(id)!;
			if (entry.example === undefined) {
				entry.example = this._exampleValue(decoded);
			}
			if (decoded.type === 'STRUCT' && decoded.value && typeof decoded.value === 'object') {
				const nestedKey = `${key}_f${id}`;
				entry.structRef = nestedKey;
				this._observeFields(nestedKey, decoded.value as Record<string, DecodedField>);
			}
			if (decoded.type === 'LIST' && decoded.elemType === 'STRUCT') {
				const items = (decoded.value as Array<{ value: Record<string, DecodedField> }>);
				const nestedKey = `${key}_f${id}_item`;
				entry.structRef = nestedKey;
				for (const item of items) {
					if (item?.value && typeof item.value === 'object') {
						this._observeFields(nestedKey, item.value);
					}
				}
			}
		}
	}

	private _exampleValue(decoded: DecodedField): string {
		const v = decoded.value;
		if (v === null || v === undefined) return 'null';
		if (typeof v === 'bigint') return v.toString();
		if (Buffer.isBuffer(v)) return `<binary ${v.length}b>`;
		if (typeof v === 'string') {
			const truncated = v.length > 60 ? v.slice(0, 60) + '…' : v;
			return JSON.stringify(truncated);
		}
		if (typeof v === 'number' || typeof v === 'boolean') return String(v);
		if (Array.isArray(v)) return `[${v.length} items]`;
		if (typeof v === 'object') return '{struct}';
		return String(v);
	}

	private _fieldType(f: FieldSchema, parentKey: string): string {
		if (f.type === 'STRUCT') return f.structRef ?? `${parentKey}_f${f.id}`;
		if (f.type === 'LIST') {
			const elem = f.elemType === 'STRUCT'
				? (f.structRef ?? `${parentKey}_f${f.id}_item`)
				: (f.elemType?.toLowerCase() ?? 'binary');
			return `list<${elem}>`;
		}
		if (f.type === 'MAP') return 'map<string, string>';
		if (f.type === 'STRING') return f.isBinary ? 'binary' : 'string';
		return f.type?.toLowerCase() ?? 'binary';
	}

	private _write(): void {
		const allKeys = [...this.structs.keys()];
		// Deepest-nested structs first
		allKeys.sort((a, b) => b.split('_').length - a.split('_').length || a.localeCompare(b));

		const emitted = new Set<string>();
		const blocks: string[] = ['// Auto-generated from live proxy traffic — DO NOT EDIT', ''];

		for (const key of allKeys) {
			if (emitted.has(key)) continue;
			emitted.add(key);
			const schema = this.structs.get(key)!;
			const lines = [`struct ${key} {`];
			for (const [, f] of [...schema.entries()].sort((a, b) => a[0] - b[0])) {
				lines.push(`  ${f.id}: optional ${this._fieldType(f, key)} field_${f.id},${f.example !== undefined ? `  // ${f.example}` : ''}`);
			}
			lines.push('}');
			blocks.push(lines.join('\n'));
		}

		// Service block
		const names = new Set<string>();
		for (const key of this.structs.keys()) {
			const m = key.match(/^T(\w+?)_(args|result)$/);
			if (m) names.add(m[1]);
		}
		const serviceLines = ['', 'service TCLIService {'];
		for (const name of [...names].sort()) {
			const hasArgs = this.structs.has(`T${name}_args`);
			const hasResult = this.structs.has(`T${name}_result`);
			const ret = hasResult ? `T${name}_result` : 'void';
			const arg = hasArgs ? `1: T${name}_args req` : '';
			serviceLines.push(`  ${ret} ${name}(${arg}),`);
		}
		serviceLines.push('}');
		blocks.push(serviceLines.join('\n'));

		fs.writeFileSync(this.outPath, blocks.join('\n\n'), 'utf8');
	}
}

/**
 * Deterministic JSON view of a Thrift message object.
 * - Never mutates the input object
 * - Works for both incoming and outgoing message objects
 * - Converts Buffers to hex and bigint to string
 * - Drops function-valued fields (e.g. generated write/read methods)
 */
export function thriftToJson(obj: unknown): unknown {
	const seen = new WeakSet<object>();

	const walk = (value: unknown): unknown => {
		if (value === null || value === undefined) return value;
		if (typeof value === 'bigint') return value.toString();
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;

		if (Buffer.isBuffer(value)) {
			return value.toString('hex');
		}

		if (Array.isArray(value)) {
			return value.map(walk);
		}

		if (typeof value === 'object') {
			const objValue = value as Record<string, unknown>;
			if (objValue.type === 'Buffer' && Array.isArray(objValue.data)) {
				return Buffer.from(objValue.data as number[]).toString('hex');
			}

			if (seen.has(objValue)) {
				return '[Circular]';
			}
			seen.add(objValue);

			const out: Record<string, unknown> = {};
			for (const key of Object.keys(objValue)) {
				const v = objValue[key];
				if (typeof v === 'function') continue;
				out[key] = walk(v);
			}
			return out;
		}

		return String(value);
	};

	return walk(obj);
}

export function bufferReplacer(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (value !== null && typeof value === 'object' && (value as {type?: string}).type === 'Buffer' && Array.isArray((value as {data?: unknown}).data)) {
		return Buffer.from((value as {data: number[]}).data).toString('hex');
	}
	return value;
}

export class MetricLogger {
	private readonly logFile: string | undefined;

	constructor(logFile?: string) {
		this.logFile = logFile;
		if (logFile) {
			fs.writeFileSync(logFile, '', 'utf8'); // truncate on start
		}
	}

	info(msg: string): void {
		this._write(`INFO ${msg}`);
	}

	debug(msg: string): void {
		this._write(`DEBUG ${msg}`);
	}

	warn(msg: string): void {
		this._write(`WARN ${msg}`);
	}

	error(msg: string): void {
		this._write(`ERROR ${msg}`);
	}

	private _write(msg: string): void {
		const line = `${new Date().toISOString()} ${msg}`;
		console.log(line);
		if (this.logFile) {
			fs.appendFileSync(this.logFile, line + '\n', 'utf8');
		}
	}
}
