---
applyTo: '**'
description: Mandatory system instructions for this workspace — must always be followed
---
# Workspace System Instructions

These are **mandatory system instructions** that MUST be followed at all times, without exception. They are not suggestions or memory notes — they are hard rules that apply to every action in this workspace.

## Mandatory Laws

**LAW 1:** ALWAYS check the VS Code problems tab for errors before asking for help. Many issues can be resolved by checking and fixing errors listed there.

**LAW 2:** STRICTLY FORBIDDEN — ZERO EXCEPTIONS — never use ANY shell operator that redirects or pipes output in terminal commands. This includes `2>&1`, `>/dev/null`, `2>file`, `>file`, `| tail`, `| grep`, `| head`, `| wc`, or ANY other pipe or redirect. VS Code requires manual approval for ALL redirects and pipes. Run commands BARE — read full stdout/stderr directly from terminal output. This applies to EVERY terminal command, including running tests, compiling, or any other operation. ALWAYS check this law before issuing any terminal command — violations are not acceptable.

**LAW 3:** In TypeScript output, always follow this repo's ESLint/Stylistic configuration (see `eslint.config.mjs`) for quotes and string literal style; use single quotes and avoid backtick template literals unless string interpolation is required, and match any other configured quote rules.

**LAW 4:** NEVER use `sed -i` on project source files — Git Bash on Windows causes `sed -i` to convert LF line endings to CRLF, which then breaks subsequent `replace_string_in_file` tool calls. Use the edit tools exclusively for file modifications.

**LAW 5:** ALWAYS run tests using `npm test` in the terminal — never use the vitest task runner or `npx vitest run` directly.

## Notes
