import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Command, Flag } from "effect/unstable/cli"

import { DispatchError, efforts, resetTask, roles, runBatch, runDispatch, taskStatus } from "./DispatchCodex.ts"

const optionalText = (name: string, description: string) => Flag.string(name).pipe(
  Flag.withDescription(description), Flag.optional, Flag.map(Option.getOrUndefined)
)

const locationFlags = {
  cwd: optionalText("cwd", "Git working directory, defaults to the current directory"),
  stateDir: optionalText("state-dir", "State root, defaults to XDG_STATE_HOME/agy-dispatch or ~/.local/state/agy-dispatch")
}
const dispatchFlags = {
  stateDir: locationFlags.stateDir,
  codexBin: optionalText("codex-bin", "Codex executable, defaults to codex"),
  allowMnt: Flag.boolean("allow-mnt").pipe(Flag.withDescription("Allow execution under /mnt")),
  dryRun: Flag.boolean("dry-run").pipe(Flag.withDescription("Validate and print the plan without creating worktrees or recording attempts")),
  json: Flag.boolean("json").pipe(Flag.withDescription("Print a JSON receipt on stdout"))
}

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2))
const reportErrors = (json: boolean) => Effect.catch((error: { readonly message: string }) => {
  const failure = error instanceof DispatchError ? error : new DispatchError({ message: error.message, exitCode: 1 })
  return Effect.andThen(json
    ? printJson({ ok: false, exitCode: failure.exitCode, error: failure.message })
    : Console.error(failure.message), Effect.fail(failure))
})

type BatchReceipt = Effect.Success<ReturnType<typeof runBatch>>[number]

const renderReceipt = (receipt: BatchReceipt) => [
  `${receipt.taskId === undefined ? "" : `${receipt.taskId}: `}${
    "dryRun" in receipt ? "dry run" : receipt.ok ? "completed" : `failed (exit ${receipt.exitCode})`
  }`,
  `Worktree: ${receipt.worktreePath}`,
  ...("dryRun" in receipt ? [
    `Command: ${[receipt.command, ...receipt.args].map((arg) => JSON.stringify(arg)).join(" ")}`,
    `Create worktree: ${receipt.createWorktree ? "yes" : "no"}`,
    `Recorded attempts: ${receipt.attempts}; Sol failures: ${receipt.solFailures}`
  ] : []),
  ...(receipt.baseHead === null ? [] : [`Base HEAD: ${receipt.baseHead}`]),
  ...receipt.changedFiles.map((file) => `Changed: ${file}`),
  ...receipt.untrackedFiles.map((file) => `Untracked: ${file}`),
  ...(receipt.diffStat === "" ? [] : [receipt.diffStat]),
  ...("error" in receipt && receipt.error !== undefined ? [receipt.error] : [])
].join("\n")

const run = Command.make("run", {
  ...locationFlags,
  ...dispatchFlags,
  role: Flag.choice("role", roles).pipe(Flag.withDescription("Routing role")),
  effort: Flag.choice("effort", efforts).pipe(
    Flag.withDescription("Reasoning effort defaults to medium for scout/impl, high for redteam/review, and xhigh for escalate"),
    Flag.optional, Flag.map(Option.getOrUndefined)
  ),
  deep: Flag.boolean("deep").pipe(Flag.withDescription("Route a review to Astra")),
  taskId: optionalText("task", "Stable task ID required for impl and escalate"),
  worktree: optionalText("worktree", "Explicit worktree root, relative to --cwd"),
  branch: optionalText("branch", "Branch to create with a new worktree, defaults to a detached HEAD"),
  prompt: optionalText("prompt", "Inline assignment, defaults to stdin when no prompt file is given"),
  promptFile: optionalText("prompt-file", "Read the assignment from this file"),
  output: optionalText("output", "Write Codex's last message to this file"),
  outputSchema: optionalText("output-schema", "JSON schema for Codex's last message"),
  forceSol: Flag.boolean("force-sol").pipe(Flag.withDescription("Allow Sol after two Sol failures")),
  reset: Flag.boolean("reset").pipe(Flag.withDescription("Start a fresh retry cycle for this task"))
}, Effect.fn("dispatch-codex.run")(function*(options) {
  const receipt = yield* runDispatch(options).pipe(reportErrors(options.json))
  yield* options.json ? printJson(receipt) : Console.log(renderReceipt(receipt))
  if (!receipt.ok) return yield* new DispatchError({ exitCode: receipt.exitCode, message: receipt.error ?? "Dispatch failed." })
})).pipe(Command.withDescription("Dispatch one Codex assignment"))

const batch = Command.make("batch", {
  ...dispatchFlags,
  plan: Flag.string("plan").pipe(Flag.withDescription("JSON file containing an array of tasks under the tasks key")),
  concurrency: Flag.integer("concurrency").pipe(
    Flag.filter((value) => value >= 1 && value <= 4, () => "Concurrency must be between 1 and 4."),
    Flag.withDefault(2),
    Flag.withDescription("Maximum simultaneous tasks, from 1 to 4")
  )
}, Effect.fn("dispatch-codex.batch")(function*({ plan, concurrency, ...options }) {
  const receipts = yield* runBatch(plan, concurrency, options).pipe(reportErrors(options.json))
  yield* options.json ? printJson(receipts) : Console.log(receipts.map(renderReceipt).join("\n\n"))
  if (receipts.some((receipt) => !receipt.ok)) {
    return yield* new DispatchError({ exitCode: 1, message: "One or more batch tasks failed." })
  }
})).pipe(Command.withDescription("Dispatch independent tasks in distinct Git worktrees"))

const taskFlags = {
  ...locationFlags,
  taskId: Flag.string("task").pipe(Flag.withDescription("Task ID used with run or batch"))
}

const status = Command.make("status", {
  ...taskFlags,
  json: dispatchFlags.json
}, Effect.fn("dispatch-codex.status")(function*({ taskId, json, ...options }) {
  const state = yield* taskStatus(taskId, options).pipe(reportErrors(json))
  yield* json ? printJson(state) : Console.log(
    `${taskId}: ${state.status}, ${state.attempts} attempts, ${state.solFailures} Sol failures`
  )
})).pipe(Command.withDescription("Inspect the recorded state of a write task"))

const reset = Command.make("reset", taskFlags, Effect.fn("dispatch-codex.reset")(function*({ taskId, ...options }) {
  yield* resetTask(taskId, options).pipe(reportErrors(false))
  yield* Console.log(`Cleared retry state for ${taskId}.`)
})).pipe(Command.withDescription("Clear retry state for a task with no active dispatch"))

Command.make("dispatch-codex").pipe(
  Command.withDescription("Dispatch bounded Codex assignments using ChatGPT sign-in"),
  Command.withSubcommands([run, batch, status, reset]),
  Command.run({ version: "1.0.0" }),
  Effect.catchTag("DispatchError", (error) => Effect.sync(() => {
    // Let Node flush the receipt before exiting with a nonzero status.
    process.exitCode = error.exitCode
  })),
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
