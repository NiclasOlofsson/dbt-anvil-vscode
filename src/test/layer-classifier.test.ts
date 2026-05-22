import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { classifyLayer, validateLayerConfig, type LayerConfig } from '../indexing/layer-classifier';
import type { IndexedModel } from '../indexing/manifest-indexer';

const PROJECT_DIR = path.resolve('/repo/proj');

function model(overrides: Partial<IndexedModel> & Pick<IndexedModel, 'name'>): IndexedModel {
	return {
		uniqueId: `model.pkg.${overrides.name}`,
		packageName: 'pkg',
		path: path.join(PROJECT_DIR, 'models', `${overrides.name}.sql`),
		tags: [],
		materialisation: 'view',
		...overrides,
	};
}

describe('classifyLayer', () => {
	const ctx = { projectDir: PROJECT_DIR };

	it('returns undefined when no layers configured', () => {
		expect(classifyLayer(model({ name: 'x' }), [], ctx)).toBeUndefined();
	});

	it('classifies by folder prefix', () => {
		const layers: LayerConfig[] = [{ name: 'gold', match: { folder: 'models/gold' } }];
		const m = model({ name: 'fct', path: path.join(PROJECT_DIR, 'models/gold/fct.sql') });
		expect(classifyLayer(m, layers, ctx)).toEqual({ name: 'gold', index: 0 });
	});

	it('folder match is case-insensitive and tolerates trailing slash', () => {
		const layers: LayerConfig[] = [{ name: 'gold', match: { folder: 'MODELS/Gold/' } }];
		const m = model({ name: 'fct', path: path.join(PROJECT_DIR, 'models/gold/fct.sql') });
		expect(classifyLayer(m, layers, ctx)?.name).toBe('gold');
	});

	it('folder match must respect directory boundaries', () => {
		// "models/gold" must NOT match "models/golden/..." — segment boundary.
		const layers: LayerConfig[] = [{ name: 'gold', match: { folder: 'models/gold' } }];
		const m = model({ name: 'x', path: path.join(PROJECT_DIR, 'models/golden/x.sql') });
		expect(classifyLayer(m, layers, ctx)).toBeUndefined();
	});

	it('classifies by tag', () => {
		const layers: LayerConfig[] = [{ name: 'bronze', match: { tag: 'bronze' } }];
		expect(classifyLayer(model({ name: 'x', tags: ['bronze', 'pii'] }), layers, ctx)?.name).toBe('bronze');
		expect(classifyLayer(model({ name: 'x', tags: ['other'] }), layers, ctx)).toBeUndefined();
	});

	it('classifies by name prefix (case-insensitive)', () => {
		const layers: LayerConfig[] = [{ name: 'silver', match: { namePrefix: 'slv_' } }];
		expect(classifyLayer(model({ name: 'SLV_orders' }), layers, ctx)?.name).toBe('silver');
		expect(classifyLayer(model({ name: 'other' }), layers, ctx)).toBeUndefined();
	});

	it('classifies by name regex', () => {
		const layers: LayerConfig[] = [{ name: 'stg', match: { nameRegex: '^stg__' } }];
		expect(classifyLayer(model({ name: 'stg__orders' }), layers, ctx)?.name).toBe('stg');
		expect(classifyLayer(model({ name: 'fct_orders' }), layers, ctx)).toBeUndefined();
	});

	it('classifies by materialization', () => {
		const layers: LayerConfig[] = [{ name: 'inc', match: { materialization: 'incremental' } }];
		expect(classifyLayer(model({ name: 'x', materialisation: 'incremental' }), layers, ctx)?.name).toBe('inc');
		expect(classifyLayer(model({ name: 'y', materialisation: 'view' }), layers, ctx)).toBeUndefined();
	});

	it('combines leaf fields with implicit AND', () => {
		const layers: LayerConfig[] = [
			{ name: 'gold_pii', match: { folder: 'models/gold', tag: 'pii' } },
		];
		const hit = model({ name: 'x', path: path.join(PROJECT_DIR, 'models/gold/x.sql'), tags: ['pii'] });
		const missTag = model({ name: 'x', path: path.join(PROJECT_DIR, 'models/gold/x.sql'), tags: [] });
		expect(classifyLayer(hit, layers, ctx)?.name).toBe('gold_pii');
		expect(classifyLayer(missTag, layers, ctx)).toBeUndefined();
	});

	it('supports `any` for OR', () => {
		const layers: LayerConfig[] = [
			{ name: 'gold', match: { any: [{ folder: 'models/gold' }, { tag: 'gold' }] } },
		];
		const byFolder = model({ name: 'x', path: path.join(PROJECT_DIR, 'models/gold/x.sql') });
		const byTag = model({ name: 'y', tags: ['gold'] });
		const neither = model({ name: 'z' });
		expect(classifyLayer(byFolder, layers, ctx)?.name).toBe('gold');
		expect(classifyLayer(byTag, layers, ctx)?.name).toBe('gold');
		expect(classifyLayer(neither, layers, ctx)).toBeUndefined();
	});

	it('supports `all` for explicit AND over combinators', () => {
		const layers: LayerConfig[] = [
			{
				name: 'gold_pii',
				match: {
					all: [
						{ any: [{ folder: 'models/gold' }, { tag: 'gold' }] },
						{ tag: 'pii' },
					],
				},
			},
		];
		const hit = model({ name: 'x', tags: ['gold', 'pii'] });
		const missPii = model({ name: 'y', tags: ['gold'] });
		expect(classifyLayer(hit, layers, ctx)?.name).toBe('gold_pii');
		expect(classifyLayer(missPii, layers, ctx)).toBeUndefined();
	});

	it('first match wins — order matters', () => {
		const layers: LayerConfig[] = [
			{ name: 'gold', match: { folder: 'models/gold' } },
			{ name: 'pii', match: { tag: 'pii' } },
		];
		const m = model({ name: 'x', path: path.join(PROJECT_DIR, 'models/gold/x.sql'), tags: ['pii'] });
		const result = classifyLayer(m, layers, ctx);
		expect(result).toEqual({ name: 'gold', index: 0 });
	});

	it('returns the correct ordinal index', () => {
		const layers: LayerConfig[] = [
			{ name: 'raw',    match: { folder: 'models/raw' } },
			{ name: 'bronze', match: { tag: 'bronze' } },
			{ name: 'silver', match: { namePrefix: 'slv_' } },
			{ name: 'gold',   match: { folder: 'models/gold' } },
		];
		expect(classifyLayer(model({ name: 'slv_x' }), layers, ctx)?.index).toBe(2);
		expect(classifyLayer(model({ name: 'y', path: path.join(PROJECT_DIR, 'models/gold/y.sql') }), layers, ctx)?.index).toBe(3);
	});

	it('invalid nameRegex silently fails the match (does not throw)', () => {
		const layers: LayerConfig[] = [{ name: 'bad', match: { nameRegex: '([unclosed' } }];
		expect(() => classifyLayer(model({ name: 'x' }), layers, ctx)).not.toThrow();
		expect(classifyLayer(model({ name: 'x' }), layers, ctx)).toBeUndefined();
	});
});

describe('validateLayerConfig', () => {
	it('accepts a valid config', () => {
		const cfg = [
			{ name: 'raw', match: { folder: 'models/raw' } },
			{ name: 'gold', match: { any: [{ folder: 'models/gold' }, { tag: 'gold' }] } },
		];
		expect(validateLayerConfig(cfg)).toEqual([]);
	});

	it('rejects non-array root', () => {
		expect(validateLayerConfig({} as unknown)).toContain('dbt-studio.layers must be an array');
	});

	it('flags duplicate names', () => {
		const errors = validateLayerConfig([
			{ name: 'x', match: { tag: 'a' } },
			{ name: 'x', match: { tag: 'b' } },
		]);
		expect(errors.join(' ')).toMatch(/duplicate layer name "x"/);
	});

	it('flags empty matcher', () => {
		const errors = validateLayerConfig([{ name: 'x', match: {} }]);
		expect(errors.join(' ')).toMatch(/at least one of/);
	});

	it('flags invalid regex', () => {
		const errors = validateLayerConfig([{ name: 'x', match: { nameRegex: '([unclosed' } }]);
		expect(errors.join(' ')).toMatch(/invalid regex/);
	});

	it('recurses into any/all', () => {
		const errors = validateLayerConfig([
			{ name: 'x', match: { any: [{}] } },
		]);
		expect(errors.join(' ')).toMatch(/layers\[0\]\.match\.any\[0\]/);
	});
});
