import type { JinjaToken } from './jinja-tokenizer';
import { getTagName } from './jinja-tokenizer';

export interface FixedNode {
	type: 'fixed';
	tokens: JinjaToken[];
}

export interface BranchArm {
	/**
	 * The {% if %}, {% elif %}, or {% else %} token that opens this arm.
	 * Undefined for a synthetic empty-else arm (added when an {% if %} has no
	 * explicit {% else %} so the "condition-false" path is also enumerable).
	 */
	header: JinjaToken | undefined;
	body: DocumentNode[];
}

export interface ConditionalNode {
	type: 'conditional';
	branches: BranchArm[];
	/** The closing {% endif %} token, or undefined for a malformed (unclosed) block. */
	endif: JinjaToken | undefined;
}

export type DocumentNode = FixedNode | ConditionalNode;

// ─── internal helpers ────────────────────────────────────────────────────────

function appendFixed(nodes: DocumentNode[], token: JinjaToken): void {
	const last = nodes[nodes.length - 1];
	if (last && last.type === 'fixed') {
		last.tokens.push(token);
	} else {
		nodes.push({ type: 'fixed', tokens: [token] });
	}
}

function hasExplicitElse(cond: ConditionalNode): boolean {
	return cond.branches.some(
		b => b.header !== undefined && getTagName(b.header) === 'else',
	);
}

function finalizeCond(cond: ConditionalNode, endifToken: JinjaToken | undefined): void {
	cond.endif = endifToken;
	if (!hasExplicitElse(cond)) {
		cond.branches.push({ header: undefined, body: [] });
	}
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Builds a branch tree from a flat Jinja2 token array.
 *
 * Only `{% if %}`, `{% elif %}`, `{% else %}`, and `{% endif %}` affect tree
 * structure. All other tokens (text, expressions, comments, other tags) are
 * collected into FixedNodes.
 *
 * `{% if %}` blocks without an explicit `{% else %}` receive a synthetic empty
 * arm so both the true-path and false-path are enumerable.
 */
export function buildBranchTree(tokens: JinjaToken[]): DocumentNode[] {
	const root: DocumentNode[] = [];
	const bodyStack: DocumentNode[][] = [root];
	const condStack: ConditionalNode[] = [];

	for (const token of tokens) {
		const name = getTagName(token);

		if (name === 'if') {
			const cond: ConditionalNode = {
				type: 'conditional',
				branches: [{ header: token, body: [] }],
				endif: undefined,
			};
			condStack.push(cond);
			bodyStack.push(cond.branches[0].body);

		} else if ((name === 'elif' || name === 'else') && condStack.length > 0) {
			bodyStack.pop();
			const cond = condStack[condStack.length - 1];
			const arm: BranchArm = { header: token, body: [] };
			cond.branches.push(arm);
			bodyStack.push(arm.body);

		} else if (name === 'endif' && condStack.length > 0) {
			bodyStack.pop();
			const cond = condStack.pop()!;
			finalizeCond(cond, token);
			bodyStack[bodyStack.length - 1].push(cond);

		} else {
			appendFixed(bodyStack[bodyStack.length - 1], token);
		}
	}

	// Flush unclosed conditionals from malformed templates
	while (condStack.length > 0) {
		bodyStack.pop();
		const cond = condStack.pop()!;
		finalizeCond(cond, undefined);
		bodyStack[bodyStack.length - 1].push(cond);
	}

	return root;
}

/**
 * Returns the total number of unique branch variants in a document tree.
 *
 * Each ConditionalNode with N arms contributes a multiplicative factor equal
 * to the sum of variants within each arm (since exactly one arm is chosen).
 * Two sequential conditionals multiply their counts; nested conditionals
 * contribute per the arm that contains them.
 */
export function countVariants(nodes: DocumentNode[]): number {
	let total = 1;
	for (const node of nodes) {
		if (node.type === 'conditional') {
			total *= node.branches
				.map(arm => countVariants(arm.body))
				.reduce((a, b) => a + b, 0);
		}
	}
	return total;
}

/**
 * Returns the "active" tokens for variant `variantIndex` (0-based).
 *
 * Active tokens are all tokens that appear on the chosen execution path.
 * Tokens belonging to inactive arms are excluded; the caller can substitute
 * spaces for their source spans when generating SQL.
 */
export function selectVariant(nodes: DocumentNode[], variantIndex: number): JinjaToken[] {
	const active: JinjaToken[] = [];
	let remaining = variantIndex;

	for (const node of nodes) {
		if (node.type === 'fixed') {
			active.push(...node.tokens);
		} else {
			const armCounts = node.branches.map(arm => countVariants(arm.body));
			const total = armCounts.reduce((a, b) => a + b, 0);
			const sel = remaining % total;
			remaining = Math.floor(remaining / total);

			let cumulative = 0;
			for (let i = 0; i < node.branches.length; i++) {
				if (sel < cumulative + armCounts[i]) {
					const arm = node.branches[i];
					if (arm.header !== undefined) {
						active.push(arm.header);
					}
					active.push(...selectVariant(arm.body, sel - cumulative));
					if (node.endif !== undefined) {
						active.push(node.endif);
					}
					break;
				}
				cumulative += armCounts[i];
			}
		}
	}

	return active;
}

/**
 * Convenience: returns active-token arrays for all variants (index 0 to countVariants-1).
 */
export function enumerateVariants(nodes: DocumentNode[]): JinjaToken[][] {
	const count = countVariants(nodes);
	const result: JinjaToken[][] = [];
	for (let i = 0; i < count; i++) {
		result.push(selectVariant(nodes, i));
	}
	return result;
}
