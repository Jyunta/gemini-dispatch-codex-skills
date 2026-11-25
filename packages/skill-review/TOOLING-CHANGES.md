# Skill tooling improvements

## Compatibility and maintenance

- Claude Fable 5.2 uses the Fable 5.1 skill profile as an exact match. Sonnet and Haiku 5.5 and later use the Opus 5.5 profile as a fallback.
- Removed two retired skill entries from the Codex findings-reviewer and oracle profiles.
- Updated the cleanup inventory and proof publication scripts to recognize their command-line entry points. Proof publication help uses the installed command name.

## Review workflow

- Consolidated review guidance around setup, independent review, finding triage, and publication of authorized fixes.
- Reviewers trace findings to reachable behavior. Coordinators weigh likelihood, impact, and repair cost, and record a new diagnosis after two unsuccessful repairs.
- Review tooling records the reviewed revision, pass history, and supporting evidence. The ClawSweeper watcher checks responses against the reviewed revision.

## Skill Review

- Outstanding feedback and requests for re-review have separate indicators. Saved drafts, comments, and retired skill records remain available in history.
- Prepared skill edits are bound to the reviewed revision. The apply command checks for intervening changes and supports guarded rollback.
- Targeted installation updates selected skills in an existing managed view.

## Proof and cleanup tools

- Media helpers inspect recordings, cut clips, and build labeled before-and-after images. UI audits capture screenshots, console errors, and layout findings.
- Proof publication tracks draft and attachment changes and records which local references remain after upload attempts.
- The read-only cleanup inventory gathers Git, process, and optional Compose ownership evidence.
