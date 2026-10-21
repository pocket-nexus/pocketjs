#!/usr/bin/env bun
// @pocketjs/cli — the PocketJS toolchain CLI. Runs on Bun: the framework's
// compiler and host scripts are Bun programs, so the CLI is one too and
// launches them with its own executable. No dependencies.
//
//   pocket create <name> [--target T] [--framework F]
//                            scaffold an app: apps/<name> inside a checkout, a
//                            standalone project anywhere else
//   pocket [+<id>] check|compile|build [+<id>] [--target <id|module>] [...args]
//                            select a target, resolve pocket.json once, build from its plan
//   pocket show [--json]     framework, project, selected target and the catalog
//                            with each target's install state
//   pocket target add [<id> …] | list [--check] [--json] | remove <id> …
//                            install the toolchains the framework pins
//   pocket play vita <demo> build, install and launch a demo in Vita3K
//   pocket dev|psp|vita|hw|psplink|devtools|tape [...args]
//                            low-level passthrough to the checkout's bun scripts
//
// The CLI holds no toolchain pins: the framework it resolves carries the target
// catalog and the toolchain manifests.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import { CREATE_USAGE, CreateUsageError, create, pocketCommands } from "./create.mjs";
import { CLI_PROTOCOL, protocolMismatch, resolveFramework } from "./framework.mjs";
import { select, takeExplicitSelection } from "./select.mjs";

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
  const { name, target, framework, manifestPath } = result;
  if (result.standalone) {
    const commands = pocketCommands({ name, target });
    console.log(C.ok(`${relative(process.cwd(), result.directory) || "."}/ scaffolded (${framework}, ${target})`));
    console.log(C.dim(`  cd ${relative(process.cwd(), result.directory)}`));
    console.log(C.dim("  bun install"));
    console.log(C.dim(`  bun run check     # ${commands.check}`));
    console.log(C.dim(`  bun run build     # ${commands.build}`));
    return;
  }
  const manifest = `apps/${name}/${manifestPath}`;
  const commands = pocketCommands({
    name,
    target,
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

/** Ask the framework to find the config above the selected manifest. */
function projectFor(framework, manifest, config) {
  const result = frameworkQuery(framework, ["project", ...(manifest ? ["--manifest", manifest] : []), ...(config ? ["--runtime-config", config] : [])]);
  if (!result.ok) fail(result.diagnostics.join("\n"));
  return result.project;
}

function runVerb(framework, cmd, selection, project, args) {
  if (selection) console.error(C.dim(`pocket: target ${selection.id} · ${selection.origin}`));
  const selected = selection ? ["--target", selection.id] : [];
  if (selection?.source === "project" && project.config && optionValue(args, "runtime-config") === undefined && optionValue(args, "config") === undefined) selected.push("--runtime-config", project.config);
  const result = spawnSync(process.execPath, [join(framework.root, "tools/pocket.ts"), cmd, ...selected,
    "--cli-protocol", String(CLI_PROTOCOL), ...args], { stdio: "inherit", cwd: process.cwd() });
  return result.status ?? 1;
}

/** `pocket target …`: the framework installs its own pins. */
function targetCommand(args, command = "target") {
  const framework = requireFramework();
  const result = spawnSync(
    process.execPath,
    [join(framework.root, "tools/pocket.ts"), command, ...args, "--cli-protocol", String(CLI_PROTOCOL)],
    { stdio: "inherit", cwd: process.cwd() },
  );
  process.exit(result.status ?? 1);
}

function verb(cmd, args, leading) {
  const framework = requireFramework();
  const taken = takeExplicitSelection(args, leading);
  if (taken.error) fail(taken.error);
  if (taken.args.includes("--all")) fail("--all is not supported; enumerate profiles in scripts or CI");
  if (taken.args.some(arg => arg === "--host-profile" || arg.startsWith("--host-profile="))) fail("--host-profile was replaced by profile modules and --runtime-config");
  const config = optionValue(taken.args, "runtime-config") ?? optionValue(taken.args, "config");
  const project = !taken.explicit && !process.env.POCKET_TARGET?.trim()
    ? projectFor(framework, optionValue(taken.args, "manifest"), config)
    : { config: null, profiles: [], build: false };
  const selection = select({ explicit: taken.explicit, project });
  process.exit(runVerb(framework, cmd, selection, project, taken.args));
}

function currentHostId() {
  const os = platform() === "darwin" ? "darwin" : platform() === "linux" ? "linux" : null;
  const cpu = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

function show(args, leading) {
  const json = args.includes("--json");
  const resolved = resolveFramework();
  const problem = resolved.error ?? protocolMismatch(resolved, cliVersion());
  const host = currentHostId();
  const manifest = optionValue(args, "manifest");
  const config = optionValue(args, "runtime-config");
  const project = problem ? null : projectFor(resolved, manifest, config);
  const status = problem ? [] : frameworkQuery(resolved, ["status", "--json", ...(manifest ? ["--manifest", manifest] : []), ...(config ? ["--runtime-config", config] : [])]);
  const explicit = leading ? { id: leading, origin: `+${leading}` } : null;
  const selection = select({ explicit, project });
  const report = {
    framework: problem
      ? { error: problem }
      : { name: resolved.name, version: resolved.version, root: resolved.root, source: resolved.source, origin: resolved.origin, protocol: resolved.protocol },
    project: project ?? null,
    selection,
    host: host ?? `${platform()}-${process.arch} (unsupported)`,
    targets: status,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const row = (label, value) => console.log(`${label.padEnd(11)} ${value}`);
  row("framework", problem ? C.bad(problem) : `${resolved.name ?? "@pocketjs/framework"} ${resolved.version ?? ""}   ${resolved.origin} ${resolved.root}`);
  row("project", project?.config
    ? `${project.config}${project.profiles.length ? `   (profiles: ${project.profiles.map((target) => target.id).join(", ")})` : "   (no profiles)"}`
    : "no pocket.runtime-config.ts");
  row("target", selection ? `${selection.id}   ${selection.origin}` : C.dim("none — --target, POCKET_TARGET or pocket.runtime-config.ts"));
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
const SELECTING = new Set(["check", "compile", "build", "pack", "show"]);
if (leading !== undefined && !SELECTING.has(cmd)) fail(`+${leading} selects a target for check, compile, build, pack or show`);
const HELP = `${C.bold("pocket")} — PocketJS applications and runtimes

  pocket create <name> [--target ID]
  pocket [+id] check|compile [--manifest pocket.json] [--target ID|MODULE]
      --runtime-config FILE  choose the program configuration
      --output FILE          compile a .pocket package
      --aot --out DIR        compile native guest sources
      --depfile FILE         emit build dependencies
  pocket build [--config FILE] [--target ID] [--out DIR]
      --pocket FILE          consume a compiled application
      --aot-dir DIR          consume generated AOT sources
      --generic              build a reusable runtime
      --deploy               deploy the resulting artifact
  pocket pack [--config FILE] [--target ID] --pocket FILE [--runtime DIR] [--out FILE]
  pocket profile export [--config FILE] [--target ID] --out DIR [--depfile FILE]
  pocket show [--json]       profile selection and toolchain status
  pocket target add [ID…] | list [--check] [--json] | remove ID…
  pocket sdk export         export a relocatable C SDK
  pocket dev|psp|vita|hw|psplink|devtools|tape|play [...args]
  pocket --version
`;

switch (cmd) {
  case "create":
    scaffold(rest);
    break;
  case "check":
  case "compile":
  case "build":
  case "pack":
    verb(cmd, rest, leading);
    break;
  case "show":
    show(rest, leading);
    break;
  case "target":
    targetCommand(rest);
    break;
  case "sdk":
    targetCommand(rest, "sdk");
    break;
  case "profile":
    targetCommand(rest, "profile");
    break;
  case "dev":
  case "psp":
  case "vita":
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
