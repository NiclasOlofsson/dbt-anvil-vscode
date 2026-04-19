import type { JinjaTagSpan, ParseWarning } from '../parse-result';
import type { RefInfo, SourceInfo, SqlglotWarning } from '../../services/parse-service';

export function extractRefs(tags: JinjaTagSpan[]): RefInfo[] {
	return tags
		.filter((t): t is Extract<JinjaTagSpan, { type: 'ref' }> => t.type === 'ref')
		.map(t => ({
			model: t.model,
			line: t.line,
			col: t.col,
			modelCol: t.modelCol,
			modelEndCol: t.modelEndCol,
			jinjaCol: t.jinjaCol,
			jinjaEndCol: t.jinjaEndCol,
		}));
}

export function extractSources(tags: JinjaTagSpan[]): SourceInfo[] {
	return tags
		.filter((t): t is Extract<JinjaTagSpan, { type: 'source' }> => t.type === 'source')
		.map(t => ({
			sourceName: t.sourceName,
			tableName: t.tableName,
			line: t.line,
			col: t.col,
			sourceNameCol: t.sourceNameCol,
			sourceNameEndCol: t.sourceNameEndCol,
			tableNameCol: t.tableNameCol,
			tableNameEndCol: t.tableNameEndCol,
			jinjaCol: t.jinjaCol,
			jinjaEndCol: t.jinjaEndCol,
		}));
}

export function mapWarnings(warnings: ParseWarning[]): SqlglotWarning[] {
	return warnings.map(w => ({
		type: w.type,
		message: w.message,
		...(w.line !== undefined && { line: w.line }),
		...(w.col !== undefined && { col: w.col }),
		...(w.endCol !== undefined && { endCol: w.endCol }),
	}));
}
