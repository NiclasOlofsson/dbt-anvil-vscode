import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { SqllensDocumentParser } from '../../ftl/sqllens/document-parser';
import { runNinja, getRuleFixScopeById } from '../../ninja/engine';
import { coarseJinjaTokensFromText as tokenizeJinja } from '../../ftl/sqllens/extract/coarse-jinja';
import { reflowDocument } from '../../ninja/reflow/engine';
import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';
import { mockDocument } from './helpers';

const CONFIG_VARIANTS: Array<{ name: string; config: NinjaConfig }> = [
	{ name: 'default', config: DEFAULT_CONFIG },
	{
		name: 'alternate',
		config: {
			...DEFAULT_CONFIG,
			layout: { ...DEFAULT_CONFIG.layout, commaPosition: 'leading', operatorPosition: 'trailing' },
			convention: { ...DEFAULT_CONFIG.convention, unionStyle: 'distinct' },
		},
	},
];

const SAMPLES_ROOT = path.join(__dirname, '..', '..', '..', 'samples');

// The live parser (native sqllens), synchronous — no Pyodide boot.
const documentParser = new SqllensDocumentParser({ adapterType: 'duckdb' });

function findModelFiles(): string[] {
	const out: string[] = [];
	if (!fs.existsSync(SAMPLES_ROOT)) return out;
	for (const project of fs.readdirSync(SAMPLES_ROOT)) {
		const modelsDir = path.join(SAMPLES_ROOT, project, 'models');
		if (!fs.existsSync(modelsDir)) continue;
		walk(modelsDir, out);
	}
	return out;
}

function walk(dir: string, acc: string[]): void {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		const stat = fs.statSync(full);
		if (stat.isDirectory()) walk(full, acc);
		else if (entry.endsWith('.sql')) acc.push(full);
	}
}

describe('corpus parity', () => {
	const files = findModelFiles();

	if (files.length === 0) {
		it('no sample models found', () => {
			// Skip when samples are absent (e.g. CI without sample data).
		});
		return;
	}

	for (const variant of CONFIG_VARIANTS) {
		describe(`[config: ${variant.name}]`, () => {
			for (const file of files) {
				const label = path.relative(SAMPLES_ROOT, file);
				it(`formatter output is lint-clean: ${label}`, async () => {
					const sql = fs.readFileSync(file, 'utf8');
					const symbols = await documentParser.getDialectSymbols();
					const violationModel = await documentParser.parse(sql);
					const violationDoc   = mockDocument(sql);
					const reflow = reflowDocument(violationDoc, violationModel, variant.config, symbols);
					expect(
						reflow.edit,
						`reflowDocument returned null on ${label} (reason: ${reflow.reason ?? 'unknown'})`,
					).not.toBeNull();
					const formatted = reflow.edit!.newText;

					const outputModel = await documentParser.parse(formatted);
					const outputDoc   = mockDocument(formatted);
					const outputResult = runNinja(outputDoc, outputModel, tokenizeJinja(formatted), variant.config, symbols);
					const structural = outputResult.violations.filter(v => getRuleFixScopeById(v.rule) === 'structural');

					expect(
						structural.map(v => `${v.rule}@${v.range.start.line + 1}:${v.range.start.character + 1}`),
						`structural rules must be clean on formatter output of ${label} under config ${variant.name}`,
					).toEqual([]);
				});
			}
		});
	}
});
