import * as Schema from "effect/Schema"
// These tests launch the installed command entrypoint as an independent OS process.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, watch, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path"
import { text } from "node:stream/consumers"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const wrapper = fileURLToPath(new URL("../scripts/dispatch-codex", import.meta.url))

const Receipt = Schema.Struct({
  ok: Schema.Boolean,
  exitCode: Schema.Int,
  taskId: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  baseHead: Schema.optional(Schema.NullOr(Schema.String)),
  createWorktree: Schema.optional(Schema.Boolean),
  worktreePath: Schema.optional(Schema.String),
  changedFiles: Schema.optional(Schema.Array(Schema.String)),
  untrackedFiles: Schema.optional(Schema.Array(Schema.String)),
  diffStat: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String)
})
const decodeReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(Receipt))
const decodeBatch = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Receipt)))
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  status: Schema.String,
  attempts: Schema.Int,
  solFailures: Schema.Int,
  exitCode: Schema.optional(Schema.Int)
})))
const decodeInvocation = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  credentials: Schema.Array(Schema.Boolean),
  prompt: Schema.String
})))

const fakeCodexSource = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const output = args.indexOf("-o");
if (output !== -1) {
  writeFileSync(args[output + 1], JSON.stringify({
    args, prompt, cwd: process.cwd(),
    credentials: ["CODEX_API_KEY", "OPENAI_API_KEY"].map(key => Object.hasOwn(process.env, key))
  }));
}
if (prompt.includes("EDIT_FILES")) {
  writeFileSync("tracked.txt", "edited\\n");
  writeFileSync("new file.txt", "created\\n");
}
if (prompt.includes("HOLD_TASK")) {
  writeFileSync(process.env.DISPATCH_TEST_READY, "ready");
  setInterval(() => {}, 1000);
} else {
  writeFileSync(1, "fixture ran\\n");
  process.exitCode = prompt.includes("FAIL_TASK") ? 17 : 0;
}
`

let fixture: { root: string; repo: string; state: string; codex: string; home: string }

const collect = (child: ChildProcessWithoutNullStreams, input = "") => {
  child.stdin.end(input)
  return Promise.all([once(child, "close"), text(child.stdout), text(child.stderr)])
    .then(([closed, stdout, stderr]) => ({
      exitCode: Schema.decodeUnknownSync(Schema.NullOr(Schema.Int))(closed[0]), stdout, stderr
    }))
}

const git = async (args: ReadonlyArray<string>, input?: string) => {
  const result = await collect(spawn("git", args, { cwd: fixture.repo, stdio: ["pipe", "pipe", "pipe"] }), input)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dispatch-codex-test-")))
  fixture = {
    root, repo: join(root, "repo"), state: join(root, "state"),
    codex: join(root, "fake-codex"), home: join(root, "codex-home")
  }
  await mkdir(fixture.repo)
  await mkdir(fixture.home)
  await writeFile(fixture.codex, fakeCodexSource, { mode: 0o700 })
  await git(["init", "--quiet", "--template=", "--initial-branch=main"])
  await git(["fast-import", "--quiet"], [
    "commit refs/heads/main",
    "committer Fixture <fixture@example.test> 1700000000 +0000",
    "data 7",
    "fixture",
    "M 100644 inline tracked.txt",
    "data 5",
    "base",
    "",
    "done",
    ""
  ].join("\n"))
  await git(["read-tree", "--reset", "-u", "HEAD"])
})

afterEach(async () => {
  await rm(fixture.root, { recursive: true })
})

const launch = async (args: ReadonlyArray<string>, input = "") => {
  // File descriptors also work in sandboxes that block Node's socket writes.
  const directory = await mkdtemp(join(fixture.root, "cli-"))
  const inputFile = join(directory, "stdin")
  const out = join(directory, "stdout")
  const err = join(directory, "stderr")
  await writeFile(inputFile, input)
  const [stdin, stdout, stderr] = await Promise.all([open(inputFile, "r"), open(out, "w"), open(err, "w")])
  // Use the real inherited environment to test the grandchild's credential stripping.
  const env = {
    ...process.env, CODEX_HOME: fixture.home, CODEX_API_KEY: "fixture-codex-key", OPENAI_API_KEY: "fixture-openai-key",
    DISPATCH_TEST_READY: join(fixture.root, "ready")
  }
  const child = spawn(process.execPath, [wrapper, ...args], {
    cwd: fixture.repo, env, stdio: [stdin.fd, stdout.fd, stderr.fd]
  })
  const result = once(child, "close").then(async ([code]) => ({
    exitCode: Schema.decodeUnknownSync(Schema.NullOr(Schema.Int))(code),
    stdout: await readFile(out, "utf8"),
    stderr: await readFile(err, "utf8")
  }))
  await Promise.all([stdin.close(), stdout.close(), stderr.close()])
  return { child, result }
}

const dispatch = async (args: ReadonlyArray<string>, input?: string) => (await launch(args, input)).result
const runFlags = () => ["--state-dir", fixture.state, "--codex-bin", fixture.codex, "--json"]
const runTask = (role: string, prompt: string, ...flags: ReadonlyArray<string>) =>
  dispatch(["run", ...runFlags(), "--task", "T3", "--role", role, "--prompt", prompt, ...flags])
const status = async (...flags: ReadonlyArray<string>) => {
  const result = await dispatch(["status", "--state-dir", fixture.state, "--task", "T3", "--json", ...flags])
  expect(result.exitCode, result.stderr).toBe(0)
  return decodeState(result.stdout)
}
const reset = () => dispatch(["reset", "--state-dir", fixture.state, "--task", "T3"])

describe("dispatch-codex", () => {
  it("routes each role and sends the wrapped assignment without either API key", async () => {
    await writeFile(join(fixture.home, "redteam-astra.config.toml"), "")
    await writeFile(join(fixture.home, "review-sol.config.toml"), "")
    const output = join(fixture.root, "message.json")
    const outputSchema = join(fixture.root, "schema.json")
    await writeFile(outputSchema, "{}")

    const result = await dispatch(["run", ...runFlags(), "--role", "review", "--deep", "--output", output, "--output-schema", outputSchema], "Review the assigned changes.")
    expect(result.exitCode, result.stderr).toBe(0)
    expect(decodeReceipt(result.stdout).ok).toBe(true)
    expect(result.stderr).toContain("fixture ran")
    const invocation = decodeInvocation(await readFile(output, "utf8"))
    expect(invocation.args).toEqual([
      "exec", "-m", "gpt-6.2-astra", "-c", 'model_reasoning_effort="high"', "-s", "read-only",
      "-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"', "-C", fixture.repo,
      "-p", "redteam-astra", "--ephemeral", "-o", output, "--output-schema", outputSchema, "-"
    ])
    expect(invocation.credentials).toEqual([false, false])
    expect(invocation.prompt).toMatch(/^Top-priority task boundary\.[\s\S]+git commit[\s\S]+git push[\s\S]+recursive orchestrator[\s\S]+AGENTS\.md\.\n\nReview the assigned changes\.$/u)

    const cases = [
      ["redteam", "gpt-6.2-astra", "high", "read-only", "redteam-astra"],
      ["review", "gpt-6.2-sol", "high", "read-only", "review-sol"],
      ["impl", "gpt-6.2-sol", "medium", "workspace-write", undefined],
      ["escalate", "gpt-6.2-astra", "xhigh", "workspace-write", undefined]
    ] as const
    for (const [role, model, effort, sandbox, profile] of cases) {
      const dry = await runTask(role, "", "--dry-run")
      expect(dry.exitCode, dry.stderr).toBe(0)
      const args = decodeReceipt(dry.stdout).args ?? []
      expect(args.slice(0, 7)).toEqual(["exec", "-m", model, "-c", `model_reasoning_effort="${effort}"`, "-s", sandbox])
      expect(args.slice(13)).toEqual(profile === undefined ? ["-"] : ["-p", profile, "--ephemeral", "-"])
    }
  })

  it.each(["impl", "escalate"])("rejects %s without a task ID before creating a worktree or invoking Codex", async (role) => {
    const worktree = join(fixture.root, "untracked worktree")
    const output = join(fixture.root, "invocation.json")
    const args = ["run", ...runFlags(), "--role", role, "--worktree", worktree, "--output", output, "--prompt", "EDIT_FILES"]

    for (const flags of [args, [...args, "--dry-run"]]) {
      const result = await dispatch(flags)
      expect(result.exitCode, result.stderr).toBe(1)
      expect(decodeReceipt(result.stdout).error).toContain("--task")
    }
    await expect(readdir(worktree)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("passes an explicit low effort through the CLI to the Codex command", async () => {
    const dry = await runTask("impl", "", "--effort", "low", "--dry-run")
    expect(dry.exitCode, dry.stderr).toBe(0)
    expect(decodeReceipt(dry.stdout).args).toContain('model_reasoning_effort="low"')
  })

  it("dispatches a read-only scout without review profiles, credentials or retry state", async () => {
    await writeFile(join(fixture.home, "redteam-astra.config.toml"), "")
    await writeFile(join(fixture.home, "review-sol.config.toml"), "")
    const output = join(fixture.root, "scout.json")
    const prompt = "Trace the caller of runDispatch."
    const result = await runTask("scout", prompt, "--output", output)

    expect(result.exitCode, result.stderr).toBe(0)
    const invocation = decodeInvocation(await readFile(output, "utf8"))
    expect(invocation.args.slice(0, 7)).toEqual([
      "exec", "-m", "gpt-6.2-sol", "-c", 'model_reasoning_effort="medium"', "-s", "read-only"
    ])
    expect(invocation.args).toContain("--ephemeral")
    expect(invocation.args).not.toContain("-p")
    expect(invocation.credentials).toEqual([false, false])
    expect(invocation.prompt).toContain(
      `\nRead-only codebase scouting. Stay within the targeted directories/files to keep context well under 272K tokens; return exact file paths, symbols, call chains, and evidence concisely without editing files.\n\n${prompt}`
    )
    await expect(readdir(fixture.state)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses /mnt before Git lookup and permits an explicit override without creating a worktree", async () => {
    const refused = await runTask("impl", "", "--cwd", "/mnt", "--dry-run")
    expect(refused.exitCode).toBe(1)
    expect(decodeReceipt(refused.stdout).error).toContain("--allow-mnt")

    const target = join("/mnt", "dispatch-codex-test", fixture.root.split("/").at(-1) ?? "worktree")
    const flags = ["--worktree", target, "--dry-run"]
    const refusedWorktree = await runTask("impl", "", ...flags)
    expect(refusedWorktree.exitCode).toBe(1)
    expect(decodeReceipt(refusedWorktree.stdout).error).toContain("--allow-mnt")

    const allowed = await runTask("impl", "", ...flags, "--allow-mnt")
    expect(allowed.exitCode, allowed.stderr).toBe(0)
    expect(decodeReceipt(allowed.stdout)).toMatchObject({ worktreePath: target, createWorktree: true })
  })

  it("persists failures, routes the third attempt to escalation and enforces the hard limit until reset", async () => {
    for (const attempt of [1, 2]) {
      const failed = await runTask("impl", "FAIL_TASK")
      expect(failed.exitCode, failed.stderr).toBe(17)
      expect(decodeReceipt(failed.stdout)).toMatchObject({ ok: false, taskId: "T3", exitCode: 17 })
      expect(await status()).toEqual({ status: "failed", attempts: attempt, solFailures: attempt, exitCode: 17 })
    }

    const blocked = await runTask("impl", "", "--dry-run")
    expect(blocked.exitCode).toBe(4)
    expect(decodeReceipt(blocked.stdout).error).toContain("--role escalate")
    expect((await runTask("impl", "")).exitCode).toBe(4)
    expect((await runTask("impl", "", "--force-sol", "--dry-run")).exitCode).toBe(0)
    expect(await status()).toMatchObject({ attempts: 2, solFailures: 2 })

    const escalated = await runTask("escalate", "")
    expect(escalated.exitCode, escalated.stderr).toBe(0)
    expect(await status()).toEqual({ status: "done", attempts: 3, solFailures: 2, exitCode: 0 })

    const stopped = await runTask("escalate", "")
    expect(stopped.exitCode).toBe(3)
    expect(decodeReceipt(stopped.stdout).error).toContain("3-attempt limit")
    expect((await runTask("escalate", "", "--reset", "--dry-run")).exitCode).toBe(0)
    expect(await status()).toMatchObject({ attempts: 3 })
    expect((await reset()).exitCode).toBe(0)
    expect(await status()).toEqual({ status: "untracked", attempts: 0, solFailures: 0 })
    expect((await runTask("impl", "")).exitCode).toBe(0)
    expect(await status()).toEqual({ status: "done", attempts: 1, solFailures: 0, exitCode: 0 })
  }, 15_000)

  it("rejects concurrent dispatch and reset, then records failure when the owner is interrupted", async () => {
    const stopWatching = new AbortController()
    const watcher = watch(fixture.root, { signal: AbortSignal.any([stopWatching.signal, AbortSignal.timeout(5_000)]) })
    const ready = (async () => {
      for await (const event of watcher) {
        if (event.filename === "ready") return
      }
    })()
    const first = await launch(["run", ...runFlags(), "--role", "impl", "--task", "T3", "--prompt", "HOLD_TASK"])
    try {
      await Promise.race([
        ready,
        first.result.then((result) => { throw new Error(`Dispatcher exited before the fixture was ready: ${result.stderr} ${result.stdout}`) })
      ])
      expect(await status()).toMatchObject({ status: "running", attempts: 1 })
      const overlapping = await runTask("impl", "")
      expect(overlapping.exitCode).toBe(2)
      expect(decodeReceipt(overlapping.stdout).error).toContain("active dispatch")
      expect((await reset()).exitCode).toBe(2)
    } finally {
      first.child.kill("SIGTERM")
      await first.result
      stopWatching.abort()
    }
    expect((await first.result).exitCode).toBe(130)
    expect(await status()).toEqual({ status: "failed", attempts: 1, solFailures: 1, exitCode: 130 })
    expect((await runTask("impl", "")).exitCode).toBe(0)
  }, 15_000)

  it("creates the requested worktree and reports tracked and untracked changes from that worktree", async () => {
    const worktree = join(fixture.root, "linked worktree")
    const promptFile = join(fixture.root, "assignment.txt")
    const output = join(fixture.root, "invocation.json")
    await writeFile(promptFile, "EDIT_FILES")
    const result = await dispatch([
      "run", ...runFlags(), "--role", "impl", "--task", "T3", "--worktree", worktree,
      "--branch", "dispatch/fixture", "--prompt-file", promptFile, "--output", output
    ])
    expect(result.exitCode, result.stderr).toBe(0)
    const receipt = decodeReceipt(result.stdout)
    expect(receipt).toMatchObject({
      taskId: "T3", ok: true, worktreePath: worktree, baseHead: await git(["rev-parse", "HEAD"]),
      changedFiles: ["tracked.txt"], untrackedFiles: ["new file.txt"]
    })
    expect(receipt.diffStat).toContain("tracked.txt")
    const invocation = decodeInvocation(await readFile(output, "utf8"))
    expect(invocation.cwd).toBe(worktree)
    expect(invocation.args).not.toContain("--worktree")
    expect(invocation.args[invocation.args.indexOf("-C") + 1]).toBe(worktree)
    expect(await git(["-C", worktree, "branch", "--show-current"])).toBe("dispatch/fixture")
    expect(await git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe("")
    expect(await status("--cwd", worktree)).toMatchObject({ status: "done", attempts: 1 })
  })

  it("keeps sibling results when a batch task exits nonzero and rejects duplicate worktrees up front", async () => {
    const plan = join(fixture.root, "plan.json")
    const a = join(fixture.root, "task-a")
    const b = join(fixture.root, "task-b")
    const tasks = [
      { taskId: "a", role: "impl", worktree: a, prompt: "FAIL_TASK" },
      { taskId: "b", role: "impl", worktree: b, prompt: "EDIT_FILES" }
    ]
    await writeFile(plan, JSON.stringify({ tasks }))
    const args = ["batch", ...runFlags(), "--plan", plan, "--concurrency", "2"]
    const result = await dispatch(args)
    expect(result.exitCode, result.stderr).toBe(1)
    expect(decodeBatch(result.stdout)).toMatchObject([
      { ok: false, taskId: "a", exitCode: 17, worktreePath: a, changedFiles: [], untrackedFiles: [] },
      { ok: true, taskId: "b", exitCode: 0, worktreePath: b, changedFiles: ["tracked.txt"], untrackedFiles: ["new file.txt"] }
    ])
    expect(await readFile(join(b, "new file.txt"), "utf8")).toBe("created\n")

    const alias = join(fixture.root, "alias")
    await symlink(a, alias)
    await writeFile(plan, JSON.stringify({ tasks: [...tasks, { taskId: "c", role: "review", worktree: alias }] }))
    const duplicate = await dispatch(args)
    expect(duplicate.exitCode).toBe(1)
    expect(decodeReceipt(duplicate.stdout).error).toContain("Duplicate worktree")
    expect(duplicate.stderr).not.toContain("fixture ran")
  })
})
