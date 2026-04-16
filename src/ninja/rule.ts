import type * as vscode from 'vscode';
import type { NinjaCategory } from './categories';
import type { NinjaViolation } from './violation';
import type { DocumentModel } from '../services/parse-service';
import type { JinjaToken } from '../dbt/jinja-tokenizer';
import type { NinjaConfig } from './config';
import type { DialectSymbols } from '../ftl/sql-parser';

/** Severity for a rule: 'error' | 'warning' | 'info' | 'hint' | 'off'. */
export type NinjaSeverity = 'error' | 'warning' | 'info' | 'hint' | 'off';

/** Describes the fix capabilities of a rule's violations. */
export type NinjaFixCapability = 'auto' | 'codeActionOnly' | 'snippet' | 'none';

/** Base fields shared by all rule types. */
export interface NinjaRuleBase {
	/** Unique rule ID, e.g. `ninja.cap.keywords`. */
	id: string;
	category: NinjaCategory;
	/** Default severity when no user config overrides it. */
	defaultSeverity: NinjaSeverity;
	/** Short human-readable description of what the rule checks. */
	description: string;
	/** What kind of automatic fix this rule can provide. Defaults to 'none' if omitted. */
	fixes?: NinjaFixCapability;
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
