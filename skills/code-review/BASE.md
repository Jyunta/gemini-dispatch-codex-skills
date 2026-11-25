---
name: code-review
description: 'Use when asked to review code or a PR, before marking a PR ready, or to polish UI to a target score.'
metadata:
  source: https://github.com/mattpocock/skills
  source-path: skills/engineering/code-review
  source-revision: abeeaf95660ba9e8b7c753eb38f441ca707a8823
  sources: |
    - Independent review informed by Theo’s [tstack council](https://github.com/t3dotgg/tstack/blob/1085050f3baed1ac724caa4a8166145fb2ac88af/skills/council/SKILL.md).
    - UI polish mode informed by Theo’s [Agents Sucked At UI (Until Today)](https://www.youtube.com/watch?v=xq0eB8vxeqk), reviewed 2026-11-13.
---

# Code review

Simplify the change, then use the review ladder to assess it and any affected UI.

## 1. Establish the change

Identify the target and its actual or planned PR base, using a commit's parent only for a single-commit review. Review the whole intended change, preserve unrelated work, and record the base. Derive requirements from the task, docs and callers, stating the inferred contract when there is no spec.

Honor narrower requests and report their limits. Findings-only permits inspection and proposals, not edits. A single-review request runs only that assessment. A request for one lens (such as standards only or correctness only) limits work to that lens. Use the harness's native command for native review. Run [ClawSweeper](references/clawsweeper.md) only when separately requested.

## 2. Simplify

Give one implementation agent the target, requirements, owned files, repair authority and checks. Run this pass even after implementation. Claude and Gemini coordinators use the [implementation handoff](references/codex-implementation.md) for every edit. A Codex coordinator may simplify directly when dispatch is unavailable and disclose that.

- **Remove waste.** Limit the pass to changed and directly affected code, tests and fixtures, including accidental generated-file changes. Check callers before deleting guards, cleanup, error handling, public contracts or tests. Apply [writing-good-tests](../writing-good-tests/SKILL.md) and distinguish test consolidation from retirement without replacement.
- **Name things from their uses.** Read definitions and callers together. Prefer `sendNotification` to `executeNotificationDispatch`. Keep meaningful units such as `expiresAtMs` and use domain terms when they are clearer. Update definitions and uses together. Change public contracts only when authorized.
- **Make the flow readable on the first pass.** Keep related work together and trace each branch's result, including fields added, moved or omitted. Extract a function if its name clarifies a step. Keep it inline if the jump makes reading harder. Skip changes based only on taste.
- **Check React prop contracts.** Use [typescript-discipline](../typescript-discipline/SKILL.md#react-prop-contracts) to establish supported caller states before removing optionality or fallbacks.

The simplifier returns its patch, a concrete before/after explanation, checks and unresolved concerns, or proposals for findings-only work. Integrate and resolve verification failures before review.

## 3. Choose a review mode

Honor the user's explicit review scope. Otherwise, choose the applicable tier and proceed.

- **L1 — Single reviewer (default).** Launch one fresh findings-only **GPT-6.2 Sol** reviewer at **high** via `dispatch-codex run --role review` for ordinary features, bug fixes, tests, docs, clean rebases and small follow-ups. Keep Opus off for L1, including when Sol is unavailable.
- **L2 — Two-model blind review.** Use L2 for an explicit deep review, broad changes across packages or subsystems, changes to public APIs or contracts, or a severe, disputed or hard-to-diagnose blocker after L1. Escalate before asking the user to settle an inconclusive finding. The default pairs fresh findings-only **GPT-6.2 Astra** at **high** (`dispatch-codex run --role review --deep`) with a fresh, isolated **Gemini 4 Neon** seat (`gemini-4-neon-high`) that reads the pre-packaged static `review_bundle.md`. This pair uses no Claude quota.
  - **L2+ — High-risk upgrade.** For authentication, permissions, security, privacy, billing, payments, migrations, persisted formats, release or CI pipelines, or major pre-release changes, use fresh **Claude Sonnet 5.5** (`claude-sonnet-5-5-high`) in place of Neon. Sonnet reviews the static bundle in a single pass and provides an independent Anthropic assessment at half Opus's quota weight.
  - **Claude coordinator.** If Opus 5.5 or Sonnet 5.5 is coordinating, run Astra alone with `--deep` and have the coordinator review directly.
- **L3 — UI and visual polish.** Use for substantial UI changes or a request to polish or score the UI. Use L1 or L2 for code review when it also applies. Have **Claude Opus 5.5** at **high** score the captures against fixed `design` criteria in a single pass. For polish requests, use the [UI polish scoring and single-reviewer rules](references/ui-polish.md) throughout, with one Opus scorecard per round including the final round. Route authorized fixes via `dispatch-codex run --role impl` and recapture the affected UI.

Reserve **Claude Opus 5.5** for L3 visual scoring and single-pass static-bundle Oracle adjudication when two reviewers, or a coordinator and Astra, have a severe conflict that the evidence has not resolved.

For a standalone follow-up or clean rebase after a finished review, apply the triggers to what changed since that review. Verify the rebased diff with whitespace preserved, for example with `git range-diff` or by inspecting conflict hunks. Use `git patch-id --stable` only to match corresponding commits. Review the new revision.

For any affected UI, use `frontend-ui-validation` to capture the screens and exercise interactions before review. Set fixed criteria and gather proof using the [affected UI rules](references/affected-ui.md).

### Launch independent reviewers

Follow [reviewer dispatch](references/reviewer-dispatch.md) to pre-package a static `review_bundle.md` before launching L2 and keep each seat's findings private until both submit. Claude seats review in a single pass, with zero tool calls for diffs up to 1,500 lines and at most two targeted `read_file` checks for larger diffs. Close a static seat immediately on a quota wait or after 60 seconds without tool or output progress. Allow active progress up to the 180-second ceiling, or up to 300 seconds for oversized diffs that require targeted reads. If the second seat is absent, close it, record `<Model> absent (<reason>)`, and continue L2 with Astra. Use [wait-efficiently](../wait-efficiently/SKILL.md) for pending results.

Count only fresh assessments from the selected models at high on that revision. Disclose context contamination and record missing models with reasons. L1 requires Sol, L2 requires Astra, and L3 requires a verified Opus visual assessment. Report any tier missing its required assessment as incomplete.

### Apply both lenses

Each L1 and L2 reviewer uses both lenses unless the request narrows the lens, and reports every supported finding, including minor ones.

- **Standards:** [coding-standards](../coding-standards/SKILL.md), step 2's readability rules, diff waste, unnecessary complexity, and [writing-good-tests](../writing-good-tests/SKILL.md) for test additions, keepers and deletions. Cite relevant standard IDs and exceptions. A maintenance finding shows the confusing code, its present reading or change cost, and a simpler behavior-preserving alternative.
- **Requirements and correctness:** trace real entry points through failure and recovery to the consumer-visible result. Look for missing, incorrect or unrequested behavior. Ask what consequential defect could pass existing tests and what runtime or persisted-state evidence would expose it. Exercise every reader, including tools and UIs, with pre-change state when data formats change. Apply typescript-discipline and relevant domain lenses.

For each finding, give its location, expected behavior, reachable trigger and likelihood in supported use, consequence, evidence and proposed Step 4 severity. Separate source inspection from executed proof. An empty findings list is valid, but proves no coverage. State confidence in the reviewed revision, why, and what remains unverified. Supported findings take precedence over confidence.

## 4. Repeat rounds until only minor findings remain

Keep one round record across resumes with each reviewed revision, actual models and efforts, findings, confidence, decisions and severities with reasons, fixes and resulting revision. Stop retrying repeated dispatch failures and report the gap. Skip another simplification pass between rounds.

### Confirm findings and assign severity

Confirm bugs through real callers and supported inputs and check counterevidence. Type-permitted or invented states are insufficient. Resolve duplicates and disagreements from evidence. Give supported minority findings a disposition. Record rejected findings repeated without new evidence as disagreements and keep them rejected.

The coordinator sets severity for all confirmed findings, including its own. Consider the reviewer's proposed severity.

- **Blocking:** the change introduces it or makes it reachable in supported use, and the result is wrong output, lost or corrupted data, a security or permission failure, a broken requirement or contract, a UI failure that stops or misleads the user in the affected journey, or substantial unnecessary complexity with a simpler behavior-preserving alternative.
- **Minor:** supported use reaches it, but the consequence is cosmetic, easily recovered or confined to unusual use. Fix it when the fix is small; otherwise defer it with a reason. On its own it does not justify another round.
- **Not actionable:** a preference, a check tooling already settles, a non-blocking finding whose fix would add unrequested behavior or options, or a trigger that needs several independent unlikely conditions for a recoverable consequence. Reject it.

Settle unclear triggers from callers, deployment and targeted probes, not the worst case. To act on a race, timing or ordering finding, show which actors run concurrently in supported deployments, the interleaving and what breaks. A rare trigger still blocks when its consequence is severe and hard to recover from, such as corrupted persisted data, a security breach or lost user work. Report other serious defects in affected behavior as non-blocking concerns with evidence.

### Decide whether to repeat

Route authorized fixes and selected UI improvements through Step 2's implementation policy. Verify repaired and preserved behavior and recapture changed UI. A contained fix stays within its finding, preserves other behavior, contracts, persisted data, security and permissions, and passes relevant checks.

- **Run another round** after a blocking fix, a selected UI improvement or an uncontained fix. Keep the tier unless repairs introduce a Step 3 trigger or a post-round blocker escalates L1 to L2. Honor explicit review scope and the L3 polish round limit. Fresh reviewers assess the full resulting change under the same criteria.
- **Finish** when the reviewed revision has no blocking findings and no other round trigger applies. Report any contained fixes the coordinator verified by checks after the round.
- **Stop and ask the user** if fixes keep producing new blockers in touched code, a blocker survives repeated repairs, or evidence cannot settle whether a finding blocks. If Round 2 repairs keep surfacing architectural or failure-mode blockers in one subsystem, agree on a short design covering invariants, recovery behaviour and tests, or narrow scope before another implementation round. Also stop if missing evidence, tools or authority blocks further work. Report the pattern, evidence and decision needed. For read-only advice, prefer GPT-6.2 Astra at high. Use the Step 3 Opus Oracle for severe unresolved review conflicts. For other hard decisions, use Claude Fable 5.2 at high or the native Claude `oracle` role.

## 5. Report and finish

Report the tier, assessed revision, actual models and efforts for the final round.

- **L1.** Report Sol's findings and verification limits.
- **L2.** Report both independent assessments when available. For Astra-only coverage, include `<Second-seat model> absent (<reason>)` with the reason the seat closed or was skipped, for example `Neon absent (<reason>)` or `Sonnet 5.5 absent (<reason>)`.
- **L3.** Report Opus's visual findings, the captured states and viewports, and any scorecard and target. If Opus is missing, include `Opus 5.5 absent (<reason>)` and report the visual review as incomplete.

`code-review` completes when simplification is done, the selected tiers have the required assessments, the reviewed revision has no blocking issues, only contained fixes follow, applicable UI criteria have capture and interaction proof, and required checks pass. Apply the L3 polish completion criteria when applicable. Report an incomplete result if any condition fails. A stop for non-convergence or missing evidence does not approve the change.

Report useful simplifications and a concise account of each round. Include why it ran, reviewer confidence and its evidence limits, missing assessments and reasons, which fixes received later review, unresolved disagreements and residual concerns. Never carry confidence onto later edits or call unreviewed repairs approved.

Put the report in chat, or in an existing PR description when updating that PR is authorized, and leave readiness and the check-in to the caller. Include any [show-video](../show-video/SKILL.md) recording; a clean or findings-only review needs no new one by itself.

