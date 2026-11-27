import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandSummary, planCommands, withInstalledCommands } from "./install-commands.mjs";
import { assertManagedOutput, assertTargetedView, materializeSkillVariants, planSkillVariants, withOutputLock } from "./materialize-skill-variants.mjs";

const sourceDefault = fileURLToPath(new URL("../../", import.meta.url));
const skillMarker = ".jesse-merhi-skill.json";
const SkillMarkerJson = Schema.fromJsonString(Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceRoot: Schema.NonEmptyString,
  profile: Schema.NonEmptyString,
}));

function harnessDirectory(harness) {
  switch (harness) {
    case "codex": return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    case "claude": return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    case "gemini": return path.join(process.env.GEMINI_CLI_HOME || os.homedir(), ".gemini");
    case "antigravity": return path.join(os.homedir(), ".gemini", "config");
    case "cursor": return path.join(os.homedir(), ".cursor");
    default: throw new Error(`unsupported harness: ${harness}`);
  }
}

// Cursor has no global AGENTS.md. An always-applied rule in a local plugin loads in every project.
const cursorRuleHeader = "---\ndescription: Global agent instructions from the skills repository's AGENTS.md\nalwaysApply: true\n---\n\n";

function cursorRulePath(harnessRoot) {
  return path.join(harnessRoot, "plugins", "local", "jesse-merhi-skills", "rules", "global-agents.mdc");
}

function writeCursorRule(rule, instructions) {
  const plugin = path.dirname(path.dirname(rule));
  fs.mkdirSync(path.join(plugin, ".cursor-plugin"), { recursive: true });
  fs.mkdirSync(path.dirname(rule), { recursive: true });
  fs.writeFileSync(path.join(plugin, ".cursor-plugin", "plugin.json"), `${JSON.stringify({ name: path.basename(plugin), description: "Global agent instructions" }, null, 2)}\n`);
  fs.writeFileSync(rule, cursorRuleHeader + instructions);
}

function withHarnessInstallationLock(harnessRoot, operation) {
  const rootExisted = fs.lstatSync(harnessRoot, { throwIfNoEntry: false }) !== undefined;
  try {
    return withOutputLock(path.join(harnessRoot, ".skills-installation"), operation);
  } catch (error) {
    if (!rootExisted) {
      try {
        fs.rmdirSync(harnessRoot);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Error) || !Object.hasOwn(cleanupError, "code") || !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(cleanupError.code)) throw cleanupError;
      }
    }
    throw error;
  }
}

function assertSkillsDirectory(skillsDirectory) {
  const directory = fs.lstatSync(skillsDirectory, { throwIfNoEntry: false });
  if (directory !== undefined && !directory.isDirectory()) {
    throw new Error(`skills directory must be a real directory: ${skillsDirectory}`);
  }
  return directory;
}

function isSourceSkillLink(target, skill, sourceRoot, previousSourceRoot) {
  const canonicalTarget = fs.existsSync(target) ? fs.realpathSync(target) : target;
  const previous = previousSourceRoot === undefined ? undefined : path.resolve(previousSourceRoot, path.relative(sourceRoot, skill.directory));
  return canonicalTarget === skill.directory || target === previous;
}

function inspectLinks(skillsDirectory, viewRoot, skills, sourceRoot, previousSourceRoot, targeted) {
  const directory = assertSkillsDirectory(skillsDirectory);
  const links = [];
  const retired = [];
  const names = new Set(skills.map((skill) => skill.name));
  for (const skill of skills) {
    const destination = path.join(skillsDirectory, skill.name);
    const expected = path.join(viewRoot, skill.name);
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (existing === undefined) {
      links.push({ destination, expected });
      continue;
    }
    if (!existing.isSymbolicLink()) throw new Error(`preserving existing local skill: ${destination}`);
    const original = fs.readlinkSync(destination);
    const target = path.resolve(skillsDirectory, original);
    if (target === expected) continue;
    if (!isSourceSkillLink(target, skill, sourceRoot, previousSourceRoot)) throw new Error(`preserving skill owned elsewhere: ${destination}`);
    links.push({ destination, expected, original });
  }
  if (directory !== undefined && !targeted) {
    for (const entry of fs.readdirSync(skillsDirectory, { withFileTypes: true })) {
      if (!entry.isSymbolicLink() || names.has(entry.name)) continue;
      const destination = path.join(skillsDirectory, entry.name);
      const target = path.resolve(skillsDirectory, fs.readlinkSync(destination));
      if (target === path.join(viewRoot, entry.name)) retired.push(destination);
    }
  }
  return { links, retired };
}

function readSkillMarker(directory, name) {
  const marker = path.join(directory, name);
  if (!fs.lstatSync(marker, { throwIfNoEntry: false })?.isFile()) return undefined;
  return Option.getOrUndefined(Schema.decodeUnknownOption(SkillMarkerJson)(fs.readFileSync(marker, "utf8")));
}

function inspectAntigravitySkills(skillsDirectory, legacyView, plan, previousSourceRoot, targeted) {
  const directory = assertSkillsDirectory(skillsDirectory);
  const entries = directory === undefined ? [] : fs.readdirSync(skillsDirectory, { withFileTypes: true });
  const previous = previousSourceRoot === undefined ? undefined
    : fs.existsSync(previousSourceRoot) ? fs.realpathSync(previousSourceRoot) : path.resolve(previousSourceRoot);
  const owns = (marker) => marker !== undefined && (marker.sourceRoot === plan.sourceRoot || marker.sourceRoot === previous);
  const matches = (marker) => marker?.sourceRoot === plan.sourceRoot && marker.profile === plan.profile.id;
  const legacyMarker = readSkillMarker(legacyView, ".skill-variant-view.json");
  const installed = new Map(entries.map((entry) => {
    const destination = path.join(skillsDirectory, entry.name);
    return [entry.name, {
      destination,
      marker: entry.isDirectory() ? readSkillMarker(destination, skillMarker) : undefined,
      target: entry.isSymbolicLink() ? path.resolve(skillsDirectory, fs.readlinkSync(destination)) : undefined,
    }];
  }));
  if (targeted) {
    const markers = [legacyMarker, ...Array.from(installed.values(), ({ marker }) => marker)].filter(Boolean);
    if (!markers.some(matches)) {
      throw new Error(markers.length === 0
        ? "targeted installation requires an existing managed view"
        : "targeted installation cannot switch profile or source; use a full installation");
    }
  }
  const isLegacyLink = (target, name) => target === path.join(legacyView, name)
    && (legacyMarker === undefined || (targeted ? matches(legacyMarker) : owns(legacyMarker)));
  const names = new Set(plan.skills.map((skill) => skill.name));
  const changes = plan.skills.map((skill) => {
    const destination = path.join(skillsDirectory, skill.name);
    const existing = installed.get(skill.name);
    if (existing !== undefined) {
      const { target, marker } = existing;
      const managed = target === undefined
        ? targeted ? matches(marker) : owns(marker)
        : isLegacyLink(target, skill.name) || isSourceSkillLink(target, skill, plan.sourceRoot, targeted ? undefined : previousSourceRoot);
      if (!managed) throw new Error(`preserving existing local or foreign skill: ${destination}`);
    }
    return { destination, skill, exists: existing !== undefined };
  });
  const retired = targeted ? [] : Array.from(installed).filter(([name, { marker, target }]) =>
    !names.has(name) && (owns(marker) || isLegacyLink(target, name))).map(([, { destination }]) => destination);
  return { changes, retired };
}

function publishAntigravitySkills(skillsDirectory, plan, inspect) {
  // Use same-filesystem renames to publish complete directories and retain old entries for rollback.
  const transaction = fs.mkdtempSync(path.join(path.dirname(skillsDirectory), ".skills-install-"));
  const staged = path.join(transaction, "staged");
  const backup = path.join(transaction, "backup");
  const backedUp = [];
  const published = [];
  let createdSkillsDirectory = false;
  let result;
  try {
    fs.mkdirSync(backup);
    const marker = Schema.encodeSync(SkillMarkerJson)({ schemaVersion: 1, sourceRoot: plan.sourceRoot, profile: plan.profile.id });
    for (const skill of plan.skills) {
      const directory = path.join(staged, skill.name);
      fs.mkdirSync(directory, { recursive: true });
      fs.copyFileSync(skill.selection.path, path.join(directory, "SKILL.md"));
      for (const name of fs.readdirSync(skill.directory)) {
        if (["SKILL.md", "BASE.md", "variants"].includes(name)) continue;
        const source = path.join(skill.directory, name);
        const destination = path.join(directory, name);
        // Scripts resolve their dependencies from the source checkout.
        if (name === "scripts") fs.symlinkSync(source, destination);
        else fs.cpSync(source, destination, { recursive: true, dereference: true });
      }
      fs.writeFileSync(path.join(directory, skillMarker), marker, { flag: "wx" });
    }
    const { changes, retired } = inspect();
    createdSkillsDirectory = fs.mkdirSync(skillsDirectory, { recursive: true }) !== undefined;
    const backUp = (destination) => {
      const saved = path.join(backup, path.basename(destination));
      fs.renameSync(destination, saved);
      backedUp.push({ destination, saved });
    };
    for (const destination of retired) backUp(destination);
    for (const { destination, skill, exists } of changes) {
      if (exists) backUp(destination);
      const prepared = path.join(staged, skill.name);
      fs.renameSync(prepared, destination);
      published.push({ destination, prepared });
    }
    result = { linksChanged: changes.length, linksRetired: retired.length };
  } catch (error) {
    try {
      for (const { destination, prepared } of published.reverse()) fs.renameSync(destination, prepared);
      for (const { destination, saved } of backedUp.reverse()) fs.renameSync(saved, destination);
      if (createdSkillsDirectory) fs.rmdirSync(skillsDirectory);
      fs.rmSync(transaction, { recursive: true });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Could not finish rolling back the skill installation. Check ${transaction}`);
    }
    throw error;
  }
  try {
    fs.rmSync(transaction, { recursive: true });
  } catch {
    result.skillCleanupWarning = `Installed skills. Old skill backup remains at ${transaction}`;
  }
  return result;
}

export function installSkills({ harness, model, root, sourceRoot = sourceDefault, previousSourceRoot, requireExact = false, sessionId, dryRun = false, skillNames, onlySkillNames, binDir = path.join(os.homedir(), ".local", "bin"), nodeBin }) {
  const defaultRoot = harnessDirectory(harness);
  const harnessRoot = path.resolve(root ?? defaultRoot);
  // Gemini CLI's aliases and Cursor's Auto router install the model-neutral shared prompts.
  const neutralAliases = { gemini: ["auto", "pro", "flash", "flash-lite"], cursor: ["auto"] }[harness] ?? [];
  const profileModel = neutralAliases.includes(model.toLowerCase()) ? "gemini" : model;
  const plan = planSkillVariants({ sourceRoot, model: profileModel, requireExact, skillNames, onlySkillNames });
  const family = plan.profile.family;
  const compatible = {
    codex: family === "openai-gpt",
    claude: family.startsWith("anthropic-"),
    gemini: family === "google-gemini",
    antigravity: family === "google-gemini",
    // Cursor offers Claude, GPT and Gemini models, so every profile applies.
    cursor: true,
  };
  if (!compatible[harness]) throw new Error(`${model} is not a supported ${harness} model`);
  const skillsDirectory = path.join(harnessRoot, "skills");
  const viewRoot = path.join(harnessRoot, ".skill-variants", "jesse-merhi-skills");
  const antigravity = harness === "antigravity";
  const preflight = antigravity
    ? () => inspectAntigravitySkills(skillsDirectory, viewRoot, plan, previousSourceRoot, skillNames !== undefined)
    : () => {
      assertManagedOutput(viewRoot, plan.sourceRoot, previousSourceRoot);
      assertTargetedView(viewRoot, plan.sourceRoot, plan.profile.id, skillNames);
      const { links, retired } = inspectLinks(skillsDirectory, viewRoot, plan.skills, plan.sourceRoot, previousSourceRoot, skillNames !== undefined);
      return { changes: links, retired };
    };
  const preview = preflight();
  const globalRule = harness === "cursor" ? cursorRulePath(harnessRoot) : undefined;
  const commandOptions = {
    binDir, nodeBin, sourceRoot: plan.sourceRoot, previousSourceRoot, skills: plan.skills, skillNames,
    preserveOtherCommands: onlySkillNames !== undefined,
  };
  if (dryRun) {
    const commandPreview = planCommands(commandOptions);
    return {
      dryRun: true, harness, root: harnessRoot, model, profile: plan.profile.id,
      exact: plan.exact, skillCount: plan.skills.length,
      linksToChange: preview.changes.length, linksToRetire: preview.retired.length,
      ...commandSummary(commandPreview), globalRule,
    };
  }
  return withHarnessInstallationLock(harnessRoot, () => withInstalledCommands(commandOptions, () => {
    if (antigravity) {
      return {
        ...publishAntigravitySkills(skillsDirectory, plan, preflight),
        exact: plan.exact, model, profile: plan.profile.id, skillCount: plan.skills.length,
        harness, root: harnessRoot, viewRoot: skillsDirectory, globalRule,
      };
    }
    const { changes: links, retired } = preflight();
    // Write the rule before publishing skills: nothing may fail after the view is published.
    if (globalRule !== undefined) writeCursorRule(globalRule, fs.readFileSync(path.join(plan.sourceRoot, "..", "AGENTS.md"), "utf8"));
    fs.mkdirSync(skillsDirectory, { recursive: true });
    const changed = [];
    try {
      // Prepare stable links first; a failed view publication restores their old targets.
      for (const link of links) {
        const temporary = `${link.destination}.install-${crypto.randomUUID()}`;
        try {
          fs.symlinkSync(link.expected, temporary, "dir");
          fs.renameSync(temporary, link.destination);
          changed.push(link);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      }
      for (const destination of retired) {
        const original = fs.readlinkSync(destination);
        fs.unlinkSync(destination);
        changed.push({ destination, original, removed: true });
      }
      const result = materializeSkillVariants({
        sourceRoot: plan.sourceRoot, outputRoot: viewRoot, model: profileModel, previousSourceRoot, requireExact, skillNames, onlySkillNames,
        sessionId: sessionId ?? process.env.CODEX_THREAD_ID ?? process.env.CLAUDE_SESSION_ID,
      });
      return { ...result, model, harness, root: harnessRoot, viewRoot, globalRule, linksChanged: links.length, linksRetired: retired.length };
    } catch (error) {
      for (const link of changed.reverse()) {
        if (!link.removed) fs.unlinkSync(link.destination);
        if (link.original !== undefined) fs.symlinkSync(link.original, link.destination, "dir");
      }
      throw error;
    }
  }));
}

export function runInstaller() {
  const command = Command.make("install-skills", {
    harness: Flag.choice("harness", ["codex", "claude", "gemini", "antigravity", "cursor"]),
    model: Flag.string("model").pipe(Flag.withDescription("astra, sol, luna, fable, opus, gemini, or a full model ID. For Cursor, auto installs model-neutral prompts")),
    root: Flag.string("root").pipe(Flag.optional, Flag.withDescription("Configuration root containing skills/. Defaults: CODEX_HOME or ~/.codex, CLAUDE_CONFIG_DIR or ~/.claude, GEMINI_CLI_HOME/.gemini or ~/.gemini for Gemini CLI, ~/.gemini/config for Antigravity, and ~/.cursor for Cursor.")),
    binDir: Flag.string("bin-dir").pipe(Flag.optional, Flag.withDescription("Shared command directory; defaults to ~/.local/bin, independently of --root")),
    nodeBin: Flag.string("node-bin").pipe(Flag.optional, Flag.withDescription("Node executable path to embed in installed command launchers")),
    previousSource: Flag.string("previous-source").pipe(Flag.optional),
    session: Flag.string("session").pipe(Flag.optional),
    skills: Flag.string("skill").pipe(Flag.atLeast(0), Flag.withDescription("Update only these skills; repeat for multiple names. Requires the same installed profile and source.")),
    onlySkills: Flag.string("only").pipe(Flag.atLeast(0), Flag.withDescription("Install a managed view containing only these skills. Repeat for multiple names. Incompatible with --skill.")),
    requireExact: Flag.boolean("require-exact").pipe(Flag.withDescription("Refuse fallback if the model or any skill lacks an exact variant")),
    dryRun: Flag.boolean("dry-run"),
    json: Flag.boolean("json"),
  }, Effect.fn(function* (options) {
    const result = yield* Effect.try(() => installSkills({
      harness: options.harness, model: options.model,
      root: Option.getOrUndefined(options.root), previousSourceRoot: Option.getOrUndefined(options.previousSource),
      binDir: Option.getOrUndefined(options.binDir), nodeBin: Option.getOrUndefined(options.nodeBin),
      sessionId: Option.getOrUndefined(options.session), requireExact: options.requireExact, dryRun: options.dryRun,
      skillNames: options.skills.length === 0 ? undefined : options.skills,
      onlySkillNames: options.onlySkills.length === 0 ? undefined : options.onlySkills,
    }));
    if (options.json) return yield* Console.log(JSON.stringify(result));
    yield* Console.log(`${options.dryRun ? "Would install" : "Installed"} ${result.skillCount} skills for ${result.harness}: ${result.profile}\nRoot: ${result.root}`);
    yield* Console.log(`Commands: ${result.commands.length} in ${result.binDir} (${result.commandsChanged} changed, ${result.commandsRetired} retired)`);
    if (!(process.env.PATH ?? "").split(path.delimiter).some(directory => path.resolve(directory) === result.binDir)) yield* Console.log(`Command directory is not on PATH: ${result.binDir}. No shell configuration was changed.`);
    if (result.commandCleanupWarning !== undefined) yield* Console.log(result.commandCleanupWarning);
    if (result.skillCleanupWarning !== undefined) yield* Console.log(result.skillCleanupWarning);
    if (result.globalRule !== undefined) yield* Console.log(`Global instructions${options.dryRun ? " (would overwrite)" : ""}: ${result.globalRule}`);
    if (result.notice !== undefined) yield* Console.log(result.notice);
    if (!options.dryRun) yield* Console.log("This changes skills for sessions using this root, not the harness model. Already-loaded prompts remain in conversation history; start a fresh session for a clean switch.");
  })).pipe(Command.withDescription("Install this repository's skills for the selected harness and model. Gemini and Cursor's auto use shared prompts."));
  command.pipe(Command.run({ version: "1.0.0" }), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
