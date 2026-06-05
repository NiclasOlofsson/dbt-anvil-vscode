/**
 * Layer classification — dbt Anvil-local concept.
 *
 * Users configure an ordered list of "layers" (e.g. raw → bronze → silver → gold → marts)
 * via `dbt-anvil.layers`. Each layer has a name and a matcher that decides whether a given
 * model belongs to it. Order defines ordinality — index 0 is the upstream-most layer.
 *
 * This is purely an indexer-side enrichment. We never write it to manifest.json and never
 * pass it to the dbt CLI.
 */

import * as path from 'node:path';
import type { IndexedModel } from './manifest-indexer';

/**
 * A single layer definition. `match` decides membership; the layer's position in the
 * configured array defines its ordinal `index`.
 */
export interface LayerConfig {
	name: string;
	match: LayerMatcher;
}

/**
 * Matcher DSL. All fields are optional; combine via `any` / `all`.
 *
 * - `folder`: glob-ish folder prefix relative to the project dir (e.g. "models/gold").
 *   Case-insensitive, matches if the model's file path begins with this segment.
 * - `namePrefix`: model name starts with this (case-insensitive).
 * - `nameRegex`: model name matches this regex. Anchored by the user if they want it anchored.
 * - `tag`: model has this tag (exact match).
 * - `meta`: raw node `meta.<key>` equals the given value. Not yet wired — placeholder.
 * - `materialization`: matches the model's materialization (e.g. "incremental").
 * - `any`: OR over nested matchers.
 * - `all`: AND over nested matchers.
 */
export interface LayerMatcher {
	folder?: string;
	namePrefix?: string;
	nameRegex?: string;
	tag?: string;
	materialization?: string;
	any?: LayerMatcher[];
	all?: LayerMatcher[];
}

export interface LayerInfo {
	name: string;
	index: number;
}

export interface ClassifyContext {
	projectDir: string;
}

/**
 * Classify a single model against the configured layers. First-match-wins, top-down.
 * Returns undefined if no layer matches.
 */
export function classifyLayer(
	model: IndexedModel,
	layers: LayerConfig[],
	ctx: ClassifyContext,
): LayerInfo | undefined {
	for (let i = 0; i < layers.length; i++) {
		const layer = layers[i];
		if (matches(model, layer.match, ctx)) {
			return { name: layer.name, index: i };
		}
	}
	return undefined;
}

function matches(model: IndexedModel, m: LayerMatcher, ctx: ClassifyContext): boolean {
	if (m.any && m.any.length > 0) {
		return m.any.some(sub => matches(model, sub, ctx));
	}
	if (m.all && m.all.length > 0) {
		return m.all.every(sub => matches(model, sub, ctx));
	}

	// Leaf: all specified fields must match (implicit AND). An empty matcher matches nothing.
	let hasCondition = false;

	if (m.folder !== undefined) {
		hasCondition = true;
		if (!matchesFolder(model, m.folder, ctx.projectDir)) return false;
	}
	if (m.namePrefix !== undefined) {
		hasCondition = true;
		if (!model.name.toLowerCase().startsWith(m.namePrefix.toLowerCase())) return false;
	}
	if (m.nameRegex !== undefined) {
		hasCondition = true;
		let re: RegExp;
		try {
			re = new RegExp(m.nameRegex);
		} catch {
			return false;
		}
		if (!re.test(model.name)) return false;
	}
	if (m.tag !== undefined) {
		hasCondition = true;
		if (!model.tags.includes(m.tag)) return false;
	}
	if (m.materialization !== undefined) {
		hasCondition = true;
		if (model.materialisation !== m.materialization) return false;
	}

	return hasCondition;
}

function matchesFolder(model: IndexedModel, folder: string, projectDir: string): boolean {
	const rel = path.relative(projectDir, model.path).replace(/\\/g, '/').toLowerCase();
	const needle = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
	if (needle.length === 0) return false;
	return rel === needle || rel.startsWith(needle + '/');
}

/**
 * Validate a user-supplied layers config. Returns an array of error messages (empty if valid).
 * Callers use this to surface a diagnostic before handing the config to `classifyLayer`.
 */
export function validateLayerConfig(layers: unknown): string[] {
	const errors: string[] = [];
	if (!Array.isArray(layers)) {
		return ['dbt-anvil.layers must be an array'];
	}
	const names = new Set<string>();
	for (let i = 0; i < layers.length; i++) {
		const entry = layers[i] as Partial<LayerConfig> | null | undefined;
		const prefix = `layers[${i}]`;
		if (!entry || typeof entry !== 'object') {
			errors.push(`${prefix}: must be an object`);
			continue;
		}
		if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
			errors.push(`${prefix}.name: must be a non-empty string`);
		} else if (names.has(entry.name)) {
			errors.push(`${prefix}.name: duplicate layer name "${entry.name}"`);
		} else {
			names.add(entry.name);
		}
		if (!entry.match || typeof entry.match !== 'object') {
			errors.push(`${prefix}.match: must be an object`);
			continue;
		}
		validateMatcher(entry.match as LayerMatcher, `${prefix}.match`, errors);
	}
	return errors;
}

function validateMatcher(m: LayerMatcher, prefix: string, errors: string[]): void {
	const hasLeaf =
		m.folder !== undefined ||
		m.namePrefix !== undefined ||
		m.nameRegex !== undefined ||
		m.tag !== undefined ||
		m.materialization !== undefined;
	const hasCombinator = (m.any?.length ?? 0) > 0 || (m.all?.length ?? 0) > 0;
	if (!hasLeaf && !hasCombinator) {
		errors.push(`${prefix}: must declare at least one of folder, namePrefix, nameRegex, tag, materialization, any, all`);
	}
	if (m.nameRegex !== undefined) {
		try {
			new RegExp(m.nameRegex);
		} catch (e) {
			errors.push(`${prefix}.nameRegex: invalid regex (${(e as Error).message})`);
		}
	}
	for (const key of ['any', 'all'] as const) {
		const sub = m[key];
		if (sub) {
			if (!Array.isArray(sub)) {
				errors.push(`${prefix}.${key}: must be an array`);
				continue;
			}
			sub.forEach((child, i) => validateMatcher(child, `${prefix}.${key}[${i}]`, errors));
		}
	}
}
