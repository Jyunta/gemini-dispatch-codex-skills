# Hand off implementation

Antigravity and Gemini coordinators use `dispatch-codex` for implementation edits, including simplification, tests, documentation and authorized review fixes. Claude coordinators follow the implementer order and launcher in `AGENTS.md`. Its model caps and fast-mode rules apply to all launches.

Verify ChatGPT sign-in before dispatch. Give the worker the goal, owned files, constraints, expected behavior and acceptance checks. Choose a stable task ID and pass the assigned worktree explicitly. Use `--branch <name>` if the dispatcher is creating a worktree on a new branch.

```sh
env -u CODEX_API_KEY -u OPENAI_API_KEY codex login status

dispatch-codex run --role impl --effort high --task "$task_id" \
  --worktree "$worktree_dir" --prompt-file "$brief_path"
```

`impl` runs GPT-6.2 Sol at `medium` by default and accepts `--effort low`, `--effort high`, or `--effort xhigh` (pass `--effort high` or `xhigh` for complex review fixes as shown above). After two failed Sol attempts, pass the unresolved failure and evidence to `dispatch-codex run --role escalate` for GPT-6.2 Astra, using the same `--task` and `--worktree`. Use `dispatch-codex status --task "$task_id"` to inspect the attempt state. Stop at three implementation attempts total. Report the unresolved result when the circuit breaker trips. Reset only with the user's approval for a new retry cycle.

After every run, including failures, use both commands to inspect the actual execution worktree.

```sh
git -C "$worktree_dir" status --short --untracked-files=all
git -C "$worktree_dir" diff HEAD --stat
```

Read the full diff and any untracked files, check scope, and independently run the acceptance checks before taking the changes. Report the actual implementer and any escalation or blocker.

## Direct Codex fallback

If the dispatcher is unavailable, use direct `codex exec` only within the same scope and attempt budget. Verify ChatGPT sign-in as above, clear both API-key variables, set the assigned worktree with `-C`, and omit `-a`. Use the model and effort for the current attempt.

```sh
env -u CODEX_API_KEY -u OPENAI_API_KEY codex exec \
  -m gpt-6.2-sol -c 'model_reasoning_effort="high"' \
  -c 'model_provider="openai"' -c 'forced_login_method="chatgpt"' \
  -s workspace-write -C "$worktree_dir" - < "$brief_path"
```

If ChatGPT sign-in cannot be verified, leave the Codex handoff pending and report why. Ask the user before using an API-key connection.
