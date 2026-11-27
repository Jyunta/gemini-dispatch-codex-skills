import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function renderAgyHooks(nodePath = process.execPath, { geminiRoot, codexRoot, binDir } = {}) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const rootVariables = [
    ["AGY_ORCH_GEMINI_ROOT", geminiRoot],
    ["CODEX_HOME", codexRoot],
    ["AGY_ORCH_BIN_DIR", binDir],
  ].flatMap(([name, value]) => value === undefined ? [] : [`${name}=${path.resolve(value)}`]);
  const hook = (filename, env = []) => {
    const script = fileURLToPath(new URL(filename, import.meta.url));
    const args = [...(env.length === 0 ? [] : ["/usr/bin/env", ...env]), path.resolve(nodePath), script];
    return { type: "command", command: `exec ${args.map(quote).join(" ")}`, timeout: 10 };
  };
  return {
    "deterministic-command-guard": {
      PreToolUse: [{ matcher: "run_command", hooks: [hook("./agy-pretool-guard.ts")] }],
    },
    "orchestration-health-gate": {
      PreInvocation: [hook("./agy-preinvocation-guard.ts", rootVariables)],
    },
  };
}

if (import.meta.main ?? (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)) {
  process.stdout.write(`${JSON.stringify(renderAgyHooks(), null, 2)}\n`);
}
