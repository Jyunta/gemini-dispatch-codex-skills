---
name: agy-codex-orchestrator
description: 'Use when orchestrating GPT-6.2 Sol or Astra via dispatch-codex for red-team review, atomic implementation, escalation, code review, or parallel worktree batches.'
---

# Orchestrate Codex

Verify ChatGPT sign-in with `codex login status` before dispatching. Use `dispatch-codex --help` and each subcommand's help for options. Start with `run --dry-run` when routing, worktree, or retry state needs checking.

Choose the role for the assignment.

- Use `redteam` to challenge a design or implementation with evidence. Ask for findings and verification limits.
- Use `review` for a findings-only code review. Use `--deep` for a harder review that needs Astra.
- Use `impl` for a bounded implementation with a stable task ID. Give the worker the exact scope, allowed files, expected behavior, and checks.
- Use `escalate` with the same task ID when the dispatcher blocks another Sol attempt. Include the unresolved failure and available evidence.

Use `batch` for independent assignments in distinct explicit worktrees. Inspect every receipt, including successful siblings of failed tasks. For implementation, verify the reported changes and run the relevant checks in the reported worktree. For review, verify findings against the assigned revision.

Use `status` to inspect task state. When the hard limit stops a task, report the attempts and unresolved evidence. Reset the task only with the user's approval to start a new retry cycle.
