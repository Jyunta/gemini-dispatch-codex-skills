import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { activateOrchestration } from "../../scripts/activate-orchestration.mjs";
import { verifyOrchestration } from "./verify-orchestration.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration 'HOME'-"));
  t.after(() => fs.rmSync(home, { recursive: true }));
  return {
    repoRoot, home,
    geminiRoot: path.join(home, "antigravity config"),
    codexRoot: path.join(home, "codex config"),
    binDir: path.join(home, "apps", "bin"),
    skipCodexLogin: true, skipCodexExecpolicy: true,
  };
}

test("activation CLI previews both installs without writing configuration", t => {
  const options = fixture(t);
  const { home, geminiRoot, codexRoot, binDir } = options;
  const result = spawnSync(process.execPath, [
    "scripts/activate-orchestration.mjs", "--dry-run", "--json", "--gemini-root", geminiRoot, "--codex-root", codexRoot,
    "--bin-dir", binDir, "--node-bin", process.execPath, "--skip-codex-login", "--skip-codex-execpolicy",
  ], { cwd: repoRoot, env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.antigravity.skillCount, 13);
  assert.equal(preview.codex.skillCount, 5);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("activation preserves user configuration and verifies the installed routes and hooks", t => {
  const options = fixture(t);
  const { home, geminiRoot, codexRoot } = options;
  const configDir = path.join(geminiRoot, "config");
  const rulesDir = path.join(codexRoot, "rules");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(rulesDir, { recursive: true });

  const agents = path.join(codexRoot, "AGENTS.md");
  const branchRules = "## Git branch naming\n\nUse descriptive branches.\n";
  const legacyAgents = `# Codex executor instructions\n\n## Implementation\n\nAn older executor template.\n\n${branchRules}`;
  fs.writeFileSync(agents, legacyAgents);
  const defaultRules = path.join(rulesDir, "default.rules");
  fs.writeFileSync(defaultRules, "# My local rules\n");
  const guardrails = path.join(rulesDir, "guardrails.rules");
  fs.writeFileSync(guardrails, "# Previous guardrails\n");
  const gemini = path.join(geminiRoot, "GEMINI.md");
  fs.writeFileSync(gemini, "# My prior Gemini configuration\n");
  const hooks = path.join(configDir, "hooks.json");
  const personalHook = { PreInvocation: [{ type: "command", command: "true", timeout: 1 }] };
  fs.writeFileSync(hooks, JSON.stringify({ "personal-hook": personalHook }));

  const activated = activateOrchestration(options);
  assert.equal(activated.verification.ok, true, JSON.stringify(activated.verification));
  const mergedAgents = fs.readFileSync(agents, "utf8");
  assert.equal(mergedAgents.match(/^# Codex executor instructions$/gm).length, 1);
  assert.match(mergedAgents, /<!-- agy-codex-executor:start -->\n# Codex executor instructions/);
  assert.ok(mergedAgents.endsWith(branchRules));
  assert.equal(fs.readFileSync(defaultRules, "utf8"), "# My local rules\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(hooks, "utf8"))["personal-hook"], personalHook);
  for (const [filename, original] of [
    [agents, legacyAgents], [guardrails, "# Previous guardrails\n"], [gemini, "# My prior Gemini configuration\n"],
  ]) {
    const directory = path.dirname(filename);
    const prefix = `${path.basename(filename)}.bak-`;
    const backups = fs.readdirSync(directory).filter(name => name.startsWith(prefix));
    assert.equal(backups.length, 1, filename);
    assert.equal(fs.readFileSync(path.join(directory, backups[0]), "utf8"), original);
  }

  assert.deepEqual(activateOrchestration(options).updatedFiles, []);
  assert.equal(fs.readFileSync(agents, "utf8"), mergedAgents);
  const verified = verifyOrchestration(options);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  const results = new Map(verified.checks.map(check => [check.name, check]));
  for (const name of [
    "dispatch-codex scout", "dispatch-codex review", "dispatch-codex review --deep", "Antigravity configured hooks",
  ]) {
    assert.equal(results.get(name)?.status, "pass", name);
  }

  const codex = path.join(options.binDir, "codex");
  fs.writeFileSync(codex, "#!/bin/sh\nprintf '%s\\n' 'Logged in using an API key'\n", { mode: 0o755 });
  assert.throws(() => activateOrchestration({ ...options, skipCodexLogin: false }), /Codex login: .* using ChatGPT/);

  fs.unlinkSync(gemini);
  fs.symlinkSync(path.join(home, "missing"), gemini);
  const skills = path.join(configDir, "skills");
  const escapedSkill = path.join(skills, "code-review");
  const outside = path.join(home, "outside-skill");
  fs.renameSync(escapedSkill, outside);
  fs.symlinkSync(outside, escapedSkill);
  const escapedReference = path.join(skills, "grilling", "references", "outside.md");
  fs.symlinkSync(path.join(outside, "SKILL.md"), escapedReference);

  const broken = verifyOrchestration(options);
  assert.equal(broken.ok, false);
  const failures = new Map(broken.checks.filter(check => check.status === "fail").map(check => [check.name, check.detail]));
  assert.match(failures.get("Gemini GEMINI.md"), /GEMINI\.md/);
  assert.match(failures.get("Antigravity skill code-review"), /real skill directory/);
  assert.match(failures.get("Antigravity skill grilling"), /outside\.md resolves outside/);
  assert.match(failures.get("Antigravity configured hooks"), /PreInvocation expected \{\}/);
});
