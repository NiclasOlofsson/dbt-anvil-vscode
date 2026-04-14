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
  "dbt-studio.ninja.rules": {
    "ninja.cap.keywords": "warning",
    "ninja.structure.unused-cte": "error",
    "ninja.layout.long-lines": "off"
  }
}
```

---

## Rules Reference

Ninja ships with **20 built-in rules** across 7 categories. Rules marked with ⚡ provide one-click auto-fix.

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

Checks `{{ }}` expression tags and `{% %}` block tags. Requires exactly one space after the opening delimiter and one space before the closing delimiter. Jinja comments (`{# #}`) are skipped. Whitespace-control dashes (`{{-`, `-}}`, `{%-`, `-%}`) are respected.

- **Default severity:** warning
- **Auto-fix:** Inserts missing space or deletes excess spaces to produce exactly one space of padding.

```sql
-- Flags: no padding, excess padding
select {{customer_id}}, {{  order_date  }}
-- Fix →
select {{ customer_id }}, {{ order_date }}
```

---

### Structure

These rules analyse the semantic structure of SQL using the DocumentModel's CTE definitions, column lists, and resolved references.

#### `ninja.structure.unused-cte` ⚡

> CTE is defined but never referenced.

Finds CTEs whose names never appear as a `table_ref` in any downstream FROM or JOIN clause. A CTE that is defined but never read from is dead code.

- **Default severity:** warning
- **Auto-fix:** Precisely deletes the unused CTE definition. Handles three distinct cases:
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

#### `ninja.convention.operator-position`

> Boolean operators (AND/OR) should be placed consistently (trailing or leading).

Same convention logic as commas but applied to `AND` and `OR` operators. In **trailing** mode, operators end the line. In **leading** mode, operators start the next line.

- **Default severity:** warning
- **No auto-fix** — moving operators across lines requires adjusting indentation.

```sql
-- Trailing mode flags leading operators:
where
    status = 'active'
    and amount > 100    -- violation: leading AND

-- Leading mode flags trailing operators:
where
    status = 'active' and   -- violation: trailing AND
    amount > 100
```

---

### Ambiguity

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

---

### Aliasing

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

| Category | Rules | With Auto-Fix |
|----------|------:|:-------------:|
| Capitalisation | 4 | 4 |
| Jinja | 1 | 1 |
| Structure | 3 | 1 |
| Convention | 2 | 0 |
| Ambiguity | 1 | 0 |
| Aliasing | 2 | 1 |
| Layout | 7 | 6 |
| **Total** | **20** | **13** |
