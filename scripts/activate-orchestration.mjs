#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { installProfiles } from "../packages/codex-profiles/install.mjs";
import { assertReadableFile } from "../packages/guardrails/agy-preinvocation-guard.ts";
import { renderAgyHooks } from "../packages/guardrails/render-agy-hooks.mjs";
import {
  ANTIGRAVITY_CORE_SKILLS, CODEX_CORE_SKILLS, assertSupportedNode, decodeJsonRecord, printVerification,
  resolveOrchestrationPaths, verificationFlags, verificationOptions, verifyOrchestration,
} from "../packages/guardrails/verify-orchestration.mjs";
import { installSkills } from "../skills/writing-for-agents/scripts/install-skills.mjs";
import { withOutputLock } from "../skills/writing-for-agents/scripts/materialize-skill-variants.mjs";

const startMarker = "<!-- agy-codex-executor:start -->";
const endMarker = "<!-- agy-codex-executor:end -->";

function mergeExecutorInstructions(existing, instructions) {
  const managed = `${startMarker}\n${instructions}\n${endMarker}`;
  const markers = [...existing.matchAll(/^<!-- agy-codex-executor:(start|end) -->\r?$/gm)];
  if (markers.length > 0) {
    const [start, end] = markers;
    if (markers.length !== 2 || start[1] !== "start" || end[1] !== "end") {
      throw new Error("Invalid agy-codex-executor markers in Codex AGENTS.md");
    }
    // Leave line endings and user content outside the managed block intact.
    const after = end.index + endMarker.length;
    return existing.slice(0, start.index) + managed + existing.slice(after);
  }

  let userInstructions = existing;
  if (/^# Codex executor instructions\r?(?:\n|$)/u.test(existing)) {
    if (existing.startsWith(instructions)) {
      const remainder = existing.slice(instructions.length);
      return `${managed}${remainder.startsWith("\n") ? "" : "\n"}${remainder}`;
    }
    // An older unmanaged template can have changed wording before the first user section.
    const executorHeadings = new Set(instructions.match(/^#{1,2} .+$/gm));
    const userHeading = [...existing.matchAll(/^#{1,2} .+$/gm)].find(
      heading => heading.index > 0 && !executorHeadings.has(heading[0]),
    );
    userInstructions = existing.slice(userHeading?.index ?? existing.length);
  }
  return userInstructions === "" ? `${managed}\n` : `${managed}\n\n${userInstructions}`;
}

function planText(filename, transform, { backup = false } = {}) {
  const entry = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (entry !== undefined) assertReadableFile(filename);
  const previous = entry === undefined ? "" : fs.readFileSync(filename, "utf8");
  const contents = transform(previous);
  if (contents === previous) return undefined;
  return { filename, entry, contents, backup };
}

function planLink(filename, target) {
  assertReadableFile(target);
  const entry = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink() && path.resolve(path.dirname(filename), fs.readlinkSync(filename)) === target) {
    return undefined;
  }
  if (entry !== undefined && !entry.isSymbolicLink() && !entry.isFile()) {
    throw new Error(`Preserving non-file at ${filename}`);
  }
  return { filename, entry, target, backup: true };
}

function publishConfig({ filename, entry, contents, target, backup }) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const staging = fs.mkdtempSync(`${filename}.install-`);
  try {
    const prepared = path.join(staging, "config");
    if (target !== undefined) fs.symlinkSync(target, prepared);
    else fs.writeFileSync(prepared, contents, { mode: entry?.isFile() ? entry.mode & 0o777 : 0o600 });

    if (backup && entry !== undefined) {
      const saved = `${filename}.bak-${randomUUID()}`;
      if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(filename), saved);
      else fs.copyFileSync(filename, saved, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(prepared, filename);
  } finally {
    fs.rmSync(staging, { recursive: true });
  }
}

function planConfig(paths) {
  const { repoRoot, geminiRoot, codexRoot, nodeBin } = paths;
  const instructions = fs.readFileSync(path.join(repoRoot, "codex", "executor-AGENTS.md"), "utf8").trimEnd();
  const hooks = renderAgyHooks(nodeBin, paths);
  return [
    planLink(path.join(codexRoot, "rules", "guardrails.rules"), path.join(repoRoot, "packages", "guardrails", "codex-guardrails.rules")),
    planText(path.join(codexRoot, "AGENTS.md"), previous => mergeExecutorInstructions(previous, instructions), { backup: true }),
    planLink(path.join(geminiRoot, "GEMINI.md"), path.join(repoRoot, "gemini", "GEMINI.md")),
    planText(path.join(geminiRoot, "config", "hooks.json"), previous => {
      const existing = previous.trim() === "" ? {} : decodeJsonRecord(previous);
      const merged = { ...existing, ...hooks };
      return JSON.stringify(existing) === JSON.stringify(merged) ? previous : `${JSON.stringify(merged, null, 2)}\n`;
    }),
  ].filter(entry => entry !== undefined);
}

export function activateOrchestration(options = {}) {
  const paths = resolveOrchestrationPaths(options);
  const { repoRoot, geminiRoot, codexRoot, nodeBin, binDir } = paths;
  assertSupportedNode(nodeBin);
  const shared = { sourceRoot: path.join(repoRoot, "skills"), nodeBin, binDir };
  const agySkills = { ...shared, harness: "antigravity", model: "gemini-4-neon", root: path.join(geminiRoot, "config"), onlySkillNames: ANTIGRAVITY_CORE_SKILLS };
  const codexSkills = { ...shared, harness: "codex", model: "gpt-6.2-sol", root: codexRoot, onlySkillNames: CODEX_CORE_SKILLS };
  const profiles = { source: repoRoot, root: codexRoot };
  const dryRun = options.dryRun ?? false;

  const preview = {
    dryRun,
    antigravity: installSkills({ ...agySkills, dryRun: true }),
    codex: installSkills({ ...codexSkills, dryRun: true }),
    profiles: installProfiles({ ...profiles, dryRun: true }),
    updatedFiles: planConfig(paths).map(({ filename }) => filename),
  };
  if (dryRun) return preview;

  return withOutputLock(path.join(codexRoot, ".orchestration-activation"), () => {
    const files = planConfig(paths);
    const antigravity = installSkills(agySkills);
    const codex = installSkills(codexSkills);
    const installedProfiles = installProfiles(profiles);
    for (const file of files) publishConfig(file);
    const verification = verifyOrchestration({ ...options, ...paths });
    if (!verification.ok) {
      const failed = verification.checks.filter(check => check.status === "fail");
      throw Object.assign(new Error(`Orchestration verification failed:\n${failed.map(({ name, detail }) => `- ${name}: ${detail}`).join("\n")}`), { verification });
    }
    return { dryRun, antigravity, codex, profiles: installedProfiles, updatedFiles: files.map(({ filename }) => filename), verification };
  });
}

if (import.meta.main ?? (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)) {
  let json = false;
  try {
    const { values } = parseArgs({ options: { ...verificationFlags, "dry-run": { type: "boolean" } } });
    json = values.json;
    if (values.help) {
      console.log("Usage: node scripts/activate-orchestration.mjs [--dry-run] [--json] [--gemini-root PATH] [--codex-root PATH] [--bin-dir PATH] [--node-bin PATH] [--skip-codex-login] [--skip-codex-execpolicy]");
    } else {
      const report = activateOrchestration({ ...verificationOptions(values), dryRun: values["dry-run"] });
      if (json) console.log(JSON.stringify(report));
      else if (report.dryRun) {
        console.log(`Would install ${report.antigravity.skillCount} Antigravity skills and ${report.codex.skillCount} Codex skills.`);
        for (const { destination, changed } of report.profiles.links) if (changed) console.log(`Would link ${destination}`);
        for (const filename of report.updatedFiles) console.log(`Would update ${filename}`);
      } else printVerification(report.verification, false);
    }
  } catch (error) {
    if (error.verification !== undefined) printVerification(error.verification, json);
    else if (json) console.log(JSON.stringify({ ok: false, error: error.message }));
    else console.error(error.message);
    process.exitCode = 1;
  }
}
