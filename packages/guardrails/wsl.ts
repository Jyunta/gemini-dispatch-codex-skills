// The synchronous runtime probe has no Effect FileSystem service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs"

function readLinuxProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8")
  } catch {
    return ""
  }
}

export function isWslEnvironment({
  platform = process.platform,
  env = process.env,
  readProcVersion = readLinuxProcVersion
}: {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly readProcVersion?: () => string
} = {}): boolean {
  if (platform !== "linux") return false
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true
  return /microsoft/iu.test(readProcVersion())
}
