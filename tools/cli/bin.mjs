#!/usr/bin/env bun
// @pocketjs/cli — the PocketJS toolchain CLI. Runs on Bun: the framework's
// compiler and host scripts are Bun programs, so the CLI is one too and
// launches them with its own executable. No dependencies.
//
//   pocket create <name> [--target T] [--framework F] [--host-profile FILE]
//                            scaffold an app: apps/<name> inside a checkout, a
//                            standalone project anywhere else
//   pocket [+<id>] check|compile|build [+<id>] [--target <id> | --host-profile FILE] [...args]
//                            select a target, resolve pocket.json once, build from its plan
//   pocket show [--json]     framework, project, selected target and the catalog
//                            with each target's install state
//   pocket target add [<id> …] | list [--check] [--json] | remove <id> …
//                            install the toolchains the framework pins
//   pocket default [<id> | --unset]
//   pocket override set <id> [--path DIR] | unset [--path DIR] | list
//   pocket play vita <demo> build, install and launch a demo in Vita3K
//   pocket play ios <demo>  build, stage and launch a demo on the iOS simulator
//   pocket dev|psp|vita|hw|psplink|devtools|tape [...args]
//                            low-level passthrough to the checkout's bun scripts
//   pocket symbian <cmd>      Nokia E7 toolchain doctor/setup/build/deploy
//   pocket ios <cmd>          Apple iOS doctor/setup/build/play on the simulator
//
// The CLI holds no toolchain pins: the framework it resolves carries the target
// catalog and the toolchain manifests.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import { CREATE_USAGE, CreateUsageError, create, pocketCommands } from "./create.mjs";
import { CLI_PROTOCOL, protocolMismatch, resolveFramework } from "./framework.mjs";
import {
  NO_SELECTION,
  overrideFor,
  readSettings,
  select,
  settingsPath,
  takeExplicitSelection,
  writeSettings,
} from "./select.mjs";

if (typeof Bun === "undefined") {
  console.error(
    "pocket runs on Bun: install it from https://bun.sh and run `pocket` again, or use `bunx @pocketjs/cli`.",
  );
  process.exit(1);
}

const C = {
  ok: (s) => `\x1b[32m✓\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m✗\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m!\x1b[0m ${s}`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const cliVersion = () => JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// ---------------------------------------------------------------------------
// Framework: tools/cli/framework.mjs resolves it
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(C.bad(message));
  process.exit(1);
}

/** The framework for this directory after the protocol check; exits on either error. */
function requireFramework() {
  const framework = resolveFramework();
  if (framework.error) fail(framework.error);
  const mismatch = protocolMismatch(framework, cliVersion());
  if (mismatch) fail(mismatch);
  return framework;
}

/** The framework root when it is a source checkout or POCKETJS_FRAMEWORK_ROOT;
 *  host-development commands run the checkout's scripts. */
function checkoutRoot() {
  const framework = resolveFramework();
  return !framework.error && (framework.source === "checkout" || framework.source === "env") ? framework.root : null;
}

// ---------------------------------------------------------------------------
// create — tools/cli/create.mjs writes the files; this prints what to run next
// ---------------------------------------------------------------------------

function scaffold(args) {
  const resolved = resolveFramework();
  let result;
  try {
    result = create(args, {
      checkoutRoot: !resolved.error && resolved.source === "checkout" ? resolved.root : null,
      cliVersion: cliVersion(),
    });
  } catch (error) {
    if (!(error instanceof CreateUsageError)) throw error;
    console.error(C.bad(error.message));
    console.error(C.dim(CREATE_USAGE));
    process.exit(1);
  }
  const { name, target, framework, hostProfilePath } = result;
  if (result.standalone) {
    const commands = pocketCommands({ name, target, hostProfilePath });
    console.log(C.ok(`${relative(process.cwd(), result.directory) || "."}/ scaffolded (${framework}, ${target})`));
    console.log(C.dim(`  cd ${relative(process.cwd(), result.directory)}`));
    console.log(C.dim("  bun install"));
    console.log(C.dim(`  bun run check     # ${commands.check}`));
    console.log(C.dim(`  bun run build     # ${commands.build}`));
    return;
  }
  const manifest = `apps/${name}/pocket.json`;
  const commands = pocketCommands({
    name,
    target,
    hostProfilePath: hostProfilePath && posix.normalize(`apps/${name}/${hostProfilePath}`),
    manifest,
  });
  console.log(C.ok(`apps/${name} scaffolded (${framework}, ${target})`));
  console.log(C.dim(`  ${commands.check}`));
  console.log(C.dim(`  ${commands.build}`));
}

// ---------------------------------------------------------------------------
// passthrough
// ---------------------------------------------------------------------------

const SCRIPTS = {
  dev: "tools/dev.ts",
  psp: "tools/psp.ts",
  vita: "tools/vita.ts",
  symbian: "tools/symbian.ts",
  ios: "tools/ios.ts",
  hw: "tools/hw.ts",
  psplink: "tools/psplink.ts",
  devtools: "tools/devtools.ts",
  tape: "tools/tape.ts",
  play: "tools/play.ts",
};

// ---------------------------------------------------------------------------
// verbs — select the target (tools/cli/select.mjs), then run tools/pocket.ts
// ---------------------------------------------------------------------------

/** The value of `--<name>` before `--`, or undefined. */
function optionValue(args, name) {
  const separator = args.indexOf("--");
  const before = separator >= 0 ? args.slice(0, separator) : args;
  const inline = before.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = before.indexOf(`--${name}`);
  return index >= 0 ? before[index + 1] : undefined;
}

/** A query of tools/pocket.ts that prints JSON. */
function frameworkQuery(framework, args) {
  const result = spawnSync(process.execPath, [join(framework.root, "tools/pocket.ts"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`tools/pocket.ts ${args[0]} failed:\n${result.stderr || result.stdout}`);
  }
}

/** The project configuration for the manifest the command names. */
function projectFor(framework, manifest) {
  const result = frameworkQuery(framework, ["project", ...(manifest ? ["--manifest", manifest] : [])]);
  if (!result.ok) fail(result.diagnostics.join("\n"));
  return result.project;
}

/** tools/pocket.ts arguments for a selection: a catalog id, or a host profile;
 *  a project entry's manifest applies unless the command names one. */
function selectionArgs(selection, project, args) {
  if (selection.hostProfile) return ["--host-profile", selection.hostProfile];
  const entry = project.targets.find((target) => target.id === selection.id);
  const manifest = entry?.manifest && optionValue(args, "manifest") === undefined ? ["--manifest", entry.manifest] : [];
  if (entry?.hostProfile) return ["--host-profile", entry.hostProfile, ...manifest];
  return ["--target", selection.id, ...manifest];
}

function runVerb(framework, cmd, selection, project, args) {
  console.error(C.dim(`pocket: target ${selection.id ?? selection.hostProfile} · ${selection.origin}`));
  const result = spawnSync(
    process.execPath,
    [
      join(framework.root, "tools/pocket.ts"),
      cmd,
      ...selectionArgs(selection, project, args),
      "--cli-protocol",
      String(CLI_PROTOCOL),
      ...args,
    ],
    { stdio: "inherit", cwd: process.cwd() },
  );
  return result.status ?? 1;
}

/** `pocket target …`: the framework installs its own pins. */
function targetCommand(args) {
  const framework = requireFramework();
  const result = spawnSync(
    process.execPath,
    [join(framework.root, "tools/pocket.ts"), "target", ...args, "--cli-protocol", String(CLI_PROTOCOL)],
    { stdio: "inherit", cwd: process.cwd() },
  );
  process.exit(result.status ?? 1);
}

function verb(cmd, args, leading) {
  const framework = requireFramework();
  const taken = takeExplicitSelection(args, leading);
  if (taken.error) fail(taken.error);
  let rest = taken.args;
  const separator = rest.indexOf("--");
  const allIndex = rest.indexOf("--all");
  const all = allIndex >= 0 && (separator < 0 || allIndex < separator);
  if (all) {
    if (cmd !== "build") fail("--all applies to `pocket build`");
    if (taken.explicit) fail("--all builds the targets of pocket.config.ts; drop the explicit target");
    rest = rest.filter((_, index) => index !== allIndex);
  }
  const project = projectFor(framework, optionValue(rest, "manifest"));
  if (all) {
    if (project.targets.length === 0) {
      fail(`--all builds the targets of pocket.config.ts, and ${project.config ?? "no pocket.config.ts"} lists none`);
    }
    for (const target of project.targets) {
      const status = runVerb(framework, cmd, { id: target.id, source: "project", origin: project.config }, project, rest);
      if (status !== 0) process.exit(status);
    }
    process.exit(0);
  }
  const selection = select({ explicit: taken.explicit, settings: readSettings(), project });
  if (!selection) fail(NO_SELECTION);
  process.exit(runVerb(framework, cmd, selection, project, rest));
}

// ---------------------------------------------------------------------------
// show, default, override
// ---------------------------------------------------------------------------

function currentHostId() {
  const os = platform() === "darwin" ? "darwin" : platform() === "linux" ? "linux" : null;
  const cpu = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

function show(args, leading) {
  const json = args.includes("--json");
  const resolved = resolveFramework();
  const problem = resolved.error ?? protocolMismatch(resolved, cliVersion());
  const settings = readSettings();
  const host = currentHostId();
  const project = problem ? null : projectFor(resolved, optionValue(args, "manifest"));
  const status = problem ? [] : frameworkQuery(resolved, ["status", "--json"]);
  const explicit = leading ? { id: leading, origin: `+${leading}` } : null;
  const selection = select({ explicit, settings, project });
  const report = {
    framework: problem
      ? { error: problem }
      : { name: resolved.name, version: resolved.version, root: resolved.root, source: resolved.source, origin: resolved.origin, protocol: resolved.protocol },
    project: project ?? null,
    selection,
    host: host ?? `${platform()}-${process.arch} (unsupported)`,
    settings: settingsPath(),
    targets: status,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const row = (label, value) => console.log(`${label.padEnd(11)} ${value}`);
  row("framework", problem ? C.bad(problem) : `${resolved.name ?? "@pocketjs/framework"} ${resolved.version ?? ""}   ${resolved.origin} ${resolved.root}`);
  row("project", project?.config
    ? `${project.config}${project.targets.length ? `   (targets: ${project.targets.map((target) => target.id).join(", ")})` : "   (no targets)"}`
    : "no pocket.config.ts");
  row("target", selection ? `${selection.id ?? selection.hostProfile}   ${selection.origin}` : C.dim("none — `pocket default <id>`, `pocket override set <id>`, or `targets` in pocket.config.ts"));
  row("host", report.host);
  if (report.targets.length === 0) return;
  console.log("\ntargets for this framework");
  for (const target of report.targets) {
    const marker = target.id === selection?.id ? "*" : " ";
    // Bold marks the states `pocket target add` changes.
    const actionable = target.state === "not installed" || target.state === "outdated" || target.state === "broken";
    const state = actionable ? C.bold(target.state) : target.state;
    console.log(` ${marker} ${target.id.padEnd(20)} ${state}${" ".repeat(Math.max(1, 19 - target.state.length))}${C.dim(target.detail)}`);
  }
}

/** Fails unless `id` names a catalog target or a host profile of this project; skipped without a framework. */
function requireKnownTarget(id) {
  const resolved = resolveFramework();
  if (resolved.error || protocolMismatch(resolved, cliVersion())) return;
  const catalog = frameworkQuery(resolved, ["catalog", "--json"]);
  if (catalog.some((target) => target.id === id)) return;
  const project = projectFor(resolved, undefined);
  if (project.targets.some((target) => target.id === id)) return;
  fail(`unknown target ${id}; targets: ${catalog.map((target) => target.id).join(", ")}`);
}

function defaultCommand(args) {
  const settings = readSettings();
  if (args.length === 0) {
    console.log(settings.default ?? "no user default");
    return;
  }
  if (args[0] === "--unset") {
    delete settings.default;
    writeSettings(settings);
    console.log(C.ok("user default removed"));
    return;
  }
  requireKnownTarget(args[0]);
  writeSettings({ ...settings, default: args[0] });
  console.log(C.ok(`user default: ${args[0]}`));
}

function overrideCommand(args) {
  const [action, ...rest] = args;
  const settings = readSettings();
  // Real paths: the current directory a later command compares against is one.
  const requested = resolve(optionValue(rest, "path") ?? process.cwd());
  const path = existsSync(requested) ? realpathSync(requested) : requested;
  switch (action) {
    case "set": {
      const id = rest.find((value, index) => !value.startsWith("--") && rest[index - 1] !== "--path");
      if (!id) fail("usage: pocket override set <id> [--path DIR]");
      requireKnownTarget(id);
      writeSettings({ ...settings, overrides: { ...settings.overrides, [path]: id } });
      console.log(C.ok(`override: ${path} → ${id}`));
      return;
    }
    case "unset": {
      if (!(path in settings.overrides)) fail(`no override for ${path}`);
      const { [path]: _removed, ...overrides } = settings.overrides;
      writeSettings({ ...settings, overrides });
      console.log(C.ok(`override removed: ${path}`));
      return;
    }
    case "list": {
      const entries = Object.entries(settings.overrides);
      if (entries.length === 0) console.log("no overrides");
      for (const [directory, id] of entries) console.log(`${directory}  ${id}`);
      const active = overrideFor(process.cwd(), settings);
      if (active) console.log(C.dim(`active here: ${active.directory} → ${active.id}`));
      return;
    }
    default:
      fail("usage: pocket override set <id> [--path DIR] | unset [--path DIR] | list");
  }
}

function passthrough(cmd, args) {
  passthroughScript(cmd, SCRIPTS[cmd], args);
}

function passthroughScript(cmd, script, args) {
  const root = checkoutRoot();
  if (!root) {
    console.error(C.bad(`\`pocket ${cmd}\` must run inside a PocketJS checkout`));
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [join(root, script), ...args], { stdio: "inherit", cwd: root });
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const argvAfterPocket = process.argv.slice(2);
// `pocket +<id> <command>`: a leading selection, as `cargo +<toolchain>`.
const leading = argvAfterPocket[0]?.startsWith("+") ? argvAfterPocket.shift().slice(1) : undefined;
const [cmd, ...rest] = argvAfterPocket;
const SELECTING = new Set(["check", "compile", "build", "show"]);
if (leading !== undefined && !SELECTING.has(cmd)) fail(`+${leading} selects a target for check, compile, build or show`);
const HELP = `${C.bold("pocket")} — the PocketJS toolchain CLI (runs on Bun)

  pocket create <name>     scaffold a pocket.json v2 app: apps/<name> inside a
                           checkout, a standalone project anywhere else
      --target T           psp (default) | vita | pocketbook | web-app |
                           macos-app | linux-app | esp-idf
      --framework F        solid (default) | vue-vapor | octane
      --host-profile FILE  derive the manifest from an ESP-IDF host profile
  pocket [+id] check       validate pocket.json, target APIs and app types
  pocket [+id] compile     check + emit JS/pak from one resolved build plan
  pocket [+id] build       check + compile + package the target's artifacts
      --target ID          the same as +ID
      --host-profile FILE  an ESP-IDF product host
      --all                (build) every target of pocket.config.ts
  pocket show [--json]     framework, project, selected target and why, and
                           the install state of every target
  pocket target add [ID …] install the toolchains the framework pins; with no
                           ID, the targets of pocket.config.ts
  pocket target list [--check] [--json]
                           install states; --check exits 1 unless every
                           target of pocket.config.ts is ready to build
  pocket target remove ID …
                           delete the install records and prune the store
  pocket default [ID | --unset]
                           the user default target
  pocket override set ID [--path DIR] | unset [--path DIR] | list
                           a target for a directory and everything below it
  pocket play vita <app>   build, install and launch a demo in Vita3K
  pocket play ios <app>    build, stage and launch a demo on the iOS simulator
  pocket dev <app>-main    build + serve an app in the browser
  pocket psp <app>         build the PSP EBOOT
  pocket vita <app>        build the PS Vita VPK
  pocket symbian <cmd>      Nokia E7 doctor/setup/build-probe/deploy
  pocket ios <cmd>         Apple iOS doctor/setup/build/play on the simulator
  pocket hw <app>          build + run on a real PSP over PSPLINK
  pocket psplink           interactive multi-app switcher on a real PSP
  pocket devtools [app]    DevTools panel + USB debug bridge (one command)
  pocket tape <cmd> …      record / replay / inspect input tapes headlessly
`;

switch (cmd) {
  case "create":
    scaffold(rest);
    break;
  case "check":
  case "compile":
  case "build":
    verb(cmd, rest, leading);
    break;
  case "show":
    show(rest, leading);
    break;
  case "target":
    targetCommand(rest);
    break;
  case "default":
    defaultCommand(rest);
    break;
  case "override":
    overrideCommand(rest);
    break;
  case "dev":
  case "psp":
  case "vita":
  case "symbian":
  case "ios":
  case "hw":
  case "psplink":
  case "devtools":
  case "tape":
  case "play":
    passthrough(cmd, rest);
    break;
  case "--version":
  case "-v": {
    console.log(cliVersion());
    const framework = resolveFramework();
    if (!framework.error) {
      console.log(C.dim(`${framework.name ?? "@pocketjs/framework"} ${framework.version ?? "(unversioned)"} (${framework.origin} ${framework.root})`));
    }
    break;
  }
  default:
    console.log(HELP);
    process.exitCode = cmd && cmd !== "--help" && cmd !== "help" ? 1 : 0;
}
