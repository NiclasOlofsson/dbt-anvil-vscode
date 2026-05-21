import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { discoverFixtures, loadFixture } from './fixture-loader';
import { DEFAULT_CONFIG } from '../../ninja/config';

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-loader-'));
});
afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFixture(dir: string, files: Record<string, string>): void {
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), content, 'utf8');
	}
}

describe('fixture-loader', () => {
	it('loads a bare fixture (violation.sql + expected.sql, no config.json)', () => {
		const dir = path.join(tmpRoot, 'ninja.example.rule');
		writeFixture(dir, {
			'violation.sql': 'select 1',
			'expected.sql': 'select 1\n',
		});
		const fx = loadFixture(dir);
		expect(fx.ruleId).toBe('ninja.example.rule');
		expect(fx.variantName).toBeUndefined();
		expect(fx.violation).toBe('select 1');
		expect(fx.expected).toBe('select 1\n');
		expect(fx.config).toEqual(DEFAULT_CONFIG);
	});

	it('deep-merges config.json over DEFAULT_CONFIG', () => {
		const dir = path.join(tmpRoot, 'ninja.example.rule');
		writeFixture(dir, {
			'violation.sql': 'x',
			'expected.sql': 'x',
			'config.json': JSON.stringify({ layout: { commaPosition: 'leading' } }),
		});
		const fx = loadFixture(dir);
		expect(fx.config.layout.commaPosition).toBe('leading');
		// Other layout keys preserved from default
		expect(fx.config.layout.operatorPosition).toBe(DEFAULT_CONFIG.layout.operatorPosition);
	});

	it('throws when violation.sql is missing', () => {
		const dir = path.join(tmpRoot, 'ninja.example.rule');
		writeFixture(dir, { 'expected.sql': 'x' });
		expect(() => loadFixture(dir)).toThrow(/violation\.sql/);
	});

	it('throws when expected.sql is missing', () => {
		const dir = path.join(tmpRoot, 'ninja.example.rule');
		writeFixture(dir, { 'violation.sql': 'x' });
		expect(() => loadFixture(dir)).toThrow(/expected\.sql/);
	});

	it('discoverFixtures returns one fixture per bare rule directory', () => {
		const dir = path.join(tmpRoot, 'ninja.a');
		writeFixture(dir, { 'violation.sql': 'x', 'expected.sql': 'x' });
		const out = discoverFixtures(tmpRoot);
		expect(out).toHaveLength(1);
		expect(out[0].ruleId).toBe('ninja.a');
	});

	it('discoverFixtures expands shape subdirectories', () => {
		const ruleDir = path.join(tmpRoot, 'ninja.b');
		writeFixture(path.join(ruleDir, '01-close-paren'), { 'violation.sql': 'x', 'expected.sql': 'x' });
		writeFixture(path.join(ruleDir, '02-open-paren'),  { 'violation.sql': 'x', 'expected.sql': 'x' });
		const out = discoverFixtures(tmpRoot).filter(f => f.ruleId === 'ninja.b');
		expect(out).toHaveLength(2);
		expect(out.map(f => f.variantName).sort()).toEqual(['01-close-paren', '02-open-paren']);
	});

	it('discoverFixtures allows bare fixture AND shape subdirectories side by side', () => {
		const ruleDir = path.join(tmpRoot, 'ninja.c');
		writeFixture(ruleDir, { 'violation.sql': 'x', 'expected.sql': 'x' });
		writeFixture(path.join(ruleDir, '01-extra'), { 'violation.sql': 'x', 'expected.sql': 'x' });
		const out = discoverFixtures(tmpRoot).filter(f => f.ruleId === 'ninja.c');
		expect(out).toHaveLength(2);
		expect(out.map(f => f.variantName).sort()).toEqual(['01-extra', undefined] as any);
	});
});
