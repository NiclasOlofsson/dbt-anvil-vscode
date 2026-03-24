---
applyTo: '**'
description: Workspace-specific AI memory for this project
---
# Workspace AI Memory
This file contains workspace-specific information for AI conversations.

LAW 1: ALWAYS check vscode problems tab for errors before asking for help. Many issues can be resolved by checking the problems tab and fixing any errors listed there.

LAW 2: NEVER use stderr redirection (2>temp_auto/compile-err.txt or /dev/null) in terminal commands - it triggers approval dialog in VS Code. Run commands directly without redirection.

LAW 3: In TypeScript output, always follow this repo's ESLint/Stylistic configuration (see `eslint.config.mjs`) for quotes and string literal style; use single quotes and avoid backtick template literals unless string interpolation is required, and match any other configured quote rules.

LAW 4: NEVER use `sed -i` on project source files — Git Bash on Windows causes `sed -i` to convert LF line endings to CRLF, which then breaks subsequent `replace_string_in_file` tool calls. Use the edit tools exclusively for file modifications.

LAW 5: ALWAYS run tests using `npm test` in the terminal — never use the vitest task runner or `npx vitest run` directly.

## Memories
