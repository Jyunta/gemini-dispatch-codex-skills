#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeStdio from "@effect/platform-node/NodeStdio"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
// The synchronous evaluator also runs without an Effect runtime.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs"
import { homedir } from "node:os"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export interface HealthGateOptions {
  readonly geminiRoot?: string
  readonly codexRoot?: string
  readonly binDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly requiredSkills?: readonly string[]
}

type HealthGateDecision =
  | { readonly injectSteps?: never; readonly terminationBehavior?: never }
  | {
    readonly injectSteps: readonly [{ readonly errorMessage: { readonly userMessage: string } }]
    readonly terminationBehavior: "terminate"
  }
  | {
    readonly injectSteps: readonly [{
      readonly systemMessage: { readonly systemMessage: string; readonly metadata: { readonly user_markdown: string } }
    }]
    readonly terminationBehavior?: never
  }

const decodeInvocation = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Struct({
  cwd: Schema.optional(Schema.String),
  invocationNum: Schema.optional(Schema.Finite)
})))
const activateScript = fileURLToPath(new URL("../../scripts/activate-orchestration.mjs", import.meta.url))

export function assertReadableFile(filename: string, { nonEmpty = false } = {}): void {
  const stat = fs.statSync(filename)
  if (!stat.isFile() || (nonEmpty && stat.size === 0)) {
    throw new Error(`Expected a ${nonEmpty ? "non-empty " : ""}file at ${filename}`)
  }
  fs.accessSync(filename, fs.constants.R_OK)
}

export function assertRealpathInside(filename: string, root: string): void {
  const resolved = fs.realpathSync(filename)
  const relative = path.relative(root, resolved)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${filename} resolves outside ${root}: ${resolved}`)
  }
}

export function assertInstalledSkill(skillsRoot: string, name: string): void {
  const directory = path.join(skillsRoot, name)
  if (!fs.lstatSync(directory).isDirectory()) {
    throw new Error(`Expected a real skill directory at ${directory}`)
  }
  const instructions = path.join(directory, "SKILL.md")
  assertRealpathInside(instructions, fs.realpathSync(skillsRoot))
  assertReadableFile(instructions)
}

export function evaluatePreInvocation(rawInput: string, options: HealthGateOptions = {}): HealthGateDecision {
  const env = options.env ?? process.env
  const mode = env.AGY_ORCH_GUARD?.trim().toLowerCase()
  if (mode === "off") return {}

  const invocation = decodeInvocation(rawInput)
  const invocationNum = invocation._tag === "Success" ? invocation.value.invocationNum : undefined
  if (invocationNum !== undefined && invocationNum > 1) return {}

  const home = env.HOME || homedir()
  const geminiRoot = options.geminiRoot ?? (env.AGY_ORCH_GEMINI_ROOT || path.join(home, ".gemini"))
  const codexRoot = options.codexRoot ?? (env.CODEX_HOME || path.join(home, ".codex"))
  const binDir = options.binDir ?? (env.AGY_ORCH_BIN_DIR || path.join(home, ".local", "bin"))
  const skillsRoot = path.join(geminiRoot, "config", "skills")
  const instructions = [path.join(geminiRoot, "GEMINI.md"), path.join(geminiRoot, "config", "GEMINI.md")]
  const failures: string[] = []
  const check = (name: string, verify: () => void) => {
    try {
      verify()
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  check("Gemini instructions", () => {
    const errors: string[] = []
    for (const filename of instructions) {
      try {
        assertReadableFile(filename, { nonEmpty: true })
        return
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    throw new Error(errors.join(" or "))
  })
  for (const name of options.requiredSkills ?? ["agy-codex-orchestrator", "code-review"]) {
    check(name, () => assertInstalledSkill(skillsRoot, name))
  }
  check("dispatch-codex", () => {
    const dispatcher = path.join(binDir, "dispatch-codex")
    if (!fs.statSync(dispatcher).isFile()) throw new Error(`Expected a file at ${dispatcher}`)
    fs.accessSync(dispatcher, fs.constants.X_OK)
  })
  for (const name of ["review-sol.config.toml", "redteam-astra.config.toml", "rules/guardrails.rules"]) {
    check(name, () => assertReadableFile(path.join(codexRoot, name)))
  }

  if (failures.length === 0) return {}
  const message = [
    "Orchestration health check failed.",
    ...failures.map((failure) => `- ${failure}`),
    `Repair with: node '${activateScript.replaceAll("'", "'\\''")}'`,
    "Use AGY_ORCH_GUARD=warn to continue with a warning or AGY_ORCH_GUARD=off to skip the check."
  ].join("\n")
  if (mode === "warn") {
    return { injectSteps: [{ systemMessage: { systemMessage: message, metadata: { user_markdown: message } } }] }
  }
  return { injectSteps: [{ errorMessage: { userMessage: message } }], terminationBehavior: "terminate" }
}

const main = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const input = yield* Stream.mkString(Stream.decodeText(stdio.stdin))
  yield* Console.log(JSON.stringify(evaluatePreInvocation(input)))
})

if (import.meta.main ?? (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)) {
  // @effect-diagnostics-next-line strictEffectProvide:off
  NodeRuntime.runMain(Effect.provide(main, NodeStdio.layer))
}
