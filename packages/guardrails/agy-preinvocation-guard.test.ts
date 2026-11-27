// These fixtures exercise the same synchronous filesystem checks as the hook.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs"
import { tmpdir } from "node:os"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { evaluatePreInvocation } from "./agy-preinvocation-guard.ts"

describe("Antigravity PreInvocation health gate", () => {
  let root: string
  let geminiRoot: string
  let codexRoot: string
  let binDir: string

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "agy-health-"))
    geminiRoot = join(root, ".gemini")
    codexRoot = join(root, ".codex")
    binDir = join(root, ".local", "bin")
    for (const name of ["agy-codex-orchestrator", "code-review"]) {
      const skill = join(geminiRoot, "config", "skills", name)
      fs.mkdirSync(skill, { recursive: true })
      fs.writeFileSync(join(skill, "SKILL.md"), "# Instructions")
    }
    fs.writeFileSync(join(geminiRoot, "GEMINI.md"), "# Gemini")
    fs.mkdirSync(join(codexRoot, "rules"), { recursive: true })
    for (const name of ["review-sol.config.toml", "redteam-astra.config.toml", "rules/guardrails.rules"]) {
      fs.writeFileSync(join(codexRoot, name), "# Configuration")
    }
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(join(binDir, "dispatch-codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true })
  })

  function evaluate(input = "{}", mode?: string) {
    return evaluatePreInvocation(input, { geminiRoot, binDir, codexRoot, env: { AGY_ORCH_GUARD: mode } })
  }

  it("passes a healthy installation with optional or extra fields", () => {
    expect(evaluate()).toEqual({})
    expect(evaluate('{"invocationNum":1,"cwd":"/repo","extra":true}')).toEqual({})
  })

  it("accepts readable config/GEMINI.md when the top-level file is a broken link", () => {
    const filename = join(geminiRoot, "GEMINI.md")
    fs.renameSync(filename, join(geminiRoot, "config", "GEMINI.md"))
    fs.symlinkSync(join(root, "missing"), filename)
    expect(evaluate()).toEqual({})
  })

  it("bypasses later invocations even when the installation has broken", () => {
    fs.unlinkSync(join(geminiRoot, "GEMINI.md"))
    expect(evaluate('{"invocationNum":2}')).toEqual({})
  })

  it("terminates the first invocation and lists every failure and the recovery command", () => {
    fs.unlinkSync(join(geminiRoot, "GEMINI.md"))
    fs.unlinkSync(join(binDir, "dispatch-codex"))
    const profile = join(codexRoot, "review-sol.config.toml")
    fs.unlinkSync(profile)
    fs.symlinkSync(join(root, "missing"), profile)

    const result = evaluate('{"invocationNum":1}')
    expect(result.terminationBehavior).toBe("terminate")
    const step = result.injectSteps?.[0]
    expect(step).toHaveProperty("errorMessage")
    if (step === undefined || !("errorMessage" in step)) throw new Error("Expected termination details")
    const { userMessage } = step.errorMessage
    expect(userMessage).toContain("GEMINI.md")
    expect(userMessage).toContain("dispatch-codex")
    expect(userMessage).toContain("review-sol.config.toml")
    expect(userMessage).toMatch(/node .*\/scripts\/activate-orchestration\.mjs/)
    expect(userMessage).toContain("AGY_ORCH_GUARD=warn")
    expect(userMessage).toContain("AGY_ORCH_GUARD=off")
  })

  it("rejects SKILL.md that resolves outside the installed skills root", () => {
    const filename = join(geminiRoot, "config", "skills", "code-review", "SKILL.md")
    const external = join(root, "external.md")
    fs.renameSync(filename, external)
    fs.symlinkSync(external, filename)
    expect(evaluate()).toMatchObject({
      terminationBehavior: "terminate",
      injectSteps: [{ errorMessage: { userMessage: expect.stringContaining("resolves outside") } }]
    })
  })

  it("injects a visible warning without termination", () => {
    fs.writeFileSync(join(geminiRoot, "GEMINI.md"), "")
    const result = evaluate("{}", " WARN ")
    expect(result).not.toHaveProperty("terminationBehavior")
    expect(result.injectSteps).toMatchObject([{
      systemMessage: {
        systemMessage: expect.stringContaining("GEMINI.md"),
        metadata: { user_markdown: expect.stringContaining("Orchestration health check failed") }
      }
    }])
  })

  it("bypasses the filesystem in off mode", () => {
    fs.unlinkSync(join(binDir, "dispatch-codex"))
    expect(evaluate("{}", " OFF ")).toEqual({})
  })
})
