# Repository instructions

## Scope

This repository contains a Windows development-environment proposal and a local Codex plugin project.
The current stage is repository initialization and scope documentation.
Read README.md and the relevant document under docs/ before changing behavior.
Keep planned features separate from implemented and verified features.

## Development

Preserve the target project's runtime versions, package manager, build commands, and deployment path.
Inspect the existing environment before proposing additional installations.
Do not install dependencies or tools merely to populate the initial repository structure.
Use existing Codex capabilities where they satisfy the workflow.
Add an MCP server only when a concrete capability requires one.
Keep plugin source separate from account registration, installation, and publication.
Do not introduce mandatory workflow dependencies without a task-related reason.

## Windows commands

Use native PowerShell commands for Windows file operations.
Use literal paths and verify computed targets before recursive moves or deletions.
Distinguish Windows and WSL paths, executable resolution, and working directories.
Keep diagnostic commands separate from environment changes.
Apply only changes within the user's requested scope.
Never print credentials or copy machine-specific credentials into the repository.

## Evidence and documentation

Use primary sources for technical recommendations.
Record the source date and applicability when a recommendation depends on current product behavior.
Distinguish observed behavior, documented behavior, proposals, and untested hypotheses.
Provide a reproducible check and a falsification condition for causal or performance claims.
Verify changed behavior on the real artifact before reporting completion.
Keep verification proportional to the change.

Write user-facing documentation in Korean unless the task specifies another language.
Use one purpose per document, one topic per paragraph, and one thought per sentence.
Put each sentence on a separate line.
Use the Mermaid chart type that matches the relationship being explained.
