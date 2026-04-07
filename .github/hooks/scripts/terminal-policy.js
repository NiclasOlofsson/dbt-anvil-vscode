#!/usr/bin/env node
/**
 * PreToolUse hook: Terminal Policy Enforcement
 *
 * Enforces two rules for every terminal tool call:
 * 1. No shell redirect operators (|, >, >>, <, 2>&1, 2>) — blocked outright.
 * 2. Reminds the agent to reuse existing terminal sessions instead of spawning new ones.
 */

const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
	let input;
	try {
		input = JSON.parse(Buffer.concat(chunks).toString());
	} catch {
		process.exit(0);
	}

	const toolName = input.tool_name || '';
	const TERMINAL_TOOLS = ['run_in_terminal', 'send_to_terminal'];

	if (!TERMINAL_TOOLS.includes(toolName)) {
		process.exit(0);
	}

	const command = (input.tool_input && input.tool_input.command) || '';

	// Detect standalone shell redirect/pipe operators.
	// Matches: | pipe; > or >> redirect; < input redirect (not <=); 2>&1 or 2> stderr redirects.
	// Excludes: => (arrow), ->, >= (comparison), </tag (HTML), <= (comparison).
	const REDIRECT_PATTERN = /(?:^|[\s;])(?:\|+|>>?(?!\s*=)|(?<![=\-<>])<<?\s|2>&1|2>>?\s?)(?:\s|$|[^ =])/;

	if (REDIRECT_PATTERN.test(command)) {
		const output = {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'deny',
				permissionDecisionReason:
					'Command contains a shell redirect or pipe operator (|, >, >>, <, 2>&1, 2>). '
					+ 'VS Code requires manual approval for these operators, which blocks execution. '
					+ 'Rewrite the command without redirects: read stdout/stderr directly from terminal output, '
					+ 'use intermediate variables, or write to a file in temp_auto/ via code instead of shell redirection.',
			},
		};
		process.stdout.write(JSON.stringify(output));
		process.exit(0);
	}

	process.exit(0);
});
