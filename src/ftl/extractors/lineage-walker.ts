import { truncateExpression } from './column-expr-helpers';

export interface ColumnDependency {
	column: string;
	table: string;
	schema?: string;
	database?: string;
	dbt_resource?: string;
	transformations?: Transformation[];
	via_ctes?: string[];
}

export interface TransformationBranch {
	expression?: string;
	sources: string[];
}

export interface Transformation {
	/** Namespaced id: "cte:name", "table:name", or "query" */
	id: string;
	type: 'cte' | 'table' | 'union' | 'outer_query';
	column: string;
	expression?: string;
	sources: string[];
	branches?: TransformationBranch[];
}

export interface LineageResult {
	dependencies: ColumnDependency[];
	via_ctes: string[];
	transformations: Transformation[];
}

/** Raw tree node returned by Python `_dump_lineage_node`. @internal */
interface LineageTreeSource {
	type: string;
	name?: string | null;
	db?: string | null;
	catalog?: string | null;
}

/** @internal */
export interface LineageTreeNode {
	name: string;
	expression: string | null;
	source: LineageTreeSource | null;
	referenceNodeName: string | null;
	downstream: LineageTreeNode[];
}

export type RawLineageV2 =
	| { success: true; tree: LineageTreeNode }
	| { success: false; error: string; traceback?: string };

/** @internal */
export function walkLineageTree(tree: LineageTreeNode): LineageResult {
	const dependencies: ColumnDependency[] = [];
	const via_ctes: string[] = [];
	const transformMap = new Map<string, Transformation>();
	const cteToId = new Map<string, string>();
	const nodesWithData: Array<{ transformId: string; exprStr: string }> = [];
	const outerQuerySources = new Set<string>();
	const unionBranches = new Map<string, Array<{ expression?: string; column?: string; fullExpr?: string }>>();
	const seen = new Set<LineageTreeNode>();

	function walk(node: LineageTreeNode): void {
		if (seen.has(node)) return;
		seen.add(node);
		if (!node.name) {
			for (const c of node.downstream) walk(c);
			return;
		}

		const dotIdx = node.name.indexOf('.');

		if (dotIdx === -1) {
			if (node.referenceNodeName) {
				const branch: { expression?: string; column?: string; fullExpr?: string } = {};
				if (node.expression) {
					branch.expression = truncateExpression(node.expression);
					if (node.expression.includes(' AS ')) branch.column = node.expression.split(' AS ').at(-1)!.trim();
					branch.fullExpr = node.expression;
				}
				const list = unionBranches.get(node.referenceNodeName) ?? [];
				list.push(branch);
				unionBranches.set(node.referenceNodeName, list);
			}
			for (const c of node.downstream) walk(c);
			return;
		}

		const cteOrTable = node.name.slice(0, dotIdx).replace(/^"|"$/g, '');
		const colName = node.name.slice(dotIdx + 1).replace(/^"|"$/g, '');

		if (cteOrTable === '__lineage_final__') {
			if (node.expression) {
				for (const m of node.expression.matchAll(/\b([A-Za-z_]\w*)\./g)) {
					if (!/^\d+$/.test(m[1])) outerQuerySources.add(m[1]);
				}
			}
			for (const c of node.downstream) walk(c);
			return;
		}

		const isTable = node.source?.type === 'Table';
		const actual = isTable ? (node.source!.name ?? cteOrTable) : cteOrTable;
		const transformId = `${isTable ? 'table' : 'cte'}:${actual}`;
		const transformType: 'table' | 'cte' = isTable ? 'table' : 'cte';
		cteToId.set(actual, transformId);

		if (isTable) {
			const dep: ColumnDependency = { column: colName, table: actual };
			if (node.source!.db) dep.schema = node.source!.db;
			if (node.source!.catalog) dep.database = node.source!.catalog;
			if (!dependencies.some(d => d.column === dep.column && d.table === dep.table)) dependencies.push(dep);
		} else if (!via_ctes.includes(actual)) {
			via_ctes.push(actual);
		}

		if (node.expression) nodesWithData.push({ transformId, exprStr: node.expression });

		if (!transformMap.has(transformId)) {
			const transform: Transformation = { id: transformId, type: transformType, column: colName, sources: [] };
			if (node.expression && node.expression.trim() !== colName) {
				transform.expression = truncateExpression(node.expression);
			}
			transformMap.set(transformId, transform);
		}

		for (const c of node.downstream) walk(c);
	}

	walk(tree);

	for (const refCte of unionBranches.keys()) cteToId.set(refCte, `cte:${refCte}`);

	for (const [refCte, branches] of unionBranches) {
		if (branches.length === 0) continue;
		const transformId = `cte:${refCte}`;
		const column = branches[0].column ?? '';
		const formatted: TransformationBranch[] = branches.map(b => {
			const sourceIds = new Set<string>();
			const fullExpr = b.fullExpr ?? '';
			for (const [cteName, cteId] of cteToId) {
				if (fullExpr.includes(`${cteName}.`)) sourceIds.add(cteId);
			}
			return { expression: b.expression, sources: [...sourceIds].sort() };
		});
		transformMap.set(transformId, { id: transformId, type: 'union', column, branches: formatted, sources: [] });
	}

	const sourcesMap = new Map<string, Set<string>>();
	for (const { transformId, exprStr } of nodesWithData) {
		const srcIds = new Set<string>();
		for (const [cteName, cteId] of cteToId) {
			if (cteId !== transformId && exprStr.includes(`${cteName}.`)) srcIds.add(cteId);
		}
		if (srcIds.size > 0) {
			const existing = sourcesMap.get(transformId) ?? new Set<string>();
			for (const id of srcIds) existing.add(id);
			sourcesMap.set(transformId, existing);
		}
	}

	const transformations: Transformation[] = [];
	for (const trans of transformMap.values()) {
		if (trans.type !== 'union') trans.sources = [...(sourcesMap.get(trans.id) ?? [])].sort();
		transformations.push(trans);
	}

	if (outerQuerySources.size > 0) {
		const columnForQuery = transformations[0]?.column ?? '';
		const resolved = [...outerQuerySources].map(ref => cteToId.get(ref) ?? `table:${ref}`).sort();
		transformations.unshift({ id: 'query', type: 'outer_query', column: columnForQuery, sources: resolved });
	}

	return { dependencies, via_ctes, transformations };
}
