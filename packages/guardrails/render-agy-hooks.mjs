import { fileURLToPath } from "node:url";

const guardPath = fileURLToPath(new URL("./agy-pretool-guard.ts", import.meta.url));
const command = [process.execPath, guardPath]
  .map(value => `'${value.replaceAll("'", "'\\''")}'`)
  .join(" ");

const hooks = {
  "deterministic-command-guard": {
    PreToolUse: [
      {
        matcher: "run_command",
        hooks: [{ type: "command", command: `exec ${command}`, timeout: 10 }],
      },
    ],
  },
};

process.stdout.write(`${JSON.stringify(hooks, null, 2)}\n`);
