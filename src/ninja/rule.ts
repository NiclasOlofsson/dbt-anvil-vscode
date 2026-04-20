import type * as vscode from 'vscode';
import type { NinjaCategory } from './categories';
import type { NinjaViolation } from './violation';
import type { DocumentModel } from '../services/parse-service';
import type { JinjaToken } from '../dbt/jinja-tokenizer';
import type { NinjaConfig } from './config';
import type { DialectSymbols } from '../ftl/sql-parser';

/** Severity for a rule: 'error' | 'warning' | 'info' | 'hint' | 'off'. */
export type NinjaSeverity = 'error' | 'warning' | 'info' | 'hint' | 'off';

/** Action kinds a rule may emit on its violations. */
export type NinjaActionKind = 'fix' | 'snippet';

/** Value type for a configurable rule option. */
export type RuleOptionValue = string | boolean | number;

/** Describes a single configurable option for a rule (shown inline in the Rule Editor). */
export interface RuleConfigOptionSpec {
	/** The VS Code setting sub-path, e.g. `layout.operatorPosition`. Full key = `dbt-studio.ninja.<settingPath>`. */
	settingPath: string;
	/** Short label shown in the UI, e.g. `Position`. */
	label: string;
	type: 'enum' | 'bool' | 'number';
	/** For type='enum': the allowed values. */
	choices?: string[];
	/** For type='number': minimum value. */
	min?: number;
	/** For type='number': maximum value. */
	max?: number;
}

/** Base fields shared by all rule types. */
export interface NinjaRuleBase {
	/** Unique rule ID, e.g. `ninja.cap.keywords`. */
	id: string;
	category: NinjaCategory;
	/** Default severity when no user config overrides it. */
	defaultSeverity: NinjaSeverity;
	/** Short human-readable description of what the rule checks. */
	description: string;
	/** Declares which action kinds this rule may produce. */
	actionKinds?: NinjaActionKind[];
	/** True when this rule's fix actions are safe for bulk auto-fix flows. */
	autoFixable?: boolean;
	/** Configurable options surfaced in the Rule Editor. */
	configOptions?: RuleConfigOptionSpec[];
	/**
	 * Priority for the edit planner's overlap arbitration. Lower wins.
	 * Default 100. Lower values let semantic/structural fixes (e.g. delete an
	 * unused CTE) take precedence over cosmetic ones (e.g. recase a keyword
	 * inside that CTE) when their edits overlap.
	 */
	priority?: number;
}

/** Context passed to token-based rules. */
export interface TokenRuleContext {
	model: DocumentModel;
	document: vscode.TextDocument;
	/** Jinja token positions for the document — omit or pass [] when not available. */
	jinjaTokens?: JinjaToken[];
	config: NinjaConfig;
	/** Authoritative symbol lists from sqlglot for the active dialect. Absent when not yet loaded. */
	dialectSymbols?: DialectSymbols;
}

/** Context passed to layout-based rules. */
export interface LayoutRuleContext {
	text: string;
	lines: string[];
	jinjaTokens: JinjaToken[];
	document: vscode.TextDocument;
	config: NinjaConfig;
	/** Optional parsed document model. When present, sqlTokens carry comment spans via token.comments. */
	model?: DocumentModel;
}

/** A rule that consumes the parsed token stream (DocumentModel). */
export interface TokenRule extends NinjaRuleBase {
	type: 'token';
	check(ctx: TokenRuleContext): NinjaViolation[];
}

/** A rule that consumes raw text with simple string ops. */
export interface LayoutRule extends NinjaRuleBase {
	type: 'layout';
	check(ctx: LayoutRuleContext): NinjaViolation[];
}

export type NinjaRule = TokenRule | LayoutRule;
