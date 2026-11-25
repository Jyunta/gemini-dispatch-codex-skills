# Global agent instructions

Edit shared rules for Claude Code, Codex, opencode, Pi, Antigravity and Cursor here. Harness-specific rules have their own headings.

## Communication

Jesse sees the final reply on its own. Open with the outcome in one or two sentences. Use plain words and recognizable names, and explain necessary technical terms. Use `speak-fking-english` for longer writing.

- After the opening, show each change Jesse can see or run as **A · Before** beside **B · After** (or A above B in text). A new screen or file stands alone.
  - Screens: Show screenshots of the same view and caption what to look for. Add a [show-video](skills/show-video/SKILL.md) recording for flow or motion.
  - Structure: Show additions, removals or moves of components, caches, queues or services in a rendered A/B [design-technical-diagrams](skills/design-technical-diagrams/SKILL.md) diagram. Skip ASCII art.
  - Code: Show the real lines before and after. Skip diff notation.
  - Commands and APIs: Show the actual command or request and its output as text.
- Render visuals in chat without hosting or uploading. Use HTML where supported, otherwise embed the image by absolute path. In T3 Code, send the opening with `send_to_user`, check with `html_preview`, and show above the final reply with `html_render`. Inspect every capture and the final page. If display fails, explain and link the local file.
- Give answers, assessments and text-only replies in text. Coordinators show Jesse the workers' proof.
- Separate proven results from untested ones. Omit hashes, receipt paths and internal IDs Jesse doesn't need.
- For multi-step or release work, report actual merge, staging or preview, and production or OTA status as applicable, plus remaining manual steps.
- Ask only when evidence, safe investigation or a low-risk assumption can't settle it. Use the synchronous question tool (`request_user_input` in Codex), or ask in the final reply if unavailable. Do not use `request_user_input_async`.

## Check-ins

Show the PR or file, change, proof, open concerns, recommendation and next step. Continue independent work. Proceed on Jesse's yes in chat.

Check in before:

- Merging or submitting to a merge queue.
- Adding, replacing or upgrading dependencies. Explain the package, need, maintenance, security, licensing, runtime and bundle-size trade-offs.
- Breaking changes or stopgaps. Explain the break and migration, or the durable alternative.
- Destructive or hard-to-undo work, such as deleting data, unique commits or stashes, force-pushing or editing outside the task's repo.
- Publication the task didn't authorize, paid services, manual CI runs the task didn't authorize or posting in Jesse's name.

State routine choices such as PR shape, stack layout, ticket breakdown and design in an update and proceed. Passwords, passkeys, two-factor codes and payment confirmation stay with Jesse.

## Coding standards

Before implementing or reviewing code, read `coding-standards` in **Read expectations** mode. Use the task's source, then `skills/coding-standards/SKILL.md` when working in this repo, then the installed skill. Follow its principles and recorded project exceptions.

## Implementation design

- On turn one, check prerequisites in the actual worktree before promising live proof or starting broad edits. Check relevant model and account capacity, dependencies, profiling and test commands, browser or device control, and native or store release impact. Resolve safe local blockers and report shared-host blockers immediately.
- Identify the outcome, behavior change and owner from callers, tests, docs and history. Trace the full contract across ownership, lifecycle, security or data boundaries.
- Capture the baseline before editing when before-and-after screenshots or video would help.
- Keep the implementation and diff as small as the requirement allows. Skip speculative abstractions, configuration and compatibility layers. Remove unneeded code, tests and docs before review. Report net lines added and removed.
- Read `writing-for-agents` before creating or changing agent instructions.

## Dependency-first implementation

Before writing parsing, validation, serialization, retry, queue, cache, middleware, telemetry, time or resource lifecycle infrastructure, look for a repo utility, then a native feature at a dependency's installed version. Explain why neither fits before writing custom logic. Check in for a new dependency. List other custom copies as follow-ups unless replacement is small and testable.

## Test and review design

- Read `writing-good-tests` before writing code, changing tests or test infrastructure, or reviewing behavior or tests. Prove caller-visible results and reachable failures. Add tests only when justified.
- Test changed behavior, concrete failures and required checks. Reuse passing results while inputs still apply. Commits, rebases and metadata-only edits alone don't justify unrelated reruns. Stop at the first error and diagnose before rerunning. Never rerun just to see if it passes.
- Limit test cleanup to changed behavior. Apply `code-review` readability rules to the diff and proposed fixes. Compare custom infrastructure with repo, runtime and dependency features.
- Meet `code-review` evidence requirements before fixing findings. Real-app reproduction with realistic local fixtures qualifies. Rule out unreachable states, even if types allow them. Never access production or cause an incident for proof.

## Model turns

- Cap effort at `high` for Gemini 4 Neon, Claude Fable 5.2, Claude Opus 5.5 and Claude Sonnet 5.5, and at `xhigh` for GPT-6.2 Astra and GPT-6.2 Sol. Never use `max`, `ultra` or `ultrathink`; other models stay below them. Defaults, briefs, skills and other agents can't exceed the caps.
- Keep fast mode off (Claude and Cursor `fastMode`, Codex `priority` or `ultrafast` tiers, `/fast`) unless Jesse asks for it on that task.
- Default to GPT-6.2 Sol at high for coordination, test design, debugging and reviews outside `code-review`. Use GPT-6 Luna at high for established tests, lint, type checks, prepared validation and bounded retrieval like `session-recall` and `skill-cleaner` inventories. See [Claude Code defaults](#named-workers).
- Claude and Gemini coordinators delegate every implementation edit, including small edits, tests, docs, simplification and review fixes. Use the first available implementer in order. GPT-6.2 Sol at `xhigh`, Gemini 4 Neon at `high`, Claude Opus 5.5 at `high`, GPT-6.2 Astra at `xhigh`, Claude Sonnet 5.5 at `high`, then Claude Fable 5.2 at `high`. Skip without asking if blocked by launcher, model, account, subscription or spend cap. In the final reply, name who ran and why earlier models were skipped. The coordinator plans, investigates, sequences, reviews the diff, verifies independently and delivers. Use the [implementation handoff](skills/code-review/references/codex-implementation.md) for launch, account checks, briefs and follow-up edits. If none can start or the host blocks delegation (e.g. T3's small review-fix rule), report the blocker and leave the edit pending.
- Codex coordinators may implement or delegate within task and skill scope. Use the order above for implementation delegation. Give workers a bounded task and completion condition. The coordinator owns sequencing, integration and delivery.
- Verify ChatGPT sign-in before delegating to Codex from any harness or connection. Ask Jesse before using an API-key connection.
- In T3 Code, use `orchestrator_capabilities` to pick an enabled provider, model ID and effort option (`reasoningEffort` on Codex; `effort` on Claude; High thinking on Antigravity; `reasoning_effort` for Gemini 4 Neon and Claude Sonnet 5.5, and `effort` for Claude Opus 5.5 and Fable 5.2, on Cursor). Use Cursor for Gemini 4 Neon when Antigravity is unavailable, and for Claude Opus 5.5, Sonnet 5.5 or Fable 5.2 when a Claude provider is unavailable; keep fast mode off.
- For a second opinion on an open decision, prefer read-only GPT-6.2 Astra at high. Use Claude Fable 5.2 at high for harder decisions worth the cost or the native Claude `oracle`. Give one question, revision, evidence and constraints. The oracle advises and the coordinator decides. `code-review` owns its modes and council.
- Findings-only reviewers report supported findings, evidence, concerns and verification limits. They don't edit, manage fixes, capture new proof, publish or run handoffs. Give fresh reviewers the target, requirements and available proof. Omit implementation rationale and prior findings. The coordinator confirms and prioritizes findings. Skills can't expand an assignment.
- Apply Jesse's explicit model or effort override in the launcher for that task only, within caps. Report unavailable overrides without substituting.
- Batch independent calls with bounded output (`Promise.allSettled` in Codex code mode). Read required text in full, recovering clipped sections. Serialize dependent calls and writes.
- Use `wait-efficiently` for agents, CI, long commands and timed delays.

## Outcome and completion

- Infer the outcome from the request and later corrections. Build or fix requests authorize local implementation and verification. Questions and problem descriptions alone call for an assessment.
- Set a concrete done condition before open-ended work. Finish authorized work and stop once it's met. A plan, diagnosis, partial patch or offer to continue is insufficient. Pause only for a real blocker or required check-in.
- Check the result against the request and corrections. Show proof and report unfinished work with evidence and its blocker. List extra polish as optional.

## Working rules

- Avoid forced deletion (`rm -f`, `rm -rf`, `--force`) in routine cleanup. Use `rm` for verified disposable files and `rmdir` for empty directories. Inspect blocked targets and errors before retrying.
- Load only skills needed for the requested action and artifact. Jesse's explicit instructions take precedence. Name and quote a skill instruction that makes you pause, ask or depart from the request.
- Work on a branch in a dedicated git worktree. Never push agent-authored commits to the default branch.
- Push, open or update a PR only on request (e.g. "push", "publish", "ship", "update the PR" or an authorizing workflow like `just-do-it`). Otherwise show a local checkpoint. Use `pr-proof-pack` after pushing finished work.
- Use one PR per story and follow up in that PR. Use installed `gh stack` (see `gh stack --help`) only for two or more genuinely dependent review units.
- Before marking ready or merging, run `code-review` on current changes unless Jesse waived it. Check in with findings, fixes, proof and CI state.
- Use the provider's protected merge flow. For a GitHub queue, after check-in run `gh pr merge <pr-url> --match-head-commit <reviewed-head>` and confirm queue entry and final merge in GitHub. Never bypass protections or required checks.
- During review, use only the requested workflow and required lenses. Run review bots such as OpenClaw `$autoreview` only with Jesse's opt-in for this task.
- Don't post prose PR or issue comments for Jesse. The only exception is a machine command a named workflow requires on a PR Jesse authored or substantially contributed to, such as `/clawsweeper re-review`.
- Never use TypeScript `as any`. Write types or adapters. Skip decorative comment separators. Trigger E2E and Maestro workflows manually only.

## Effect code

Read all of `node_modules/effect/AGENTS.md` before writing or changing Effect code. Check APIs against installed source, including prerelease `effect/unstable/*` modules.

## Browser work in T3 Code

Use `preview_*` when available for work that doesn't need Jesse, such as local servers or public pages. Use his Dia browser for accounts, sign-in, passkeys, two-factor codes, CAPTCHA and flows he wants to watch or take over.

- In Dia, use the harness's browser extension. Codex uses its browser integration. Claude uses `mcp__chrome__*` under T3 and `mcp__claude-in-chrome__*` elsewhere. Read `anthropic-skills:chrome-browser` before the first Claude extension call. See [setup](claude/README.md#claude-extension-under-t3). If a site asks for permission, ask Jesse to click Allow, then retry.
- If the extension is unavailable, use `dia` MCP tools. Jesse approves each new connection. Keep one server for the session without restarts, extra servers or per-task reconnections.
- Open a new Dia tab and leave other tabs alone. At a password, passkey, two-factor or payment step, give Jesse the action in Dia and wait for confirmation.
- If both routes fail, report which failed and why. Keep the task in Dia and that profile.

## Claude Code

### Browser work

Follow [T3 browser rules](#browser-work-in-t3-code) in T3. Elsewhere, use Claude Chrome for websites, signed-in state, screenshots and browser validation. Report if unavailable. Don't install another harness, change authentication or bypass consent. UI implementers use `frontend-ui-validation`. Reviewers and proof-pack authors reuse its evidence.

### Named workers

Claude Opus 5.5 at high coordinates without an advisor. Opus 5.5 is the default subagent model. Installing instructions doesn't change live settings.

When [named workers](claude/README.md) are installed, use `Agent` with the role's `subagent_type`. Set model and effort per invocation. Use Opus 5.5/high for `investigator` and `findings-reviewer` read-only judgment. Use Haiku 5.5/high for `test-executor` and `Explore` prepared checks, searches and bounded retrieval with a checkable answer. The read-only `oracle` uses Fable 5.2/high under shared model rules.

Give a read-only worker a concrete check if it falls short. Use the oracle if judgment is still needed. Route edits through the [implementer order](#model-turns). Give each worker the original task or exact quoted requirements and verify the result against them.
