/**
 * The extension's neutral fine-grained jinja token shape — one token per
 * syntactic element inside every `{{ }}` / `{% %}` / `{# #}` tag, interleavable
 * with `SqlToken[]`, all positions in raw-source coordinates.
 *
 * PRODUCED by the sqllens stream adapter (`sqllens/extract/jinja-stream.ts`)
 * from `parseTemplated`'s unified token stream — the extension's own scanner
 * that used to live here is retired (a frozen copy remains as the parity-test
 * oracle in `src/test/ftl/reference-jinja-tokenizers.ts`). This module carries
 * only the type contract.
 */
export type JinjaTokenType =
	| 'jinja_expression_open'  // {{
	| 'jinja_expression_close' // }}
	| 'jinja_block_open'       // {%
	| 'jinja_block_close'      // %}
	| 'jinja_comment_open'     // {#
	| 'jinja_comment_close'    // #}
	| 'jinja_identifier'       // ref, source, my_macro, var, if, for, in, etc.
	| 'jinja_string'           // 'my_model' or "my_model" (value excludes quotes)
	| 'jinja_number'           // 42, 3.14
	| 'jinja_paren_open'       // (
	| 'jinja_paren_close'      // )
	| 'jinja_comma'            // ,
	| 'jinja_dot'              // .  (e.g. dbt_utils.macro)
	| 'jinja_operator'         // |, =, ==, !=, -, +, *, /, etc. — coalesced operator runs
	| 'jinja_text';            // genuine opaque body content (currently: comment bodies)

export interface JinjaToken {
	type: JinjaTokenType;
	/** 0-based start offset in the raw source. */
	start: number;
	/** 0-based exclusive end offset in the raw source. */
	end: number;
	/** 0-based line of the start offset. */
	line: number;
	/** 0-based column of the start offset. */
	col: number;
	/**
	 * Token text content. For strings, the surrounding quotes are excluded
	 * (use `start`/`end` to recover the quoted span). For other tokens, the
	 * value is the literal text from the source.
	 */
	value: string;
	/**
	 * On `*_open` tokens only: 0-based exclusive end offset of the matching
	 * close (e.g. for `{{`, the offset just past the matching `}}`). Lets
	 * consumers walking the merged stream skip an entire jinja region in O(1)
	 * without scanning forward for the close.
	 */
	tagEnd?: number;
}
