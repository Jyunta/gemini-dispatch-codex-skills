import type * as PlatformError from "effect/PlatformError"

import * as Config from "effect/Config"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Runtime from "effect/Runtime"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { createHash, randomUUID } from "node:crypto"
// Effect FileSystem.remove cannot remove an empty directory without recursion.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { rmdir } from "node:fs/promises"
import { homedir } from "node:os"

import { checkedText, platformErrorExitCode } from "../../../packages/effect-cli/CheckedProcess.ts"

export const roles = ["redteam", "impl", "escalate", "review", "scout"] as const
export const efforts = ["low", "medium", "high", "xhigh"] as const
const Role = Schema.Literals(roles)
const Effort = Schema.Literals(efforts)
const Model = Schema.Literals(["gpt-6.2-sol", "gpt-6.2-astra"])
const TaskId = Schema.NonEmptyString
const defaultEfforts = {
  redteam: "high",
  impl: "medium",
  escalate: "xhigh",
  review: "high",
  scout: "medium"
} satisfies Record<typeof Role.Type, typeof Effort.Type>
const isWriteRole = (role: typeof Role.Type) => role === "impl" || role === "escalate"

const BatchPlanJson = Schema.fromJsonString(Schema.Struct({
  tasks: Schema.Array(Schema.Struct({
    taskId: TaskId,
    role: Role,
    effort: Schema.optional(Effort),
    deep: Schema.optional(Schema.Boolean),
    worktree: Schema.NonEmptyString,
    branch: Schema.optional(Schema.NonEmptyString),
    prompt: Schema.optional(Schema.String),
    promptFile: Schema.optional(Schema.NonEmptyString),
    output: Schema.optional(Schema.NonEmptyString),
    outputSchema: Schema.optional(Schema.NonEmptyString)
  }))
}))

const processIdentityFields = { pid: Schema.Int.check(Schema.isGreaterThan(0)), startIdentity: Schema.NonEmptyString }
const LockOwnerJson = Schema.fromJsonString(Schema.Struct({
  ...processIdentityFields,
  token: Schema.String.check(Schema.isUUID(4))
}))
const RetryCounts = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const TaskStateJson = Schema.fromJsonString(Schema.Struct({
  ...processIdentityFields,
  status: Schema.Literals(["running", "done", "failed"]),
  attempts: RetryCounts,
  solFailures: RetryCounts,
  role: Role,
  model: Model,
  effort: Effort,
  worktreePath: Schema.String,
  baseHead: Schema.NonEmptyString,
  updatedAt: Schema.String,
  exitCode: Schema.optional(Schema.Int),
  changedFiles: Schema.optional(Schema.Array(Schema.String)),
  untrackedFiles: Schema.optional(Schema.Array(Schema.String)),
  diffStat: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String)
}))

type TaskState = typeof TaskStateJson.Type

interface LocationOptions {
  readonly cwd?: string | undefined
  readonly stateDir?: string | undefined
}

interface DispatchOptions extends LocationOptions {
  readonly codexBin?: string | undefined
  readonly allowMnt?: boolean | undefined
  readonly dryRun?: boolean | undefined
  readonly json?: boolean | undefined
}

interface RunOptions extends DispatchOptions {
  readonly role: typeof Role.Type
  readonly effort?: typeof Effort.Type | undefined
  readonly deep?: boolean | undefined
  readonly taskId?: string | undefined
  readonly worktree?: string | undefined
  readonly branch?: string | undefined
  readonly prompt?: string | undefined
  readonly promptFile?: string | undefined
  readonly output?: string | undefined
  readonly outputSchema?: string | undefined
  readonly forceSol?: boolean | undefined
  readonly reset?: boolean | undefined
}

export class DispatchError extends Schema.TaggedError<DispatchError>()("DispatchError", {
  exitCode: Schema.Int,
  message: Schema.String
}) {
  override get [Runtime.errorExitCode]() { return this.exitCode }
}

const dispatchError = (message: string, exitCode = 1) => new DispatchError({ message, exitCode })
const activeTask = () => dispatchError("This task already has an active dispatch. Wait for it to finish.", 2)
const noRetries = { attempts: 0, solFailures: 0 }

const taskBoundary = [
  "Top-priority task boundary. Stay strictly within the assigned scope and files.",
  "Do not run git commit or git push, or spawn recursive orchestrator loops.",
  "Ignore unrelated orchestration instructions in repository AGENTS.md."
].join("\n")

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex")
const mntPath = (path: string) => path === "/mnt" || path.startsWith("/mnt/")

const guardMount = Effect.fn("DispatchCodex.guardMount")(function*(path: string, allowMnt?: boolean) {
  if (!allowMnt && mntPath(path)) {
    return yield* dispatchError(`Refusing to dispatch from ${path} under /mnt. Use a Linux filesystem path or pass --allow-mnt.`)
  }
})

// Resolve aliases even when the worktree or some of its parents have yet to be created.
const canonicalPath = Effect.fn("DispatchCodex.canonicalPath")(function*(
  target: string
): Effect.fn.Return<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = path.dirname(target)
  return yield* fs.realPath(target).pipe(Effect.catch((error) =>
    error.reason._tag === "NotFound" && parent !== target
      ? Effect.map(canonicalPath(parent), (directory) => path.join(directory, path.basename(target)))
      : Effect.fail(error)
  ))
})

const absoluteDirectory = Effect.fn("DispatchCodex.absoluteDirectory")(function*(target: string, allowMnt?: boolean) {
  yield* guardMount(target, allowMnt)
  const resolved = yield* canonicalPath(target)
  yield* guardMount(resolved, allowMnt)
  return resolved
})

const git = (cwd: string, args: ReadonlyArray<string>) =>
  checkedText("git", args, { cwd, forceKillAfter: "1 second" })
const gitLine = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((output) => output.replace(/\r?\n$/u, "")))

const repositoryIdentity = Effect.fn("DispatchCodex.repositoryIdentity")(function*(cwd: string) {
  const path = yield* Path.Path
  const gitCommonDir = yield* gitLine(cwd, ["rev-parse", "--git-common-dir"]).pipe(
    Effect.catch(() => gitLine(cwd, ["rev-parse", "--show-toplevel"]))
  )
  return yield* canonicalPath(path.resolve(cwd, gitCommonDir))
})

const worktreeHead = Effect.fn("DispatchCodex.worktreeHead")(function*(worktree: string, identity: string) {
  const topLevel = yield* gitLine(worktree, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.mapError(() => dispatchError(`${worktree} exists but is not a Git worktree. Choose a new path or an existing worktree root.`))
  )
  if ((yield* canonicalPath(topLevel)) !== worktree || (yield* repositoryIdentity(worktree)) !== identity) {
    return yield* dispatchError(`${worktree} is not a worktree root of the selected repository.`)
  }
  return yield* gitLine(worktree, ["rev-parse", "--verify", "HEAD"])
})

const taskStateFile = Effect.fn("DispatchCodex.taskStateFile")(function*(
  taskId: string,
  identity: string,
  stateDir?: string
) {
  yield* Schema.decodeUnknownEffect(TaskId)(taskId)
  const path = yield* Path.Path
  const xdgState = yield* Config.string("XDG_STATE_HOME").pipe(Config.withDefault(""))
  const root = path.resolve(stateDir ?? path.join(xdgState || path.join(homedir(), ".local", "state"), "agy-dispatch"))
  const safeId = /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(taskId) ? taskId : `~${sha256(taskId)}`
  return path.join(root, sha256(identity).slice(0, 16), `${safeId}.json`)
})

const optionalFile = Effect.fn("DispatchCodex.optionalFile")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file).pipe(
    Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error))
  )
})

const readState = Effect.fn("DispatchCodex.readState")(function*(file: string) {
  const text = yield* optionalFile(file)
  if (text === undefined) return undefined
  return yield* Schema.decodeUnknownEffect(TaskStateJson)(text).pipe(
    Effect.mapError((error) => dispatchError(`Invalid task state at ${file}: ${error.message}`))
  )
})

const writeState = Effect.fn("DispatchCodex.writeState")(function*(file: string, state: TaskState) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* Effect.scoped(Effect.gen(function*() {
    const temporary = yield* fs.makeTempFileScoped({ directory: path.dirname(file), prefix: ".dispatch-state-" })
    yield* fs.writeFileString(temporary, yield* Schema.encodeEffect(TaskStateJson)(state))
    yield* fs.rename(temporary, file)
  }))
})

const startIdentity = (pid: number) => checkedText("ps", ["-o", "lstart=", "-p", String(pid)], {
  allowedExitCodes: [1], extendEnv: true, env: { LC_ALL: "C", TZ: "UTC" },
  forceKillAfter: "1 second"
}).pipe(Effect.map((output) => output.trim()))

const missingProcess = Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }))
const ownsLiveProcess = Effect.fn("DispatchCodex.ownsLiveProcess")(function*(owner: {
  readonly pid: number
  readonly startIdentity: string
}) {
  const current = yield* startIdentity(owner.pid)
  if (current !== "") return current === owner.startIdentity
  return yield* Effect.try({
    try: () => process.kill(owner.pid, 0),
    catch: missingProcess
  }).pipe(Effect.catch((missing) => Effect.succeed(!missing)))
})

const lockCollision = Schema.is(Schema.Struct({ code: Schema.Literals(["EEXIST", "ENOTEMPTY"]) }))
const removedDirectory = Schema.is(Schema.Struct({ code: Schema.Literals(["ENOENT", "EEXIST", "ENOTEMPTY"]) }))

const removeLock = Effect.fn("DispatchCodex.removeLock")(function*(directory: string, ownerFile: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(ownerFile, { force: true })
  // A replacement lock has a different owner file. Only remove an empty directory.
  yield* Effect.tryPromise({
    try: () => rmdir(directory),
    catch: (cause) => ({ cause, alreadyReleased: removedDirectory(cause) })
  }).pipe(Effect.catch(({ cause, alreadyReleased }) => alreadyReleased
    ? Effect.void
    : Effect.fail(dispatchError(`Could not release task lock ${directory}: ${String(cause)}`))))
})

const lockOwner = Effect.fn("DispatchCodex.lockOwner")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error))
  )
  if (entries.length === 0) return undefined
  const name = entries[0]
  if (entries.length !== 1 || name === undefined || !name.startsWith("owner-") || !name.endsWith(".json")) {
    return yield* dispatchError(`Invalid task lock directory ${directory}.`)
  }
  const file = path.join(directory, name)
  const text = yield* optionalFile(file)
  if (text === undefined) return undefined
  const owner = yield* Schema.decodeUnknownEffect(LockOwnerJson)(text).pipe(
    Effect.mapError((error) => dispatchError(`Invalid task lock at ${file}: ${error.message}`))
  )
  if (name !== `owner-${owner.token}.json`) return yield* dispatchError(`Invalid task lock owner at ${file}.`)
  return { file, owner }
})

const acquireLock = Effect.fn("DispatchCodex.acquireLock")(function*(stateFile: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = `${stateFile}.lock`
  const identity = yield* startIdentity(process.pid)
  if (identity === "") return yield* dispatchError("Could not identify the dispatcher process with ps.")
  const owner = { pid: process.pid, startIdentity: identity, token: randomUUID() }
  const ownerName = `owner-${owner.token}.json`
  yield* fs.makeDirectory(path.dirname(stateFile), { recursive: true, mode: 0o700 })

  // Publish a populated directory with one rename, so observers always see the owner's identity.
  yield* Effect.acquireUseRelease(
    fs.makeTempDirectory({ directory: path.dirname(stateFile), prefix: ".dispatch-lock-" }),
    Effect.fnUntraced(function*(candidate) {
      yield* fs.writeFileString(path.join(candidate, ownerName), yield* Schema.encodeEffect(LockOwnerJson)(owner))
      while (true) {
        const published = yield* Effect.result(fs.rename(candidate, directory))
        if (Result.isSuccess(published)) return
        if (published.failure.reason._tag === "BadArgument" || !lockCollision(published.failure.reason.cause)) {
          return yield* published.failure
        }
        const previous = yield* lockOwner(directory)
        if (previous === undefined) continue
        if (yield* ownsLiveProcess(previous.owner)) return yield* activeTask()
        yield* removeLock(directory, previous.file)
      }
    }),
    (candidate) => fs.remove(candidate, { recursive: true, force: true })
  )
  return { directory, ownerFile: path.join(directory, ownerName), owner }
})

const withTaskLock = <A, E, R>(
  file: string,
  operation: (owner: typeof LockOwnerJson.Type) => Effect.Effect<A, E, R>
) => Effect.acquireUseRelease(
  acquireLock(file),
  ({ owner }) => operation(owner),
  ({ directory, ownerFile }) => removeLock(directory, ownerFile)
)

const validateState = Effect.fn("DispatchCodex.validateState")(function*(
  state: TaskState | undefined,
  options: RunOptions
) {
  if (state?.status === "running" && (yield* ownsLiveProcess(state))) return yield* activeTask()
  const counts = options.reset || state === undefined ? noRetries : state
  if (counts.attempts >= 3) {
    return yield* dispatchError("This task reached the 3-attempt limit. Inspect it with status before using reset.", 3)
  }
  if (options.role === "impl" && counts.solFailures >= 2 && !options.forceSol) {
    return yield* dispatchError("Sol failed twice for this task. Switch to --role escalate or explicitly pass --force-sol.", 4)
  }
  return { attempts: counts.attempts, solFailures: counts.solFailures }
})

const codexPlan = Effect.fn("DispatchCodex.codexPlan")(function*(options: RunOptions, worktreePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const readOnly = !isWriteRole(options.role)
  const useAstra = options.role === "redteam" || options.role === "escalate" || (options.role === "review" && options.deep)
  const model: typeof Model.Type = useAstra ? "gpt-6.2-astra" : "gpt-6.2-sol"
  const effort = options.effort ?? defaultEfforts[options.role]
  const sandbox = readOnly ? "read-only" : "workspace-write"
  const args = [
    "exec", "-m", model, "-c", `model_reasoning_effort="${effort}"`, "-s", sandbox,
    "-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"', "-C", worktreePath
  ]
  if (readOnly && options.role !== "scout") {
    const profile = useAstra ? "redteam-astra" : "review-sol"
    const codexHome = yield* Config.string("CODEX_HOME").pipe(Config.withDefault(""))
    if (yield* fs.exists(path.resolve(codexHome || path.join(homedir(), ".codex"), `${profile}.config.toml`))) {
      args.push("-p", profile)
    }
  }
  if (readOnly) args.push("--ephemeral")
  if (options.output !== undefined) args.push("-o", path.resolve(options.output))
  if (options.outputSchema !== undefined) args.push("--output-schema", path.resolve(options.outputSchema))
  args.push("-")
  const executable = options.codexBin ?? "codex"
  const command = executable.includes(path.sep) ? path.resolve(executable) : executable
  return { command, args, model, effort }
})

type DispatchPlan = Effect.Success<ReturnType<typeof codexPlan>> & {
  readonly taskId: string | undefined
  readonly role: typeof Role.Type
  readonly worktreePath: string
  readonly baseHead: string
}

const readStdin = Stdio.Stdio.use((stdio) => Stream.mkString(Stream.decodeText(stdio.stdin)))

const runCodex = Effect.fn("DispatchCodex.runCodex")(function*(
  plan: DispatchPlan,
  prompt: string,
  json?: boolean
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const stdio = yield* Stdio.Stdio
  const boundary = plan.role === "scout"
    ? `${taskBoundary}\nRead-only codebase scouting. Stay within the targeted directories/files to keep context well under 272K tokens; return exact file paths, symbols, call chains, and evidence concisely without editing files.`
    : taskBoundary
  const command = ChildProcess.make(plan.command, plan.args, {
    cwd: plan.worktreePath,
    extendEnv: true,
    // Node omits undefined environment values when spawning a child.
    env: { CODEX_API_KEY: undefined, OPENAI_API_KEY: undefined },
    stdin: Stream.make(`${boundary}\n\n${prompt}`).pipe(Stream.encodeText),
    stdout: json ? "pipe" : "inherit",
    stderr: "inherit",
    forceKillAfter: "1 second"
  })
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* spawner.spawn(command)
    if (!json) return Number(yield* child.exitCode)
    const [code] = yield* Effect.all([
      Effect.result(child.exitCode),
      Stream.run(child.stdout, stdio.stderr())
    ], { concurrency: 2 })
    return Result.isSuccess(code) ? Number(code.success) : yield* code.failure
  })).pipe(Effect.mapError((error) => dispatchError(
    error.reason._tag === "NotFound" ? `${plan.command}: command not found` : `Could not run ${plan.command}: ${error.message}`,
    error.reason._tag === "NotFound" ? 127 : platformErrorExitCode(error) ?? 1
  )))
})

const emptyChanges = { changedFiles: [], untrackedFiles: [], diffStat: "" }

const collectChanges = Effect.fn("DispatchCodex.collectChanges")(function*(cwd: string) {
  const { status, diffStat } = yield* Effect.all({
    status: git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
    diffStat: git(cwd, ["diff", "HEAD", "--stat"])
  }, { concurrency: 2 })
  const changedFiles: Array<string> = []
  const untrackedFiles: Array<string> = []
  const entries = status.split("\0")
  for (let index = 0; index < entries.length - 1; index += 1) {
    const entry = entries[index] ?? ""
    const marks = entry.slice(0, 2)
    const filename = entry.slice(3)
    if (marks === "??") untrackedFiles.push(filename)
    else changedFiles.push(filename)
    // In porcelain -z, rename and copy entries list the destination and then the source.
    if (/[RC]/u.test(marks)) index += 1
  }
  return { changedFiles, untrackedFiles, diffStat: diffStat.trimEnd() }
})

const executePlan = Effect.fn("DispatchCodex.executePlan")(function*(
  options: RunOptions,
  plan: DispatchPlan,
  prompt: string,
  state?: { readonly file: string; readonly running: TaskState }
) {
  // Once published, finalize the attempt even when the child is interrupted.
  return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    if (state !== undefined) yield* writeState(state.file, state.running)
    const outcome = yield* Effect.exit(restore(runCodex(plan, prompt, options.json)))
    const failure = Option.getOrUndefined(Exit.findErrorOption(outcome))
    const exitCode = Exit.isSuccess(outcome) ? outcome.value : failure?.exitCode ?? (Exit.hasInterrupts(outcome) ? 130 : 1)
    const report = yield* Effect.result(collectChanges(plan.worktreePath))
    const changes = Result.isSuccess(report) ? report.success : emptyChanges
    const error = [
      failure?.message ?? (exitCode !== 0 ? `Codex exited with code ${exitCode}.` : undefined),
      Result.isFailure(report) ? `Could not collect worktree changes: ${report.failure.message}` : undefined
    ].filter((message) => message !== undefined).join("\n")
    if (state !== undefined) {
      yield* writeState(state.file, {
        ...state.running, ...changes,
        status: exitCode === 0 ? "done" : "failed",
        solFailures: state.running.solFailures + (exitCode !== 0 && options.role === "impl" ? 1 : 0),
        updatedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        exitCode,
        ...(error === "" ? {} : { error })
      })
    }
    if (Exit.hasInterrupts(outcome)) return yield* Effect.failCause(outcome.cause)
    return {
      ...plan, ...changes,
      ok: exitCode === 0 && error === "",
      exitCode: exitCode || (error === "" ? 0 : 1),
      ...(error === "" ? {} : { error })
    }
  }))
})

const dispatchInWorktree = Effect.fn("DispatchCodex.dispatchInWorktree")(function*(
  options: RunOptions,
  cwd: string,
  worktreePath: string,
  identity: string,
  stdin: typeof readStdin,
  lock?: { readonly file: string; readonly owner?: typeof LockOwnerJson.Type }
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (lock?.owner === undefined && lock !== undefined) {
    const active = yield* lockOwner(`${lock.file}.lock`)
    if (active !== undefined && (yield* ownsLiveProcess(active.owner))) return yield* activeTask()
  }
  const counts = lock === undefined ? noRetries : yield* validateState(yield* readState(lock.file), options)
  const createWorktree = options.worktree !== undefined && !(yield* fs.exists(worktreePath))
  const prompt = options.prompt ?? (options.promptFile === undefined
    ? options.dryRun ? "" : yield* stdin
    : yield* fs.readFileString(path.resolve(options.promptFile)))
  const baseHead = options.worktree === undefined || createWorktree
    ? yield* gitLine(cwd, ["rev-parse", "--verify", "HEAD"])
    : yield* worktreeHead(worktreePath, identity)
  const plan = {
    ...yield* codexPlan(options, worktreePath),
    taskId: options.taskId,
    role: options.role,
    worktreePath,
    baseHead
  }
  if (options.dryRun) {
    return { ...plan, ...emptyChanges, ...counts, ok: true as const, exitCode: 0, dryRun: true, createWorktree }
  }
  if (createWorktree) {
    const branch = options.branch === undefined ? ["--detach"] : ["-b", options.branch]
    yield* git(cwd, ["worktree", "add", ...branch, "--", worktreePath, baseHead])
  }

  const running = lock?.owner === undefined ? undefined : {
    file: lock.file,
    running: {
      ...counts,
      status: "running",
      attempts: counts.attempts + 1,
      pid: lock.owner.pid,
      startIdentity: lock.owner.startIdentity,
      role: options.role,
      model: plan.model,
      effort: plan.effort,
      worktreePath,
      baseHead,
      updatedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso))
    } satisfies TaskState
  }
  return yield* executePlan(options, plan, prompt, running)
})

export const runDispatch = Effect.fn("DispatchCodex.run")(function*(options: RunOptions, stdin = readStdin) {
  const path = yield* Path.Path
  const cwd = yield* absoluteDirectory(path.resolve(options.cwd ?? process.cwd()), options.allowMnt)
  const worktree = options.worktree === undefined ? cwd
    : yield* absoluteDirectory(path.resolve(cwd, options.worktree), options.allowMnt)
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    return yield* dispatchError("Choose either --prompt or --prompt-file.")
  }
  const identity = yield* repositoryIdentity(cwd)
  if (options.taskId === undefined || !isWriteRole(options.role)) {
    return yield* dispatchInWorktree(options, cwd, worktree, identity, stdin)
  }
  const file = yield* taskStateFile(options.taskId, identity, options.stateDir)
  return yield* options.dryRun
    ? dispatchInWorktree(options, cwd, worktree, identity, stdin, { file })
    : withTaskLock(file, (owner) => dispatchInWorktree(options, cwd, worktree, identity, stdin, { file, owner }))
})

export const runBatch = Effect.fn("DispatchCodex.batch")(function*(
  planFile: string,
  concurrency: number,
  options: DispatchOptions
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const plan = yield* Schema.decodeUnknownEffect(BatchPlanJson)(yield* fs.readFileString(planFile))
  const ids = new Set<string>()
  const worktrees = new Set<string>()
  const tasks = []
  for (const task of plan.tasks) {
    const target = path.resolve(cwd, task.worktree)
    const resolved = yield* Effect.result(canonicalPath(target))
    // Dispatch reports path errors for the affected task without stopping its siblings.
    const worktree = Result.isSuccess(resolved) ? resolved.success : target
    if (ids.has(task.taskId)) return yield* dispatchError(`Duplicate task ID in batch: ${task.taskId}`)
    if (worktrees.has(worktree)) return yield* dispatchError(`Duplicate worktree in batch: ${worktree}`)
    ids.add(task.taskId)
    worktrees.add(worktree)
    tasks.push({ task: { ...task, worktree: target }, worktreePath: worktree })
  }
  const stdin = yield* Effect.cached(readStdin)
  return yield* Effect.forEach(tasks, ({ task, worktreePath }) => runDispatch({ ...options, ...task }, stdin).pipe(
    Effect.result,
    Effect.map((result) => Result.isSuccess(result) ? result.success : {
      ok: false,
      taskId: task.taskId,
      exitCode: result.failure instanceof DispatchError ? result.failure.exitCode : 1,
      worktreePath,
      baseHead: null,
      ...emptyChanges,
      error: result.failure.message
    })
  ), { concurrency })
})

const locateTaskState = Effect.fn("DispatchCodex.locateTaskState")(function*(taskId: string, options: LocationOptions) {
  const path = yield* Path.Path
  const cwd = yield* canonicalPath(path.resolve(options.cwd ?? process.cwd()))
  return yield* taskStateFile(taskId, yield* repositoryIdentity(cwd), options.stateDir)
})

export const taskStatus = Effect.fn("DispatchCodex.status")(function*(taskId: string, options: LocationOptions) {
  const state = yield* readState(yield* locateTaskState(taskId, options))
  return { taskId, ...(state ?? { status: "untracked", ...noRetries }) }
})

export const resetTask = Effect.fn("DispatchCodex.reset")(function*(taskId: string, options: LocationOptions) {
  const fs = yield* FileSystem.FileSystem
  const file = yield* locateTaskState(taskId, options)
  yield* withTaskLock(file, () => Effect.gen(function*() {
    const state = yield* readState(file)
    if (state?.status === "running" && (yield* ownsLiveProcess(state))) return yield* activeTask()
    yield* fs.remove(file, { force: true })
  }))
})
