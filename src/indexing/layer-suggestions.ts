/**
 * Heuristics that suggest a plausible `dbt-anvil.layers` config from an indexed project.
 * Pure functions — no VS Code dependency. Consumed by the settings completion provider
 * (and, if we ever want it, by a "Detect layers" command).
 */

import * as path from 'node:path';
import type { IndexedModel } from './manifest-indexer';
import type { LayerConfig } from './layer-classifier';

export type SuggestionKind = 'folder' | 'tag' | 'namePrefix';

export interface LayerSuggestion {
	kind: SuggestionKind;
	/** The proposed layers, in an order that makes medallion sense where possible. */
	layers: LayerConfig[];
	/** How many models would be classified by this suggestion. */
	matched: number;
	/** Total models considered (for coverage %). */
	total: number;
	/** Short human label, e.g. "folders: raw, staging, marts". */
	label: string;
}

/** Lower-cased tokens that signal a layer (used to order suggestions medallion-style). */
const MEDALLION_ORDER = [
	'source', 'sources',
	'raw', 'land', 'landing',
	'bronze',
	'stg', 'staging', 'stage',
	'silver',
	'int', 'intermediate',
	'gold',
	'fact', 'facts', 'dim', 'dims', 'dimensions', 'marts', 'mart',
	'agg', 'aggregates', 'metrics',
	'semantic', 'exposures',
];

/**
 * Sort a list of candidate names by medallion convention when possible.
 * Names matching `MEDALLION_ORDER` are ordered by their position there;
 * unknown names keep their original relative order, appended after the known ones.
 */
function sortMedallion<T>(items: T[], nameOf: (t: T) => string): T[] {
	const score = (name: string): number => {
		const lower = name.toLowerCase();
		const idx = MEDALLION_ORDER.indexOf(lower);
		if (idx >= 0) return idx;
		// Also accept prefixes like "stg_" → "stg"
		const head = lower.replace(/[_-].*$/, '');
		const headIdx = MEDALLION_ORDER.indexOf(head);
		return headIdx >= 0 ? headIdx : Number.MAX_SAFE_INTEGER;
	};
	return [...items]
		.map((item, origIdx) => ({ item, origIdx, score: score(nameOf(item)) }))
		.sort((a, b) => a.score - b.score || a.origIdx - b.origIdx)
		.map(x => x.item);
}

/**
 * Top-level folder heuristic: look for the dominant top-level directory under the
 * project (usually `models/`), then propose one layer per subdirectory.
 */
export function suggestFromFolders(models: IndexedModel[], projectDir: string): LayerSuggestion | null {
	if (models.length === 0) return null;

	// Bucket models by their top-level-subfolder under `models/` (or whichever root wins).
	// e.g. models at "models/staging/foo.sql" → bucket "staging".
	const buckets = new Map<string, { relFolder: string; count: number }>();
	for (const m of models) {
		const rel = path.relative(projectDir, m.path).replace(/\\/g, '/');
		const parts = rel.split('/').filter(Boolean);
		// Expect [models, <layer>, ...] — also tolerate [analyses, seeds, snapshots, tests] roots.
		if (parts.length < 2) continue;
		const rootsWeSkip = new Set(['models']);
		let idx = 0;
		while (idx < parts.length - 1 && rootsWeSkip.has(parts[idx].toLowerCase())) idx++;
		const layerName = parts[idx];
		if (!layerName) continue;
		const relFolder = parts.slice(0, idx + 1).join('/');
		const entry = buckets.get(layerName) ?? { relFolder, count: 0 };
		entry.count++;
		buckets.set(layerName, entry);
	}

	if (buckets.size < 2 || buckets.size > 8) return null;

	const layers = sortMedallion(
		[...buckets.entries()].map(([name, { relFolder, count }]) => ({ name, relFolder, count })),
		x => x.name,
	).map<LayerConfig>(({ name, relFolder }) => ({
		name,
		match: { folder: relFolder },
	}));

	const matched = [...buckets.values()].reduce((n, b) => n + b.count, 0);
	return {
		kind: 'folder',
		layers,
		matched,
		total: models.length,
		label: `folders: ${layers.map(l => l.name).join(', ')}`,
	};
}

/**
 * Tag heuristic: if ≥ 30% of models carry tags from a small recognised layer vocabulary
 * (or the most frequent tags form a small set), propose tag-based matchers.
 */
export function suggestFromTags(models: IndexedModel[]): LayerSuggestion | null {
	if (models.length === 0) return null;

	const counts = new Map<string, number>();
	for (const m of models) {
		for (const tag of m.tags) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	if (counts.size === 0) return null;

	// Prefer tags that are recognised layer vocabulary; fall back to top-N by frequency.
	const recognised = [...counts.entries()]
		.filter(([tag]) => MEDALLION_ORDER.includes(tag.toLowerCase()));

	const candidates = recognised.length >= 2
		? recognised
		: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

	if (candidates.length < 2) return null;

	const matched = candidates.reduce((n, [, c]) => n + c, 0);
	if (matched / models.length < 0.3) return null;

	const layers = sortMedallion(
		candidates.map(([tag, count]) => ({ name: tag, count })),
		x => x.name,
	).map<LayerConfig>(({ name }) => ({ name, match: { tag: name } }));

	return {
		kind: 'tag',
		layers,
		matched,
		total: models.length,
		label: `tags: ${layers.map(l => l.name).join(', ')}`,
	};
}

/**
 * Name-prefix heuristic: if a significant share of models follow a `{prefix}_` or
 * `{prefix}__` convention with 2–5 distinct prefixes, propose namePrefix matchers.
 */
export function suggestFromNamePrefixes(models: IndexedModel[]): LayerSuggestion | null {
	if (models.length === 0) return null;

	const counts = new Map<string, number>();
	for (const m of models) {
		const match = /^([a-z][a-z0-9]{1,5})[_]+/i.exec(m.name);
		if (!match) continue;
		const prefix = match[1].toLowerCase();
		counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
	}
	if (counts.size === 0) return null;

	// Keep prefixes that individually cover ≥ 5% of models and are plausibly layer-ish.
	const threshold = Math.max(3, Math.floor(models.length * 0.05));
	const candidates = [...counts.entries()]
		.filter(([, c]) => c >= threshold)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6);

	if (candidates.length < 2) return null;

	const matched = candidates.reduce((n, [, c]) => n + c, 0);
	if (matched / models.length < 0.3) return null;

	const layers = sortMedallion(
		candidates.map(([prefix, count]) => ({ name: prefix, count })),
		x => x.name,
	).map<LayerConfig>(({ name }) => ({
		name,
		match: { namePrefix: `${name}_` },
	}));

	return {
		kind: 'namePrefix',
		layers,
		matched,
		total: models.length,
		label: `name prefixes: ${layers.map(l => `${l.name}_`).join(', ')}`,
	};
}

/**
 * Run all heuristics and return them in preference order (folder > tag > namePrefix),
 * skipping those that don't trigger. Callers can expose the whole list as completion items.
 */
export function suggestAll(models: IndexedModel[], projectDir: string): LayerSuggestion[] {
	const out: LayerSuggestion[] = [];
	const folder = suggestFromFolders(models, projectDir);
	if (folder) out.push(folder);
	const tag = suggestFromTags(models);
	if (tag) out.push(tag);
	const prefix = suggestFromNamePrefixes(models);
	if (prefix) out.push(prefix);
	return out;
}

/**
 * Per-entry suggestions: for a user inserting a single new layer into an existing array,
 * offer the most common folders, tags, and name prefixes as individual matchers.
 */
export interface EntrySuggestion {
	kind: SuggestionKind;
	layer: LayerConfig;
	matched: number;
}

export function suggestEntries(models: IndexedModel[], projectDir: string): EntrySuggestion[] {
	const out: EntrySuggestion[] = [];
	const folderSug = suggestFromFolders(models, projectDir);
	if (folderSug) {
		for (const l of folderSug.layers) {
			out.push({ kind: 'folder', layer: l, matched: countForFolder(models, projectDir, l.match.folder ?? '') });
		}
	}
	const tagSug = suggestFromTags(models);
	if (tagSug) {
		for (const l of tagSug.layers) {
			out.push({ kind: 'tag', layer: l, matched: models.filter(m => m.tags.includes(l.match.tag ?? '')).length });
		}
	}
	const prefixSug = suggestFromNamePrefixes(models);
	if (prefixSug) {
		for (const l of prefixSug.layers) {
			const p = (l.match.namePrefix ?? '').toLowerCase();
			out.push({ kind: 'namePrefix', layer: l, matched: models.filter(m => m.name.toLowerCase().startsWith(p)).length });
		}
	}
	return out;
}

function countForFolder(models: IndexedModel[], projectDir: string, folder: string): number {
	const needle = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
	if (!needle) return 0;
	let n = 0;
	for (const m of models) {
		const rel = path.relative(projectDir, m.path).replace(/\\/g, '/').toLowerCase();
		if (rel === needle || rel.startsWith(needle + '/')) n++;
	}
	return n;
}
