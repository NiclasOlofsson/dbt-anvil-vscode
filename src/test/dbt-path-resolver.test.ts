import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { DbtPathResolver } from '../dbt/dbt-path-resolver';
import type { DbtProjectConfig } from '../dbt/manifest-types';

describe('DbtPathResolver', () => {
	const projectDir = '/project';

	it('uses default paths when config is undefined', () => {
		const resolver = new DbtPathResolver(projectDir);
		resolver.refresh(undefined);

		expect(resolver.paths.model).toEqual([path.join(projectDir, 'models')]);
		expect(resolver.paths.seed).toEqual([path.join(projectDir, 'seeds')]);
		expect(resolver.paths.analysis).toEqual([path.join(projectDir, 'analyses')]);
		expect(resolver.paths.snapshot).toEqual([path.join(projectDir, 'snapshots')]);
		expect(resolver.paths.test).toEqual([path.join(projectDir, 'tests')]);
		expect(resolver.paths.macro).toEqual([path.join(projectDir, 'macros')]);
	});

	it('resolves custom paths from config', () => {
		const config: DbtProjectConfig = {
			name: 'my_project',
			'model-paths': ['src/models', 'extra_models'],
			'analysis-paths': ['src/analyses'],
			'snapshot-paths': ['src/snapshots'],
			'test-paths': ['src/tests'],
			'macro-paths': ['src/macros'],
			'seed-paths': ['src/seeds'],
		};
		const resolver = new DbtPathResolver(projectDir);
		resolver.refresh(config);

		expect(resolver.paths.model).toEqual([path.join(projectDir, 'src/models'), path.join(projectDir, 'extra_models')]);
		expect(resolver.paths.analysis).toEqual([path.join(projectDir, 'src/analyses')]);
		expect(resolver.paths.snapshot).toEqual([path.join(projectDir, 'src/snapshots')]);
		expect(resolver.paths.test).toEqual([path.join(projectDir, 'src/tests')]);
		expect(resolver.paths.macro).toEqual([path.join(projectDir, 'src/macros')]);
		expect(resolver.paths.seed).toEqual([path.join(projectDir, 'src/seeds')]);
	});

	describe('classifyFile', () => {
		it('classifies model files', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			expect(resolver.classifyFile(path.join(projectDir, 'models', 'customers.sql'))).toBe('model');
			expect(resolver.classifyFile(path.join(projectDir, 'models', 'staging', 'stg_orders.sql'))).toBe('model');
		});

		it('classifies analysis files', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			expect(resolver.classifyFile(path.join(projectDir, 'analyses', 'ad_hoc.sql'))).toBe('analysis');
		});

		it('classifies snapshot files', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			expect(resolver.classifyFile(path.join(projectDir, 'snapshots', 'snap_orders.sql'))).toBe('snapshot');
		});

		it('classifies test files', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			expect(resolver.classifyFile(path.join(projectDir, 'tests', 'assert_positive.sql'))).toBe('test');
		});

		it('classifies macro files', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			expect(resolver.classifyFile(path.join(projectDir, 'macros', 'generate_schema_name.sql'))).toBe('macro');
		});

		it('classifies seed files', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			expect(resolver.classifyFile(path.join(projectDir, 'seeds', 'raw_data.csv'))).toBe('seed');
		});

		it('returns unknown for files outside dbt paths', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			expect(resolver.classifyFile(path.join(projectDir, 'scratch', 'query.sql'))).toBe('unknown');
			expect(resolver.classifyFile(path.join('/other', 'models', 'file.sql'))).toBe('unknown');
		});
	});

	describe('onPathsChanged', () => {
		it('fires when paths actually change', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			const listener = vi.fn();
			resolver.onPathsChanged(listener);

			resolver.refresh({ name: 'proj', 'model-paths': ['custom_models'] });
			expect(listener).toHaveBeenCalledOnce();
		});

		it('does not fire when paths are the same', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			const listener = vi.fn();
			resolver.onPathsChanged(listener);

			// Refresh with same defaults
			resolver.refresh(undefined);
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('selector builders', () => {
		it('buildSqlSelector returns filters for all dbt paths', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			const filters = resolver.buildSqlSelector();
			// 6 default dirs: models, seeds, analyses, snapshots, tests, macros
			expect(filters).toHaveLength(6);
			expect(filters.every(f => f.language === 'jinja-sql')).toBe(true);
		});

		it('buildModelSelector returns model + snapshot + seed paths', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			const filters = resolver.buildModelSelector();
			// 3 default dirs: models, snapshots, seeds
			expect(filters).toHaveLength(3);
		});

		it('buildYamlSelector includes dbt_project.yml', () => {
			const resolver = new DbtPathResolver(projectDir);
			resolver.refresh(undefined);

			const filters = resolver.buildYamlSelector();
			// 6 dirs * 2 languages (yaml + jinja-yaml) + 2 for dbt_project.yml = 14
			expect(filters).toHaveLength(14);
		});
	});
});
