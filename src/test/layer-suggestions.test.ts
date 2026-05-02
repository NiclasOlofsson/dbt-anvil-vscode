import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
	suggestFromFolders,
	suggestFromTags,
	suggestFromNamePrefixes,
	suggestAll,
	suggestEntries,
} from '../indexing/layer-suggestions';
import type { IndexedModel } from '../indexing/manifest-indexer';

const PROJECT = path.resolve('/repo/proj');

function mk(over: Partial<IndexedModel> & Pick<IndexedModel, 'name'>): IndexedModel {
	return {
		uniqueId: `model.pkg.${over.name}`,
		packageName: 'pkg',
		path: path.join(PROJECT, 'models', `${over.name}.sql`),
		tags: [],
		materialisation: 'view',
		...over,
	};
}

function atFolder(folder: string, name: string, extra: Partial<IndexedModel> = {}): IndexedModel {
	return mk({ name, path: path.join(PROJECT, folder, `${name}.sql`), ...extra });
}

describe('suggestFromFolders', () => {
	it('returns null for empty input', () => {
		expect(suggestFromFolders([], PROJECT)).toBeNull();
	});

	it('detects top-level model subfolders and orders medallion-style', () => {
		const models = [
			atFolder('models/staging', 'a'),
			atFolder('models/staging', 'b'),
			atFolder('models/marts', 'c'),
			atFolder('models/raw', 'd'),
		];
		const sug = suggestFromFolders(models, PROJECT);
		expect(sug).not.toBeNull();
		expect(sug!.layers.map(l => l.name)).toEqual(['raw', 'staging', 'marts']);
		expect(sug!.layers[0].match.folder).toBe('models/raw');
		expect(sug!.matched).toBe(4);
		expect(sug!.kind).toBe('folder');
	});

	it('returns null when only one layer folder', () => {
		const models = [atFolder('models/staging', 'a'), atFolder('models/staging', 'b')];
		expect(suggestFromFolders(models, PROJECT)).toBeNull();
	});

	it('returns null when too many folders (> 8)', () => {
		const models = Array.from({ length: 9 }, (_, i) => atFolder(`models/l${i}`, `m${i}`));
		expect(suggestFromFolders(models, PROJECT)).toBeNull();
	});
});

describe('suggestFromTags', () => {
	it('returns null with no tags', () => {
		expect(suggestFromTags([mk({ name: 'a' })])).toBeNull();
	});

	it('picks recognised medallion tags preferentially', () => {
		const models = [
			mk({ name: 'a', tags: ['bronze'] }),
			mk({ name: 'b', tags: ['silver'] }),
			mk({ name: 'c', tags: ['gold'] }),
			mk({ name: 'd', tags: ['random'] }),
		];
		const sug = suggestFromTags(models);
		expect(sug).not.toBeNull();
		expect(sug!.layers.map(l => l.name)).toEqual(['bronze', 'silver', 'gold']);
		expect(sug!.layers[0].match.tag).toBe('bronze');
	});

	it('returns null when coverage below 30%', () => {
		const models = [
			mk({ name: 'a', tags: ['bronze'] }),
			...Array.from({ length: 10 }, (_, i) => mk({ name: `x${i}` })),
		];
		expect(suggestFromTags(models)).toBeNull();
	});
});

describe('suggestFromNamePrefixes', () => {
	it('detects stg_/int_/fct_/dim_ convention', () => {
		const models = [
			...Array.from({ length: 4 }, (_, i) => mk({ name: `stg_a${i}` })),
			...Array.from({ length: 4 }, (_, i) => mk({ name: `int_b${i}` })),
			...Array.from({ length: 4 }, (_, i) => mk({ name: `fct_c${i}` })),
			...Array.from({ length: 4 }, (_, i) => mk({ name: `dim_d${i}` })),
		];
		const sug = suggestFromNamePrefixes(models);
		expect(sug).not.toBeNull();
		const names = sug!.layers.map(l => l.name);
		// medallion ordering: stg first, then int, then fct, then dim
		expect(names.indexOf('stg')).toBeLessThan(names.indexOf('int'));
		expect(names.indexOf('int')).toBeLessThan(names.indexOf('fct'));
		expect(sug!.layers[0].match.namePrefix).toMatch(/_$/);
	});

	it('returns null when fewer than 2 prefixes meet threshold', () => {
		const models = Array.from({ length: 10 }, (_, i) => mk({ name: `stg_x${i}` }));
		expect(suggestFromNamePrefixes(models)).toBeNull();
	});
});

describe('suggestAll', () => {
	it('returns suggestions in preference order when all fire', () => {
		const models = [
			...Array.from({ length: 4 }, (_, i) => atFolder('models/staging', `stg_a${i}`, { tags: ['bronze'] })),
			...Array.from({ length: 4 }, (_, i) => atFolder('models/marts', `fct_c${i}`, { tags: ['gold'] })),
			...Array.from({ length: 4 }, (_, i) => atFolder('models/marts', `dim_e${i}`, { tags: ['gold'] })),
		];
		const all = suggestAll(models, PROJECT);
		expect(all.map(s => s.kind)).toEqual(['folder', 'tag', 'namePrefix']);
	});

	it('returns empty array when nothing fires', () => {
		expect(suggestAll([mk({ name: 'x' })], PROJECT)).toEqual([]);
	});
});

describe('suggestEntries', () => {
	it('yields per-folder, per-tag, and per-prefix entries with match counts', () => {
		const models = [
			...Array.from({ length: 4 }, (_, i) => atFolder('models/staging', `stg_a${i}`, { tags: ['bronze'] })),
			...Array.from({ length: 4 }, (_, i) => atFolder('models/marts', `fct_c${i}`, { tags: ['gold'] })),
			...Array.from({ length: 4 }, (_, i) => atFolder('models/marts', `dim_e${i}`, { tags: ['gold'] })),
		];
		const entries = suggestEntries(models, PROJECT);
		expect(entries.length).toBeGreaterThan(0);

		const folderEntry = entries.find(e => e.kind === 'folder' && e.layer.name === 'staging');
		expect(folderEntry?.matched).toBe(4);

		const tagEntry = entries.find(e => e.kind === 'tag' && e.layer.name === 'gold');
		expect(tagEntry?.matched).toBe(8);

		const prefixEntry = entries.find(e => e.kind === 'namePrefix' && e.layer.name === 'fct');
		expect(prefixEntry?.matched).toBe(4);
		expect(prefixEntry?.layer.match.namePrefix).toBe('fct_');
	});
});
