#!/usr/bin/env node
// This hook guards parent Antigravity run_command calls only. Codex sandboxes
// and codex-guardrails.rules guard commands executed inside Codex.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeStdio from "@effect/platform-node/NodeStdio"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { pathToFileURL } from "node:url"

export interface HookDecision {
  readonly decision: "allow" | "ask" | "force_ask" | "deny"
  readonly reason?: string
}

const decodeHookInput = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Struct({
  cwd: Schema.optional(Schema.String),
  toolCall: Schema.Struct({
    name: Schema.String,
    args: Schema.optional(Schema.Unknown)
  })
})))
const decodeCommandArgs = Schema.decodeUnknownExit(Schema.Struct({
  CommandLine: Schema.String
}))

const allow: HookDecision = Object.freeze({ decision: "allow" })
const priority = { allow: 0, ask: 1, force_ask: 2, deny: 3 }
const highIoCommands = new Set([
  "npm", "bun", "pnpm", "yarn", "cargo", "make", "cmake", "pip", "pytest", "vitest", "codex"
])
const systemDirectories = new Set([
  "bin", "boot", "dev", "etc", "lib", "lib32", "lib64", "libx32", "opt", "proc",
  "run", "sbin", "srv", "sys", "usr", "var"
])
const commandWrappers = new Set(["command", "env", "exec", "sudo", "time"])
const gitOptionsWithValue = new Set(["-C", "-c", "--git-dir", "--namespace", "--work-tree", "--config-env"])

// Recognize literal command words, quotes, lists, and redirections without
// resolving shell variables, aliases, or scripts.
const shellTokens = /(?<comment>#[^\n]*)|(?<redirect>\d*(?:<<<|<<-?|<>|>>|>\||[<>]&|[<>])|&>>?)|(?<separator>[;&|()\n]+)|(?<word>(?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\s;&|()<>'"\\])+)/gu

function* commandWords(commandLine: string): Generator<readonly string[]> {
  let words: string[] = []
  let redirectTarget = false
  for (const { groups } of commandLine.matchAll(shellTokens)) {
    if (groups?.separator !== undefined) {
      if (words.length > 0) yield words
      words = []
      redirectTarget = false
    } else if (groups?.redirect !== undefined) {
      redirectTarget = true
    } else if (groups?.word !== undefined) {
      if (!redirectTarget) {
        words.push(groups.word.replace(
          /'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])/gu,
          (_, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
            single ?? double?.replace(/\\([$"\x60\\\n])/gu, (_match, character: string) => character === "\n" ? "" : character)
            ?? (escaped === "\n" ? "" : escaped ?? "")
        ))
      }
      redirectTarget = false
    }
  }
  if (words.length > 0) yield words
}

function isProtectedRemovalTarget(argument: string): boolean {
  const target = argument.replace(/\/+/gu, "/").replace(/\/$/u, "")
  if (/^(?:~[^/]*|\$HOME|\$\{HOME\})(?:\/\*)?$/u.test(target)) return true
  if (!argument.startsWith("/")) return false
  if (target === "" || target === "/*") return true
  if (/^\/(?:(?:home|Users)(?:\/[^/]+)?|root)(?:\/\*)?$/u.test(target)) return true
  const directory = target.split("/")[1]
  return directory !== undefined && systemDirectories.has(directory)
}

function evaluateCommand(words: readonly string[], crossesMount: boolean): HookDecision {
  const commandIndex = words.findIndex((word) => !/^[a-z_]\w*=/iu.test(word)
    && !commandWrappers.has(word.split("/").at(-1) ?? ""))
  const command = words[commandIndex]?.split("/").at(-1)
  const args = words.slice(commandIndex + 1)
  let gitSubcommand: string | undefined
  let optionStart = 0
  if (command === "git") {
    let option = args[optionStart]
    while (option?.startsWith("-")) {
      optionStart += gitOptionsWithValue.has(option) ? 2 : 1
      option = args[optionStart]
    }
    gitSubcommand = args[optionStart]
    optionStart += 1
  }
  const optionEnd = args.indexOf("--", optionStart)
  const options = args.slice(optionStart, optionEnd === -1 ? undefined : optionEnd)
  const shortFlags = options.filter((argument) => /^-[a-z]+$/iu.test(argument)).join("")

  if (command === "rm") {
    const recursive = /[rR]/u.test(shortFlags) || options.includes("--recursive")
    const force = shortFlags.includes("f") || options.includes("--force")
    if (options.includes("--no-preserve-root") || (recursive && force && args.some(isProtectedRemovalTarget))) {
      return { decision: "deny", reason: "Recursive removal targets a protected root, home, or system path, or disables root protection." }
    }
    if (recursive && force) {
      return { decision: "force_ask", reason: "Recursive forced removal requires confirmation." }
    }
  }
  if (command === "mkfs" || command?.startsWith("mkfs.") || (command === "dd" && args.some((arg) => arg.startsWith("of=/dev/")))) {
    return { decision: "deny", reason: "Formatting filesystems or writing to a device with dd is blocked." }
  }
  if (gitSubcommand === "push") {
    if (shortFlags.includes("f") || options.includes("--force")) {
      return { decision: "force_ask", reason: "A forced Git push can overwrite remote history." }
    }
    if (options.some((arg) => arg === "--force-with-lease" || arg.startsWith("--force-with-lease="))) {
      return { decision: "ask", reason: "A Git push with --force-with-lease can rewrite remote history." }
    }
  }
  if (gitSubcommand === "reset" && options.includes("--hard")) {
    return { decision: "force_ask", reason: "A hard Git reset discards local changes." }
  }
  if (gitSubcommand === "clean" && shortFlags.includes("f") && shortFlags.includes("d") && /[xX]/u.test(shortFlags)) {
    return { decision: "force_ask", reason: "This Git clean deletes untracked directories or ignored files." }
  }
  if (crossesMount && ((command !== undefined && highIoCommands.has(command)) || gitSubcommand === "clone")) {
    return { decision: "ask", reason: "WSL2 cross-mount I/O can be slow on Windows drives. Confirm before running this command." }
  }
  return allow
}

export function evaluatePreToolUse(rawInput: string): HookDecision {
  const input = decodeHookInput(rawInput)
  if (input._tag === "Failure") {
    return { decision: "ask", reason: "Invalid Antigravity PreToolUse JSON or payload." }
  }
  const { toolCall, cwd } = input.value
  if (toolCall.name !== "run_command") return allow

  const args = decodeCommandArgs(toolCall.args)
  if (args._tag === "Failure") {
    return { decision: "ask", reason: "The run_command payload needs a string CommandLine." }
  }
  const { CommandLine } = args.value
  const crossesMount = (cwd?.startsWith("/mnt/") ?? false) || /\/mnt\/[a-zA-Z](?:\/|(?=$|[\s"';&|)]))/u.test(CommandLine)
  let strongest = allow
  for (const words of commandWords(CommandLine)) {
    const decision = evaluateCommand(words, crossesMount)
    if (decision.decision === "deny") return decision
    if (priority[decision.decision] > priority[strongest.decision]) strongest = decision
  }
  return strongest
}

const main = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const input = yield* Stream.mkString(Stream.decodeText(stdio.stdin))
  yield* Console.log(JSON.stringify(evaluatePreToolUse(input)))
})

if (import.meta.main ?? (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)) {
  // @effect-diagnostics-next-line strictEffectProvide:off
  NodeRuntime.runMain(Effect.provide(main, NodeStdio.layer))
}
