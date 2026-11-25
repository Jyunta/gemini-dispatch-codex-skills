---
name: agy-codex-orchestrator
description: 'Use when orchestrating GPT-6.2 Sol or Astra via dispatch-codex for red-team review, atomic implementation, escalation, code review, or parallel worktree batches.'
---

# Orchestrate Codex

Verify ChatGPT sign-in with `codex login status` before dispatching. Use `dispatch-codex --help` and each subcommand's help for options. Start with `run --dry-run` when routing, worktree, or retry state needs checking.

Use Gemini 4 Neon (`gemini-4-neon-high`) to coordinate GPT-6.2 Sol and GPT-6.2 Astra. Switch coordination to Claude Opus 5.5 or Sonnet 5.5 when the Gemini quota is exhausted. Reserve Gemini 4 Carbon (`gemini-4-carbon-high`) for manual selection by the user.

Choose the role for the assignment.

- Use `redteam` to challenge a design or implementation with evidence. Ask for findings and verification limits.
- Use `review` for a findings-only code review. Use `--deep` for a harder review that needs Astra.
- Use `scout` for routine read-only codebase exploration under both Neon and Claude coordinators. It uses GPT-6.2 Sol at `medium` by default with `--ephemeral`. Use `--effort low` for simple lookups.
- Use `impl` for a bounded implementation with a stable task ID. Sol defaults to `medium`. Pass `--effort low` for trivial docs or scaffolding, or `--effort high` or `--effort xhigh` for complex logic or refactors. Specify the expected behavior and checks.
- Use `escalate` with the same task ID when the dispatcher blocks another Sol attempt. Include the unresolved failure and available evidence.

Scope each `scout` and `impl` assignment to the target directories and relevant files to stay well under Sol's 272K-token long-context threshold.

Switch to Gemini 4 Hydrogen (`gemini-4-hydrogen-low` or `gemini-4-hydrogen-medium`) only in these two emergencies.

1. A single input exceeds 272K tokens or debugging requires audio or video. Hydrogen has flat pricing across its 1M-token context and supports audio and video natively.
2. ChatGPT Plus hits its 5-hour cap. Use Hydrogen temporarily until the quota resets.

Use `batch` for independent assignments in distinct explicit worktrees. Inspect every receipt, including successful siblings of failed tasks. For implementation, verify the reported changes and run the relevant checks in the reported worktree. For review, verify findings against the assigned revision.

Use `status` to inspect task state. When the hard limit stops a task, report the attempts and unresolved evidence. Reset the task only with the user's approval to start a new retry cycle.
