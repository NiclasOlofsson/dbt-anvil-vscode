/**
 * SQL keywords that are never column names.
 * Used by hover and reference providers to suppress false matches.
 */
export const SQL_KEYWORDS = new Set([
	'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'ON', 'AS',
	'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
	'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION',
	'INSERT', 'INTO', 'UPDATE', 'DELETE', 'SET', 'VALUES', 'CREATE',
	'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX', 'WITH', 'CASE', 'WHEN',
	'THEN', 'ELSE', 'END', 'BETWEEN', 'LIKE', 'IS', 'NULL', 'TRUE',
	'FALSE', 'DISTINCT', 'ALL', 'EXISTS', 'ANY', 'SOME', 'ASC', 'DESC',
	'OVER', 'PARTITION', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING',
	'FOLLOWING', 'CURRENT', 'ROW', 'WINDOW', 'FILTER', 'WITHIN',
	'CAST', 'COALESCE', 'NULLIF', 'IF', 'IIF',
]);
