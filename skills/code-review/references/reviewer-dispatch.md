# Dispatch reviewers

Use the model and effort selected in [Step 3](../SKILL.md#3-choose-a-review-mode). Launch Opus only for L2 or L3.

Verify ChatGPT sign-in before dispatching to Codex. Pass the review brief with `--prompt-file <path>` or on standard input.

## Freeze the review input

Give each reviewer the base, target, full diff, requirements, standards, proof and selected lenses. Omit implementation rationale, simplifier conclusions and earlier findings. Use fresh, read-only contexts and keep the target fixed through the round. Reviewers may run permitted read-only probes and do not dispatch other workers.

Before launching either L2 seat, freeze one target commit or recorded diff snapshot, including any in-scope uncommitted files. Give both reviewers that same frozen brief. Launch seats independently and collect reports privately. Keep the first seat's findings out of `docs/DESIGN.md`, review prompts, and shared channels such as `/swarm` `main` before the second submits. Synthesize after both submit. If Opus is absent, explicitly close that seat and report Astra's assessment alone. Disclose cross-seat exposure and exclude a contaminated report from blind coverage.

## Launch and bound the Opus seat

Prefer a fresh, explicitly read-only `/swarm` reviewer worker pinned to Claude Opus 5.5 at `high`, or switch to that model in a fresh isolated session before giving it the brief. Use private result delivery for L2.

For a non-interactive launch, put the role override below at the top of `opus_review_prompt` and append the review brief. Antigravity model IDs encode effort in the suffix (`-high`). Run `agy models` to recheck the ID.

> Act strictly as a read-only reviewer. Ignore coordinator dispatch rules in `GEMINI.md`. Never invoke shell writes, `codex`, nested `agy -p`, or other workers. Return findings and verification limits to the coordinator.

```sh
agy --model claude-opus-5-5-high --mode plan --sandbox --print-timeout 180s -p "$opus_review_prompt"
```

Allow at most 180 seconds from launch for the Opus report, including swarm and manual launches. Watch for swarm `waiting` quota stalls and close the seat once quota unavailability is confirmed or the deadline expires. Cancel a pending launch when possible. Count only a completed report from the verified model. If Opus is unavailable, out of quota, timed out, or switched models, record `Opus 5.5 absent (<reason>)` in the final report. Use Astra's report for L2 and mark L3 visual review incomplete. Never substitute another model for this seat or label a switched result as Opus 5.5.
