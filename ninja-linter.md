# Ninja Linter — SQL Quality for dbt Studio

## Background

SQL linting has a rich history in the dbt ecosystem. Tools like **sqlfluff** pioneered the space, bringing configurable rule-based analysis to SQL files and establishing many of the conventions that teams rely on today — consistent capitalisation, trailing whitespace, indentation standards, and more. These tools work well as standalone CLI utilities and CI checks.

dbt Studio takes a different approach: it embeds linting directly into the editor as a native VS Code experience. Rather than running an external process and parsing its output, Ninja operates on the same parsed representation that powers every other dbt Studio feature — completions, navigation, diagnostics, and debugging. This means lint feedback appears instantly as you type, with no round-trip to a subprocess, no Python dependency, and no configuration file to maintain outside of VS Code settings.

## What Made This Possible

Ninja is built on top of the **DocumentModel** — a rich AST-like representation that dbt Studio already maintains for every open SQL file. The DocumentModel is parsed incrementally by a Python bridge backed by **sqlglot**, and it provides:

- **Token-level information** — every column reference, table reference, and column definition, with resolved source tracking (`resolvedTableRef`) that links column usages back to their defining CTE or table.
- **CTE awareness** — each CTE's name, line span, and column list, enabling cross-CTE dependency analysis.
- **SQL token stream** — a flat sequence of classified tokens (SELECT, FROM, WHERE, JOIN, COMMA, AND, OR, ALIAS, etc.) with precise character offsets, enabling structural checks that go beyond regex pattern matching.
- **Final SELECT metadata** — the columns of the outermost SELECT, including expression/alias positions, enabling alias-style checks.
- **Jinja tag spans** — locations of `{{ }}`, `{% %}`, and `{# #}` blocks, so layout rules can skip or account for Jinja content.

Because all of this is already computed for editor features, Ninja adds zero parsing overhead. It simply reads the model and reports violations.

### Architecture

Ninja rules come in two types:

| Type | Input | Use Case |
|------|-------|----------|
| **TokenRule** | `DocumentModel` + config | Semantic checks — references, structure, naming |
| **LayoutRule** | Raw text + lines + Jinja tokens + config | Whitespace, indentation, line length |

All rules run independently and in parallel. Each returns an array of violations, optionally with auto-fix edits that VS Code can apply in one action.

Violations can be suppressed per-line with inline comments:

```sql
select *  -- noqa
from orders  -- noqa: ninja.structure.select-star
```

## Configuration

Ninja is configured through VS Code settings under the `dbt-studio.ninja` namespace. Every rule can be individually set to `error`, `warning`, `info`, or `off`.

```jsonc
// .vscode/settings.json
{
  "dbt-studio.ninja.enabled": true,
  "dbt-studio.ninja.capitalisation.keywords": "lower",
  "dbt-studio.ninja.capitalisation.functions": "lower",
  "dbt-studio.ninja.capitalisation.literals": "lower",
  "dbt-studio.ninja.capitalisation.types": "lower",
  "dbt-studio.ninja.indentation.unit": "space",
  "dbt-studio.ninja.indentation.size": 4,
  "dbt-studio.ninja.maxLineLength": 120,
  "dbt-studio.ninja.layout.commaPosition": "trailing",
  "dbt-studio.ninja.layout.operatorPosition": "trailing",
  "dbt-studio.ninja.structure.allowStarInCte": false,
  "dbt-studio.ninja.convention.notEqual": "!=",
  "dbt-studio.ninja.convention.unionStyle": "all",
  "dbt-studio.ninja.rules": {
    "ninja.cap.keywords": "warning",
    "ninja.structure.unused-cte": "error",
    "ninja.layout.long-lines": "off"
  }
}
```

---

## Rules Reference

Ninja ships with **38 built-in rules** across 8 categories. Rules marked with ⚡ provide one-click auto-fix.

### Capitalisation

These rules enforce consistent casing for SQL language elements. Each supports three policies: `upper`, `lower`, or `consistent` (first occurrence sets the convention for the file).

#### `ninja.cap.keywords` ⚡

> SQL keywords should follow the configured capitalisation policy.

Checks approximately 80 SQL keywords including `SELECT`, `FROM`, `WHERE`, `JOIN`, `GROUP BY`, `ORDER BY`, `HAVING`, `UNION`, `CASE`, `WHEN`, `THEN`, `ELSE`, `END`, `AND`, `OR`, `NOT`, `IN`, `EXISTS`, `BETWEEN`, `LIKE`, `IS`, `AS`, `ON`, `WITH`, `DISTINCT`, `LIMIT`, `OFFSET`, and more.

- **Default severity:** warning
- **Auto-fix:** Replaces the keyword with the correctly-cased version.
- **Smart skipping:** Identifier positions from the DocumentModel are excluded to avoid false positives on column or table names that happen to match keywords.

```sql
-- Policy: lower → flags SELECT, FROM
SELECT id FROM orders
-- Fix →
select id from orders
```

#### `ninja.cap.functions` ⚡

> SQL function names should follow the configured capitalisation policy.

Checks approximately 130 SQL functions including `count`, `sum`, `avg`, `min`, `max`, `coalesce`, `nullif`, `cast`, `substring`, `trim`, `row_number`, `rank`, `dense_rank`, `lag`, `lead`, `first_value`, `last_value`, `date_trunc`, `date_diff`, `array_agg`, and more.

- **Default severity:** warning
- **Auto-fix:** Replaces the function name with the correctly-cased version.

```sql
-- Policy: lower → flags COUNT, SUM
SELECT COUNT(*), SUM(amount) FROM orders
-- Fix →
select count(*), sum(amount) from orders
```

#### `ninja.cap.literals` ⚡

> SQL literals should follow the configured capitalisation policy.

Checks three SQL literals: `NULL`, `TRUE`, `FALSE`.

- **Default severity:** warning
- **Auto-fix:** Replaces the literal with the correctly-cased version.

```sql
-- Policy: lower → flags NULL
WHERE status IS NULL
-- Fix →
where status is null
```

#### `ninja.cap.types` ⚡

> SQL data type keywords should follow the configured capitalisation policy.

Checks approximately 60 SQL types including `int`, `bigint`, `smallint`, `float`, `double`, `decimal`, `numeric`, `varchar`, `char`, `text`, `boolean`, `date`, `timestamp`, `datetime`, `json`, `jsonb`, `array`, `struct`, `map`, `binary`, `blob`, and more.

- **Default severity:** warning
- **Auto-fix:** Replaces the type keyword with the correctly-cased version.

```sql
-- Policy: lower → flags INT, VARCHAR
CAST(id AS INT), CAST(name AS VARCHAR(255))
-- Fix →
cast(id as int), cast(name as varchar(255))
```

---

### Jinja

#### `ninja.jinja.padding` ⚡

> Jinja tags should have single-space padding inside delimiters.

Checks `{{ }}` expression tags and `{% %}` block tags. Requires exactly one space after the opening delimiter and one space before the closing delimiter. Jinja comments (`{# #}`) are skipped. Whitespace-control dashes (`{{-`, `-}}`, `{%-`, `-%}`) are respected. Multiline blocks (where the content spans multiple lines) are skipped entirely — padding rules don't apply to block-style config calls.

- **Default severity:** warning
- **Auto-fix:** Inserts missing space or deletes excess spaces to produce exactly one space of padding.

```sql
-- Flags: no padding, excess padding
select {{customer_id}}, {{  order_date  }}
-- Fix →
select {{ customer_id }}, {{ order_date }}

-- Not flagged: multiline block
{{
    config(materialized='table')
}}
```

---

### Structure

These rules analyse the semantic structure of SQL using the DocumentModel's CTE definitions, column lists, and resolved references.

#### `ninja.structure.unused-cte` ⚡†

> CTE is defined but never referenced.

Finds CTEs whose names never appear as a `table_ref` in any downstream FROM or JOIN clause. A CTE that is defined but never read from is dead code.

- **Default severity:** info
- **Code fix (†):** Precisely deletes the unused CTE definition. Because deleting a CTE is a destructive, hard-to-reverse operation, the fix is offered as an individual code fix only — it is intentionally excluded from the bulk "Fix all" action and the `source.fixAll.ninja` on-save action. Handles three distinct cases:
  1. **Only CTE** — removes the entire `WITH ... AS (...)` block, leaving just the final SELECT.
  2. **First of several** — removes from the CTE name through the comma before the next CTE.
  3. **Middle or last** — removes from the preceding comma through the closing parenthesis of the unused CTE.

```sql
-- Flags: staging_orders is never referenced
with
    staging_orders as (
        select * from {{ ref('stg_orders') }}
    ),
    staging_items as (
        select * from {{ ref('stg_items') }}
    )
select * from staging_items
```

#### `ninja.structure.unused-columns`

> Column defined in a CTE is never referenced downstream.

Cross-references each column in every CTE's column list against all `column_ref` tokens with matching `resolvedTableRef` in downstream positions. A column that is defined but never selected, filtered on, or joined on is unnecessary.

- **Default severity:** info
- **Skips:** CTEs that contain `SELECT *` (opaque column lists prevent reliable analysis).
- **No auto-fix** — removing a column from a SELECT list requires understanding the surrounding commas and formatting.

```sql
-- Flags: created_at is never used downstream
with orders as (
    select id, status, created_at
    from {{ ref('stg_orders') }}
)
select id, status from orders
```

#### `ninja.structure.select-star`

> Avoid SELECT * inside CTEs.

Flags CTE bodies that use `SELECT *` instead of explicit column lists. Wildcards prevent column-level dependency tracking and make it harder to reason about what data flows through each CTE.

- **Default severity:** info
- **Configurable:** Set `structure.allowStarInCte: true` to disable this rule.
- **No auto-fix** — expanding `*` requires knowledge of upstream column names.

```sql
-- Flags: SELECT * in the CTE body
with orders as (
    select * from {{ ref('stg_orders') }}
)
select id from orders
```

---

### Convention

These rules enforce team-agreed formatting conventions using the SQL token stream.

#### `ninja.convention.comma-position`

> Commas should be placed consistently (trailing or leading).

In **trailing** mode (default), commas belong at the end of the line. In **leading** mode, commas belong at the start of the next line. Uses SqlToken positions to detect commas that violate the configured convention.

- **Default severity:** warning
- **No auto-fix** — moving commas across lines also requires adjusting indentation.

```sql
-- Trailing mode flags leading commas:
select
    id
    , name        -- violation: leading comma
    , status      -- violation: leading comma
from orders

-- Leading mode flags trailing commas:
select
    id,           -- violation: trailing comma
    name,         -- violation: trailing comma
    status
from orders
```

#### `ninja.convention.operator-position` ⚡

> Boolean operators (AND/OR) should be placed consistently (trailing or leading).

Same convention logic as commas but applied to `AND` and `OR` operators. In **trailing** mode, operators end the line. In **leading** mode, operators start the next line.

Configured via `dbt-studio.ninja.convention.operatorPosition`. Default is `leading` (dbt community standard).

- **Default severity:** warning
- **Auto-fix:** Moves the operator to the correct position (appends to previous line in trailing mode, prepends to next line in leading mode).

```sql
-- Leading mode (default) flags trailing operators:
where
    status = 'active' and   -- violation: trailing AND
    amount > 100
-- Fix →
where
    status = 'active'
    and amount > 100

-- Trailing mode flags leading operators:
where
    status = 'active'
    and amount > 100    -- violation: leading AND
-- Fix →
where
    status = 'active' and
    amount > 100
```

#### `ninja.convention.not-equal` ⚡

> Inequality comparisons should use the configured style (`!=` or `<>`).

Configured via `dbt-studio.ninja.convention.notEqual`. Default is `!=`. Both `!=` and `<>` are valid SQL but mixing them is inconsistent.

- **Default severity:** warning
- **Auto-fix:** Replaces the operator with the configured style.

```sql
-- notEqual: != → flags <>
where status <> 'active'   -- flags
-- Fix →
where status != 'active'
```

#### `ninja.convention.count-rows` ⚡

> Use `count(*)` instead of `count(0)` or `count(1)` for counting rows.

`count(*)` is the SQL standard for row counting and is universally understood. Numeric arguments like `count(1)` are a historical artifact with no semantic advantage.

- **Default severity:** warning
- **Auto-fix:** Replaces `count(0)` or `count(1)` with `count(*)`.

```sql
-- Flags:
select count(1) from orders
-- Fix →
select count(*) from orders
```

#### `ninja.convention.is-null` ⚡

> Use `IS NULL` / `IS NOT NULL` instead of `= NULL` / `!= NULL`.

Comparing with `= NULL` always returns `NULL` (not `TRUE`/`FALSE`) due to SQL's three-valued logic. This is a common bug source.

- **Default severity:** error
- **Auto-fix:** Replaces `= NULL` with `IS NULL` and `!= NULL` / `<> NULL` with `IS NOT NULL`.

```sql
-- Flags:
where status = NULL or category != NULL
-- Fix →
where status IS NULL or category IS NOT NULL
```

#### `ninja.convention.left-join` ⚡

> Use `LEFT JOIN` instead of `LEFT OUTER JOIN`.

`OUTER` is redundant in `LEFT OUTER JOIN` — the word `LEFT` already implies outer semantics. Dropping it reduces noise.

- **Default severity:** warning
- **Auto-fix:** Removes the `OUTER` keyword.

```sql
-- Flags:
select * from orders left outer join items on orders.id = items.order_id
-- Fix →
select * from orders left join items on orders.id = items.order_id
```

#### `ninja.convention.coalesce` ⚡

> Use `COALESCE` instead of legacy null-handling functions (`IFNULL`, `NVL`, `ISNULL`).

`COALESCE` is the SQL standard and works across all databases. `IFNULL`, `NVL`, and `ISNULL` are vendor-specific aliases.

- **Default severity:** warning
- **Auto-fix:** Replaces the function name with `coalesce`.

```sql
-- Flags:
select ifnull(amount, 0), nvl(status, 'unknown')
-- Fix →
select coalesce(amount, 0), coalesce(status, 'unknown')
```

#### `ninja.convention.union-style` ⚡

> Enforce a consistent UNION qualifier — either always `ALL` or always `DISTINCT`.

Configured via `dbt-studio.ninja.convention.unionStyle` (`"all"` or `"distinct"`, default `"all"`). When a `UNION ALL` or `UNION DISTINCT` is found with the wrong qualifier, it is flagged. Bare `UNION` (no qualifier) is handled separately by `ninja.ambiguity.bare-union`.

- **Default severity:** warning
- **Auto-fix:** Replaces the qualifier with the configured style (e.g. `DISTINCT` → `ALL`).

```sql
-- Flags (unionStyle = "all"):
select 1 union distinct select 2
-- Fix →
select 1 union all select 2
```

#### `ninja.ambiguity.qualified-columns`

> Column references should be table-qualified when multiple sources are present.

When a query has two or more table references (FROM + JOINs, or multiple CTEs), unqualified column names are ambiguous — it's unclear which table they come from. This rule flags column references that lack a table qualifier. Wildcard `*` is excluded.

- **Default severity:** info
- **Skip conditions:** Single-table queries (no ambiguity), columns that already have a table qualifier.
- **No auto-fix** — resolving the correct table requires semantic knowledge.

```sql
-- Flags: id and status are unqualified
select id, status
from orders o
join items i on o.id = i.order_id
-- Better →
select o.id, o.status
from orders o
join items i on o.id = i.order_id
```

#### `ninja.ambiguity.implicit-join` ⚡

> Bare `JOIN` should be explicit `INNER JOIN`.

A `JOIN` without a qualifier is an `INNER JOIN` but the intent is unclear to readers. Being explicit prevents confusion with `OUTER`, `CROSS`, or `NATURAL` joins.

- **Default severity:** warning
- **Auto-fix:** Inserts `INNER ` before the `JOIN` keyword.
- **Allowed:** `LEFT JOIN`, `RIGHT JOIN`, `CROSS JOIN`, `FULL JOIN`, `NATURAL JOIN`, and their `OUTER` variants.

```sql
-- Flags: bare JOIN
select * from orders o join items i on o.id = i.order_id
-- Fix →
select * from orders o INNER join items i on o.id = i.order_id
```

#### `ninja.ambiguity.bare-union`

> UNION should include an explicit `ALL` or `DISTINCT` qualifier.

Bare `UNION` implies `DISTINCT` by SQL standard, but this is easy to miss. Being explicit clarifies whether duplicates are removed.

- **Default severity:** warning
- **No auto-fix** — choosing ALL vs DISTINCT changes query semantics.

```sql
-- Flags: bare UNION
select id from orders
union
select id from archive_orders
```

#### `ninja.ambiguity.distinct-groupby`

> Avoid using DISTINCT together with GROUP BY — it is redundant.

When a GROUP BY is present, results are already unique per the grouping keys. Adding DISTINCT is at best redundant and at worst misleading.

- **Default severity:** warning
- **No auto-fix** — removing DISTINCT changes how the intent reads.

#### `ninja.aliasing.column-as` ⚡

> Column aliases should use the explicit AS keyword.

Implicit aliases (e.g., `select id user_id`) are valid SQL but harder to read than explicit aliases (`select id AS user_id`). This rule checks columns in the final SELECT that have an alias position but no `AS` token between the expression and the alias.

- **Default severity:** info
- **Auto-fix:** Inserts `AS ` immediately before the alias identifier.

```sql
-- Flags: implicit alias
select
    id user_id,
    amount total_amount
from orders
-- Fix →
select
    id AS user_id,
    amount AS total_amount
from orders
```

#### `ninja.aliasing.require-table-alias`

> Table references should have aliases when multiple sources are present.

When a query has two or more table sources, all tables should be aliased. Aliases make column qualifications shorter and the query more readable. Single-table queries are exempt — an alias there is optional.

- **Default severity:** info
- **No auto-fix** — choosing a good alias name requires human judgment.

```sql
-- Flags: orders has no alias
select orders.id, i.name
from orders
join items i on orders.id = i.order_id
-- Better →
select o.id, i.name
from orders o
join items i on o.id = i.order_id
```

#### `ninja.aliasing.self-alias` ⚡

> Do not alias a table to its own name.

Aliasing `orders AS orders` (or `orders orders`) is a no-op that adds visual noise without benefit.

- **Default severity:** warning
- **Auto-fix:** Removes the redundant alias clause.

```sql
-- Flags: orders aliased to itself
select o.id from orders orders
-- Fix →
select o.id from orders
```

#### `ninja.aliasing.unique-table`

> Table aliases must be unique within a query.

Duplicate aliases make it impossible to unambiguously qualify column references.

- **Default severity:** warning
- **No auto-fix** — choosing distinct aliases requires human judgment.

```sql
-- Flags: both tables aliased to 'o'
select o.id from orders o join other_orders o on o.id = o.order_id
```

#### `ninja.aliasing.unused-alias`

> Table alias is defined but never referenced by any column.

An alias that is never used to qualify a column reference serves no purpose.

- **Default severity:** info
- **No auto-fix** — deciding whether to use the alias or remove it requires human judgment.

```sql
-- Flags: alias 'o' never used
select id from orders o
```

#### `ninja.aliasing.expression-no-alias`

> Expressions in the final SELECT should have an explicit alias.

Expressions like `count(*)` without an alias produce auto-generated column names that differ across databases and are hard to reference in downstream tools.

- **Default severity:** warning
- **No auto-fix** — choosing a meaningful alias name requires human judgment.

```sql
-- Flags: count(*) has no alias
select id, count(*)
from orders
group by id
-- Better →
select id, count(*) as total_orders
from orders
group by id
```

---

### Structure (additional)

#### `ninja.structure.else-null`

> Redundant `ELSE NULL` — CASE already returns NULL by default.

When the last branch of a CASE expression is `ELSE NULL`, it can be removed — CASE returns NULL implicitly if no branch matches.

- **Default severity:** info
- **Auto-fix:** Removes `ELSE NULL` leaving just `... END`.

```sql
-- Flags:
case when status = 'active' then 1 else null end
-- Fix →
case when status = 'active' then 1 end
```

#### `ninja.structure.simple-case`

> `CASE WHEN x THEN TRUE ELSE FALSE END` can be simplified to just `x`.

Boolean CASE expressions that return `TRUE`/`FALSE` (or `1`/`0`) based on a condition are equivalent to the condition itself.

- **Default severity:** info
- **No auto-fix** — the replacement expression depends on surrounding context and formatting.

```sql
-- Flags:
case when amount > 0 then true else false end
-- Better →
amount > 0
```

#### `ninja.structure.distinct-parens`

> Remove unnecessary parentheses around DISTINCT.

`DISTINCT(id)` reads like a function call but `DISTINCT` is not a function — the parentheses are superfluous.

- **Default severity:** warning
- **No auto-fix** — removing parentheses may change formatting.

```sql
-- Flags:
select count(distinct(id))
-- Better →
select count(distinct id)
```

#### `ninja.structure.unused-join`

> JOINed table is never referenced by any column.

A JOIN that contributes no columns to the query may indicate dead code, a missing column reference, or a JOIN that should be EXISTS instead.

- **Default severity:** warning
- **No auto-fix** — the correct resolution depends on intent.

```sql
-- Flags: customers is joined but no c.* is referenced
select o.id, o.amount
from orders o
join customers c on o.customer_id = c.id
```

---

### Layout

These rules operate on raw text and enforce whitespace/formatting standards. They use Jinja tag spans to avoid flagging content inside template expressions.

#### `ninja.layout.trailing-whitespace` ⚡

> Lines should not have trailing whitespace.

Detects spaces or tabs at the end of non-empty lines.

- **Default severity:** warning
- **Auto-fix:** Deletes the trailing whitespace characters.

#### `ninja.layout.trailing-newline` ⚡

> Files should end with exactly one trailing newline.

A missing newline causes issues with some tools; multiple trailing newlines are unnecessary.

- **Default severity:** warning
- **Auto-fix:** Adds a newline if missing, or removes excess trailing newlines to leave exactly one.

#### `ninja.layout.leading-whitespace` ⚡

> Files should not start with blank lines.

Blank lines at the top of a file serve no purpose and look like accidental whitespace.

- **Default severity:** warning
- **Auto-fix:** Deletes all leading blank lines.

#### `ninja.layout.max-blank-lines` ⚡

> There should be at most one consecutive blank line.

More than one blank line in a row is visual noise without semantic meaning.

- **Default severity:** warning
- **Auto-fix:** Keeps one blank line and deletes the extras.

#### `ninja.layout.long-lines`

> Lines should not exceed the configured maximum length.

Lines longer than `maxLineLength` (default: 120) are flagged. Lines that contain more than 50% Jinja content are skipped — they often can't be shortened without restructuring the template logic.

- **Default severity:** info
- **No auto-fix** — safe line breaking requires understanding the SQL and Jinja structure.

#### `ninja.layout.indent` ⚡

> Indentation should follow the configured style.

Enforces consistent indentation using `space` or `tab` with the configured size (default: 4 spaces). Detects:
- Mixed indentation (spaces and tabs on the same line)
- Wrong unit (tabs when spaces expected, or vice versa)
- Wrong size (spaces not a multiple of the configured size)

Blank lines and lines starting inside Jinja block tokens are skipped.

- **Default severity:** warning
- **Auto-fix:** Replaces the line's indentation with the correctly-formatted version.

#### `ninja.layout.function_spacing` ⚡

> No space between function name and opening parenthesis.

Flags patterns like `count (*)` or `sum (amount)` where a space separates the function name from its argument list. Checks approximately 130 known SQL function names.

- **Default severity:** warning
- **Auto-fix:** Deletes the space(s) between the function name and `(`.

```sql
-- Flags: space before (
select count (*), sum (amount)
-- Fix →
select count(*), sum(amount)
```

---

## Summary

⚡ = auto-fix (included in "Fix all" and `source.fixAll.ninja`)
⚡† = code fix only (available in the lightbulb menu, but excluded from bulk fix actions)

| Category | Rules | ⚡ Auto-fix | ⚡† Code fix only |
|----------|------:|:-----------:|:-----------------:|
| Capitalisation | 4 | 4 | — |
| Jinja | 1 | 1 | — |
| Structure | 7 | 1 | 1 |
| Convention | 9 | 7 | — |
| Ambiguity | 4 | 1 | — |
| Aliasing | 6 | 2 | — |
| Layout | 7 | 6 | — |
| **Total** | **38** | **22** | **1** |

---

## Future: sqlglot Optimizer-Inspired Rules & Refactorings

The vendored sqlglot optimizer (`resources/ftl/vendor/sqlglot/optimizer/`) has 20 modules with SQL analysis and transformation capabilities. Several map directly to new ninja rules and refactoring code actions, using the existing document model (tokens, CTEs, scope nodes, sqlTokens).

**Already covered:** `eliminate_ctes` → unused-cte, `eliminate_joins` → unused-join, `pushdown_projections` → unused-columns, `qualify_columns` → qualified-columns.

### Tier 1 — Pure Ninja Rules (TypeScript only)

**`ninja.structure.subquery-in-from`** ← `eliminate_subqueries.py`
- Detect subqueries in FROM clauses (scope nodes with `type: 'derived_table'`)
- dbt convention strongly prefers CTEs over inline subqueries
- Fix: Extract to WITH clause as a new CTE, replace inline with CTE reference

**`ninja.structure.passthrough-cte`** ← `merge_subqueries.py`
- Detect trivial pass-through CTEs: `WITH x AS (SELECT * FROM y) SELECT ... FROM x`
- Adds unnecessary indirection, obscures lineage
- Fix: Remove CTE, rewrite references to point at the underlying source

**`ninja.structure.simplify-expression`** ← `simplify.py`
- Detect trivially simplifiable expressions: `1 = 1`, `TRUE AND x`, `NOT NOT x`, `COALESCE(x, x)`
- Fix: Replace with simplified form

**`ninja.perf.predicate-pushdown`** ← `pushdown_predicates.py`
- Detect WHERE on outer query filtering columns from a single CTE that could be pushed down
- Hint only (no auto-fix)

**`ninja.perf.correlated-subquery`** ← `unnest_subqueries.py`
- Detect correlated subqueries (WHERE EXISTS/IN referencing outer columns)
- Hint only — suggest rewriting as JOIN

**`ninja.structure.unused-columns` auto-fix** ← `pushdown_projections.py`
- Existing rule detects unused CTE columns but has no fix — add auto-fix that removes the column from the SELECT list

### Tier 2 — Refactoring Code Actions

**Qualify Columns refactoring** ← `qualify_columns.py`
- The parser already calls `qualify()` — qualified output exists
- Code action: "Qualify all column references" → rewrites `col` to `table.col`
- Compare pre/post-qualify column tokens; emit TextEdits

**`ninja.convention.canonical-cast`** ← `canonicalize.py`
- Detect non-standard function forms per dialect (e.g., `DATE('...')` → `CAST('...' AS DATE)`, `+` → `CONCAT()`)

### Tier 3 — Advanced / Future

**Full expression simplification** — Add `simplify()` call in `sql_parser.py`, compare simplified AST with original, return structured diff to TypeScript.

**Join optimization hints** ← `optimize_joins.py` — Detect CROSS JOINs that should be INNER JOINs based on WHERE predicates.
