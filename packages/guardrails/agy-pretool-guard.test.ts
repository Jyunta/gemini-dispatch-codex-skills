import { describe, expect, it } from "vitest"

import { evaluatePreToolUse } from "./agy-pretool-guard.ts"

const runCommand = (CommandLine: string, cwd = "/home/jesse/skills") =>
  JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine } }, cwd })

describe("Antigravity PreToolUse guard", () => {
  it.each([
    "git status",
    "bun run validate:effect",
    "dispatch-codex run --role impl",
    "printf '%s\n' 'rm -rf /; git push --force'",
    "git status # rm -rf /",
    "git push -- --force",
    "dd if=/dev/zero of=image"
  ])("allows %s", (command) => {
    expect(evaluatePreToolUse(runCommand(command))).toEqual({ decision: "allow" })
  })

  it("allows another tool even if its arguments include a destructive command", () => {
    const payload = JSON.stringify({ toolCall: { name: "view_file", args: { CommandLine: "rm -rf /" } } })
    expect(evaluatePreToolUse(payload)).toEqual({ decision: "allow" })
  })

  it.each([
    "rm -rf /",
    "rm -rf ~",
    "rm -fr /*",
    'rm -r -f "$HOME"',
    "rm --recursive --force /etc",
    "rm -rf --no-preserve-root build",
    "sudo /usr/sbin/mkfs.ext4 /dev/sdb",
    "dd if=image of=/dev/sdb",
    "git push --force origin main && rm -rf /"
  ])("denies %s", (command) => {
    expect(evaluatePreToolUse(runCommand(command))).toMatchObject({ decision: "deny", reason: expect.any(String) })
  })

  it.each([
    "git push --force",
    "git push -f",
    "git push --force-with-lease --force",
    "git reset --hard",
    "git clean -fdx",
    "git clean -fxd",
    "git clean -fdX",
    "git clean -f -d -x",
    "rm -rf build",
    "rm -fr build",
    "rm -r -f build"
  ])("always prompts for %s", (command) => {
    expect(evaluatePreToolUse(runCommand(command))).toMatchObject({ decision: "force_ask", reason: expect.any(String) })
  })

  it("asks for a force-with-lease push", () => {
    expect(evaluatePreToolUse(runCommand("git push --force-with-lease"))).toMatchObject({ decision: "ask" })
  })

  it.each([
    ["npm --prefix /mnt/c/project test", "/home/jesse/skills"],
    ["pnpm --dir /mnt/C", "/home/jesse/skills"],
    ["git -C /mnt/c/project clone origin", "/home/jesse/skills"],
    ["cargo test", "/mnt/c/project"],
    ["codex", "/mnt/c/project"]
  ])("warns about WSL2 when running %s from %s", (command, cwd) => {
    expect(evaluatePreToolUse(runCommand(command, cwd))).toMatchObject({ decision: "ask", reason: expect.stringContaining("WSL2") })
  })

  it("allows a low-I/O command from a Windows mount", () => {
    expect(evaluatePreToolUse(runCommand("git status", "/mnt/c/project"))).toEqual({ decision: "allow" })
  })

  it.each([
    '{"toolCall":',
    "{}",
    '{"toolCall":{"name":"run_command","args":{"CommandLine":17}}}'
  ])("asks when the hook input is invalid (%s)", (input) => {
    expect(evaluatePreToolUse(input)).toMatchObject({ decision: "ask", reason: expect.any(String) })
  })
})
