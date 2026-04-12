import type { ParseResult } from './parse-result';

export interface SqlParser {
    parse(sql: string, dialect: string, schema?: Record<string, Record<string, string>>): Promise<ParseResult>;
}
