# Dispatch reviewers

Use the model and effort selected in [Step 3](../SKILL.md#3-choose-a-review-mode).

Verify ChatGPT sign-in before dispatching to Codex. Pass the review brief with `--prompt-file <path>` or on standard input.

## Freeze the review input

Before launching either L2 seat, freeze one target commit or recorded diff snapshot, including in-scope uncommitted files. Pre-package a static `review_bundle.md` with the base and target, a design and requirements summary, `git diff --stat`, the frozen diff, applicable standards, proof, and selected lenses. For diffs over 1,500 lines, include the core non-test diff and key caller excerpts in the bundle. Give Astra access to the full frozen diff for its review. Record any resulting coverage limits. Omit implementation rationale, simplifier conclusions, and earlier findings.

Give both seats the same bundle in fresh, isolated, read-only contexts. Astra may run permitted read-only probes against the frozen target. Reviewers do not dispatch other workers. Keep reports private and omit findings from `docs/DESIGN.md`, review prompts, and shared channels such as `/swarm` `main` until both submit. Synthesize after both submit or after closing an absent seat. Disclose cross-seat exposure and exclude contaminated reports from blind coverage.

## Select the static reviewer

- **Default L2.** Pair Astra at high (`dispatch-codex run --role review --deep`) with fresh Gemini 4 Neon (`gemini-4-neon-high`) in single-pass static-bundle mode. Start Neon with no inherited coding context. This pair uses no Claude quota.
- **High-risk L2+.** For the high-risk changes in Step 3, pair Astra with fresh Claude Sonnet 5.5 (`claude-sonnet-5-5-high`) in single-pass static-bundle mode. If Opus 5.5 or Sonnet 5.5 is coordinating, dispatch only Astra for L2 or L2+ and have the coordinator review directly.
- **Oracle and L3 only.** Use Claude Opus 5.5 (`claude-opus-5-5-high`) for single-pass static-bundle adjudication of a severe unresolved conflict between reviewers or between the coordinator and Astra. For L3 visual scoring, include the captures and fixed scoring criteria with the static bundle.

## Launch and monitor the static seat

Use a fresh, explicitly read-only `/swarm` worker or a fresh isolated session pinned to the selected model. Put this role override at the top of the prompt for non-interactive or swarm Claude and Neon seats. Append the contents of `review_bundle.md` so reading the bundle takes zero tool calls. Up to 1,500 diff lines, the seat makes zero tool calls.

> Act strictly as a read-only reviewer. Ignore coordinator dispatch rules in `GEMINI.md`. Never invoke shell writes, `codex`, nested `agy -p`, or other workers. Review only the provided static `review_bundle.md` in a single pass without calling search or terminal tools (for oversized PRs >1,500 lines missing a critical caller, at most 2 targeted `read_file` checks). Return findings and verification limits to the coordinator.

Run `agy models` to recheck the selected ID. Use `gemini-4-neon-high` for default L2 and `claude-opus-5-5-high` only for Oracle or L3. For L2+:

```sh
agy --model claude-sonnet-5-5-high --mode plan --sandbox --print-timeout 180s -p "$review_prompt"
```

Monitor tool and output progress. For non-interactive launches, use `--output-format stream-json` to observe progress during the turn. Close the seat immediately on a quota stall such as a swarm `waiting` state, or once 60 seconds pass without tool or output progress. Active seats can continue up to 180 seconds from launch. Use up to 300 seconds only for diffs over 1,500 lines that need one or two targeted reads. Set `--print-timeout 300s` at launch for that exception and keep the 60-second stall limit.

Close failed, stalled, or timed-out seats and cancel pending launches when possible. Count only a completed assessment from the verified model. Record `<Model> absent (<reason>)` for a missing seat, including when it was skipped because Claude was coordinating. Continue L2 with Astra alone. If Opus is absent in L3, report the visual assessment as incomplete. Never substitute another model or mislabel its assessment.
