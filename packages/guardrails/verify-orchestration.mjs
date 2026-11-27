import * as Schema from "effect/Schema";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { assertInstalledSkill, assertReadableFile, assertRealpathInside } from "./agy-preinvocation-guard.ts";

export const ANTIGRAVITY_CORE_SKILLS = Object.freeze([
  "agy-codex-orchestrator", "cleanup", "code-review", "coding-standards", "design",
  "design-technical-diagrams", "frontend-ui-validation", "grilling", "skill-cleaner",
  "typescript-discipline", "wait-efficiently", "writing-for-agents", "writing-good-tests",
]);
export const CODEX_CORE_SKILLS = Object.freeze([
  "coding-standards", "design", "frontend-ui-validation", "typescript-discipline", "writing-good-tests",
]);

const repository = fileURLToPath(new URL("../../", import.meta.url));
const profileLinks = [
  "orchestration", "findings-reviewer.config.toml", "orchestration.config.toml",
  "review-sol.config.toml", "redteam-astra.config.toml",
];

const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
export const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecord);
const CommandHook = Schema.Struct({ type: Schema.Literal("command"), command: Schema.NonEmptyString });
const decodeHooks = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  "deterministic-command-guard": Schema.Struct({
    PreToolUse: Schema.Array(Schema.Struct({ matcher: Schema.String, hooks: Schema.Array(CommandHook) })),
  }),
  "orchestration-health-gate": Schema.Struct({ PreInvocation: Schema.NonEmptyArray(CommandHook) }),
})));
const decodeDispatchPlan = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  dryRun: Schema.Literal(true),
  args: Schema.Array(Schema.String),
  model: Schema.String,
  effort: Schema.String,
})));

export function resolveOrchestrationPaths({
  repoRoot = repository,
  home = process.env.HOME || os.homedir(),
  geminiRoot = process.env.AGY_ORCH_GEMINI_ROOT || path.join(home, ".gemini"),
  codexRoot = process.env.CODEX_HOME || path.join(home, ".codex"),
  binDir = process.env.AGY_ORCH_BIN_DIR || path.join(home, ".local", "bin"),
  nodeBin = process.execPath,
} = {}) {
  return {
    repoRoot: path.resolve(repoRoot), home: path.resolve(home),
    geminiRoot: path.resolve(geminiRoot), codexRoot: path.resolve(codexRoot),
    binDir: path.resolve(binDir), nodeBin: path.resolve(nodeBin),
  };
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, ...options });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 1_000);
    throw new Error(`${command} exited with ${result.status ?? result.signal}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export function assertSupportedNode(nodeBin) {
  const version = nodeBin === process.execPath ? process.version : run(nodeBin, ["--version"]).stdout.trim();
  const major = Number(/^v(\d+)\./u.exec(version)?.[1]);
  if (!(major >= 24)) throw new Error(`Node 24 or newer is required at ${nodeBin} (found ${version})`);
  return version;
}

function assertSkillReferences(skillsRoot, directory, seen = new Set()) {
  assertRealpathInside(directory, skillsRoot);
  const resolved = fs.realpathSync(directory);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  for (const name of fs.readdirSync(resolved)) {
    const entry = path.join(resolved, name);
    assertRealpathInside(entry, skillsRoot);
    if (fs.statSync(entry).isDirectory()) assertSkillReferences(skillsRoot, entry, seen);
    else assertReadableFile(entry);
  }
}

export function verifyOrchestration(options = {}) {
  const { repoRoot, geminiRoot, codexRoot, binDir, home, nodeBin } = resolveOrchestrationPaths(options);
  const checks = [];
  const check = (name, verify) => {
    try {
      const detail = verify();
      checks.push({ name, status: "pass", ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      checks.push({ name, status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const skip = (name, flag) => checks.push({ name, status: "skip", detail: flag });

  check("Node 24+", () => assertSupportedNode(nodeBin));
  check("Gemini GEMINI.md", () => {
    const filename = path.join(geminiRoot, "GEMINI.md");
    assertReadableFile(filename, { nonEmpty: true });
    if (fs.lstatSync(filename).isSymbolicLink()) {
      const source = fs.realpathSync(path.join(repoRoot, "gemini", "GEMINI.md"));
      if (fs.realpathSync(filename) !== source) throw new Error(`${filename} must resolve to ${source}`);
    }
  });

  const skillsRoot = path.join(geminiRoot, "config", "skills");
  for (const name of ANTIGRAVITY_CORE_SKILLS) {
    check(`Antigravity skill ${name}`, () => {
      assertInstalledSkill(skillsRoot, name);
      const references = path.join(skillsRoot, name, "references");
      if (fs.lstatSync(references, { throwIfNoEntry: false }) !== undefined) {
        assertSkillReferences(fs.realpathSync(skillsRoot), references);
      }
    });
  }

  const cleanEnv = { HOME: home, PATH: `${binDir}:/usr/bin:/bin`, CODEX_HOME: codexRoot };
  for (const [role, profile, deep] of [
    ["scout", undefined, false], ["review", "review-sol", false], ["review", "redteam-astra", true],
  ]) {
    check(`dispatch-codex ${role}${deep ? " --deep" : ""}`, () => {
      const args = ["run", "--role", role, ...(deep ? ["--deep"] : []), "--dry-run", "--cwd", repoRoot, "--prompt", "probe", "--json"];
      const plan = decodeDispatchPlan(run("dispatch-codex", args, { env: cleanEnv }).stdout);
      if (profile === undefined) {
        if (plan.model !== "gpt-6.2-sol" || plan.effort !== "medium") {
          throw new Error(`Expected gpt-6.2-sol at medium effort, got ${plan.model} at ${plan.effort}`);
        }
        return `${plan.model}, ${plan.effort}`;
      }
      if (!plan.args.some((arg, index) => arg === "-p" && plan.args[index + 1] === profile)) {
        throw new Error(`Expected -p ${profile} in the dry-run command`);
      }
      return `-p ${profile}`;
    });
  }

  for (const name of CODEX_CORE_SKILLS) {
    check(`Codex skill ${name}`, () => assertReadableFile(path.join(codexRoot, "skills", name, "SKILL.md")));
  }
  for (const name of profileLinks) {
    check(`Codex profile link ${name}`, () => {
      const link = path.join(codexRoot, name);
      if (!fs.lstatSync(link).isSymbolicLink()) throw new Error(`Expected a profile link at ${link}`);
      if (name === "orchestration") {
        if (!fs.statSync(link).isDirectory()) throw new Error(`Expected a profile directory at ${link}`);
        fs.accessSync(link, fs.constants.R_OK | fs.constants.X_OK);
      } else {
        assertReadableFile(link);
      }
    });
  }

  const rules = path.join(codexRoot, "rules", "guardrails.rules");
  check("Codex guardrails.rules", () => assertReadableFile(rules));
  const codexEnv = { ...process.env, HOME: home, CODEX_HOME: codexRoot, PATH: `${binDir}:${process.env.PATH || "/usr/bin:/bin"}` };
  delete codexEnv.CODEX_API_KEY;
  delete codexEnv.OPENAI_API_KEY;
  if (options.skipCodexExecpolicy) {
    skip("Codex execpolicy", "--skip-codex-execpolicy");
  } else {
    check("Codex execpolicy", () => {
      const { stdout } = run("codex", ["execpolicy", "check", "--rules", rules, "--", "git", "push", "--force"], { env: codexEnv });
      const result = decodeJsonRecord(stdout);
      if (result.decision !== "forbidden") throw new Error(`Expected forbidden for git push --force, got ${stdout.trim()}`);
      return "git push --force is forbidden";
    });
  }
  if (options.skipCodexLogin) {
    skip("Codex login", "--skip-codex-login");
  } else {
    check("Codex login", () => {
      const { stdout, stderr } = run("codex", ["login", "status"], { env: codexEnv });
      if (!/\blogged in using ChatGPT\b/iu.test(`${stdout}\n${stderr}`)) {
        throw new Error("Codex must be signed in using ChatGPT. Run codex login and select ChatGPT.");
      }
      return "ChatGPT sign-in";
    });
  }

  check("Antigravity configured hooks", () => {
    const hooksPath = path.join(geminiRoot, "config", "hooks.json");
    assertReadableFile(hooksPath);
    const hooks = decodeHooks(fs.readFileSync(hooksPath, "utf8"));
    const preTool = hooks["deterministic-command-guard"].PreToolUse.find(group => group.matcher === "run_command")?.hooks[0];
    if (preTool === undefined) throw new Error("PreToolUse needs a run_command matcher with a command hook");
    const preInvocation = hooks["orchestration-health-gate"].PreInvocation[0];
    const env = { ...cleanEnv, AGY_ORCH_GEMINI_ROOT: geminiRoot, AGY_ORCH_BIN_DIR: binDir };
    for (const [CommandLine, decision] of [["rm -rf /Users/test", "deny"], ["git status", "allow"]]) {
      const input = JSON.stringify({ cwd: repoRoot, toolCall: { name: "run_command", args: { CommandLine } } });
      const { stdout } = run("/bin/sh", ["-c", preTool.command], { env, input, cwd: repoRoot });
      if (decodeJsonRecord(stdout).decision !== decision) {
        throw new Error(`PreToolUse should ${decision} ${CommandLine}, got ${stdout.trim()}`);
      }
    }
    const input = JSON.stringify({ invocationNum: 1, cwd: repoRoot });
    const { stdout } = run("/bin/sh", ["-c", preInvocation.command], { env, input, cwd: repoRoot });
    if (Object.keys(decodeJsonRecord(stdout)).length !== 0) {
      throw new Error(`PreInvocation expected {}, got ${stdout.trim()}`);
    }
    return "PreToolUse deny/allow and PreInvocation pass";
  });
  return { ok: checks.every(({ status }) => status !== "fail"), checks };
}

export const verificationFlags = {
  "node-bin": { type: "string" },
  "gemini-root": { type: "string" },
  "codex-root": { type: "string" },
  "bin-dir": { type: "string" },
  "skip-codex-login": { type: "boolean" },
  "skip-codex-execpolicy": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export function verificationOptions(flags) {
  return {
    repoRoot: flags["repo-root"], geminiRoot: flags["gemini-root"], codexRoot: flags["codex-root"],
    binDir: flags["bin-dir"], nodeBin: flags["node-bin"],
    skipCodexLogin: flags["skip-codex-login"], skipCodexExecpolicy: flags["skip-codex-execpolicy"],
  };
}

export function printVerification(report, json) {
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  for (const { name, status, detail } of report.checks) {
    console.log(`${status.toUpperCase()} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

if (import.meta.main ?? (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)) {
  try {
    const { values } = parseArgs({ options: { ...verificationFlags, "repo-root": { type: "string" } } });
    if (values.help) {
      console.log("Usage: node packages/guardrails/verify-orchestration.mjs [--json] [--repo-root PATH] [--gemini-root PATH] [--codex-root PATH] [--bin-dir PATH] [--node-bin PATH] [--skip-codex-login] [--skip-codex-execpolicy]");
    } else {
      const report = verifyOrchestration(verificationOptions(values));
      printVerification(report, values.json);
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
