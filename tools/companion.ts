#!/usr/bin/env bun

// Pocket Companion — the computer side of Pocket Link (docs/POCKET-LINK.md).
//
//   bun tools/companion.ts serve [--apps <dir>]... [--name <n>] [--port <p>]
//                                [--allow-private] [--store <dir>] [--unicast <ip>]...
//                                [--no-agent] [--agent-model <id>] [--agent-effort <level>]
//   bun tools/companion.ts pair [--wait]     open a pairing window, print the QR code
//   bun tools/companion.ts status [--json]
//   bun tools/companion.ts forget <console id>
//   bun tools/companion.ts apps-dir <path>
//
// `serve` runs the daemon: the link listener (TCP 8628), the beacon (UDP 8627),
// the console agent (docs/POCKET-AGENT.md) and the local control API the
// other commands and the menu-bar app use.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LINK_PORT } from "../contracts/spec/link.ts";
import { controlRequest, readControl, startControl, type ControlInfo } from "./companion/control.ts";
import { adoptSystemProxy } from "./companion/fetch.ts";
import { encodeQr, renderQrTerminal } from "./companion/qr.ts";
import { OWN_SCREEN_SCRIPT } from "./companion/own-screen.ts";
import { Companion } from "./companion/server.ts";
import { CompanionStore, defaultStoreDir } from "./companion/store.ts";

const USAGE = `usage: bun tools/companion.ts <command>

  serve [--apps <dir>]... [--name <name>] [--port <port>] [--allow-private]
        [--store <dir>] [--unicast <ip>]... [--parent-pid <pid>]
        [--no-agent] [--agent-model <id>] [--agent-effort <level>]
  pair [--wait]          open a pairing window and print its QR code
  status [--json]        the running daemon's state
  forget <console id>    delete a console's key and close its link
  apps-dir <path>        set the apps folder the daemon offers

common: --store <dir>    store directory (default ${defaultStoreDir()})`;

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function log(line: string) {
  console.log(`${stamp()} ${line}`);
}

/** The repo's dist/3ds when this file runs from a checkout (not from a compiled binary). */
function repoAppsDir(): string | null {
  const root = resolve(dirname(import.meta.path), "..");
  return existsSync(join(root, "contracts", "spec", "link.ts")) ? join(root, "dist", "3ds") : null;
}

/** How the agent starts its own screen: this checkout's script, or the
 *  checkout an apps directory belongs to (the app bundle names the
 *  checkout's dist/3ds), run with Bun. Null when there is no checkout. */
function ownScreenCommand(appsDirs: string[]): string[] | null {
  if (existsSync(OWN_SCREEN_SCRIPT)) return [process.execPath, OWN_SCREEN_SCRIPT];
  const bun = Bun.which("bun") ?? [join(homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun"].find((path) => existsSync(path));
  if (!bun) return null;
  for (const dir of appsDirs) {
    const script = join(dir, "..", "..", "tools", "companion", "own-screen.ts");
    if (existsSync(script)) return [bun, script];
  }
  return null;
}

interface Args {
  command: string;
  positional: string[];
  apps: string[];
  unicast: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "", positional: [], apps: [], unicast: [], flags: new Map() };
  const valued = new Set(["--apps", "--name", "--port", "--store", "--unicast", "--parent-pid", "--agent-model", "--agent-effort"]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
      const value = valued.has(name) ? (inline ?? argv[++i]) : true;
      if (value === undefined) throw new Error(`${name} needs a value`);
      if (name === "--apps") args.apps.push(resolve(value as string));
      else if (name === "--unicast") args.unicast.push(value as string);
      else args.flags.set(name, value);
    } else args.positional.push(a);
  }
  return args;
}

function storeDir(args: Args): string {
  const flag = args.flags.get("--store");
  return typeof flag === "string" ? resolve(flag) : defaultStoreDir();
}

function requireDaemon(dir: string): ControlInfo {
  const info = readControl(dir);
  if (!info) {
    console.error(`no Pocket Companion daemon is running for ${dir}; start one with: bun tools/companion.ts serve`);
    process.exit(1);
  }
  return info;
}

async function serve(args: Args) {
  const dir = storeDir(args);
  const running = readControl(dir);
  if (running) {
    console.error(`a Pocket Companion daemon is already running (pid ${running.pid}) for ${dir}`);
    process.exit(1);
  }
  const proxy = adoptSystemProxy();
  const store = new CompanionStore(dir);
  const apps = args.apps.length ? args.apps : [repoAppsDir()].filter((d): d is string => !!d);
  const port = args.flags.get("--port");
  const name = args.flags.get("--name");
  const agentModel = args.flags.get("--agent-model");
  const agentEffort = args.flags.get("--agent-effort");
  const companion = new Companion({
    store,
    name: typeof name === "string" ? name : undefined,
    port: typeof port === "string" ? Number(port) : LINK_PORT,
    appsDirs: apps,
    allowPrivate: args.flags.has("--allow-private"),
    unicast: args.unicast,
    agent: args.flags.has("--no-agent")
      ? false
      : {
          model: typeof agentModel === "string" ? agentModel : undefined,
          effort: typeof agentEffort === "string" ? agentEffort : undefined,
          ownScreenCommand: ownScreenCommand(apps),
        },
    log,
  });
  await companion.start();
  const control = startControl(companion, dir);
  log(`control: 127.0.0.1:${control.info.port} (${join(dir, "control.json")})`);
  log(`catalog: ${companion.catalog.directories.join(", ")}`);
  if (proxy) log(`net: via proxy ${proxy}`);
  if (args.flags.has("--allow-private")) log("net: private destinations allowed");
  if (companion.agent?.available) log(`agent: codex${companion.agent.model ? ` model ${companion.agent.model}` : ""}, CODEX_HOME ${join(dir, "codex")}`);

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${reason}`);
    control.stop();
    await companion.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  const parent = args.flags.get("--parent-pid");
  if (typeof parent === "string") {
    const pid = Number(parent);
    setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        void stop(`parent ${pid} exited`);
      }
    }, 2_000);
  }
}

interface Status {
  companion: { id: string; name: string; port: number; addresses: string[]; allowPrivate: boolean };
  consoles: { id: string; name: string; model: string; target: string; address: string; since: number }[];
  paired: { id: string; name: string; model: string; lastAddress: string; lastSeen: number }[];
  apps: { id: string; title: string; version: string; bytes: number }[];
  appsDirs: string[];
  pairing: { open: boolean; uri?: string; expiresAt?: number };
}

async function pair(args: Args) {
  const info = requireDaemon(storeDir(args));
  const before = new Set((await controlRequest<Status>(info, "GET", "/status")).paired.map((p) => `${p.id}:${p.lastSeen}`));
  const { uri, expiresAt } = await controlRequest<{ uri: string; expiresAt: number }>(info, "POST", "/pair");
  const qr = encodeQr(uri);
  console.log(renderQrTerminal(qr));
  console.log(uri);
  console.log(`QR version ${qr.version}-M, ${Buffer.byteLength(uri)} bytes. On the 3DS: Pocket › Settings › Mac › Pair a Mac.`);
  console.log(`window open until ${new Date(expiresAt).toLocaleTimeString()}`);
  if (!args.flags.has("--wait")) return;
  for (;;) {
    await Bun.sleep(1_000);
    const status = await controlRequest<Status>(info, "GET", "/status");
    const fresh = status.paired.find((p) => !before.has(`${p.id}:${p.lastSeen}`));
    if (fresh) {
      console.log(`paired ${fresh.name || fresh.id} (${fresh.model} ${fresh.id}) from ${fresh.lastAddress}`);
      return;
    }
    if (!status.pairing.open) {
      console.error("pairing window closed");
      process.exit(1);
    }
  }
}

async function status(args: Args) {
  const info = requireDaemon(storeDir(args));
  const s = await controlRequest<Status>(info, "GET", "/status");
  if (args.flags.has("--json")) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  console.log(`${s.companion.name} (${s.companion.id}) port ${s.companion.port} on ${s.companion.addresses.join(", ") || "no LAN address"}, pid ${info.pid}`);
  console.log(`pairing: ${s.pairing.open ? `open until ${new Date(s.pairing.expiresAt!).toLocaleTimeString()}` : "closed"}`);
  console.log(`linked (${s.consoles.length}):`);
  for (const c of s.consoles) console.log(`  ${c.id}  ${c.name} (${c.model}, ${c.target}) ${c.address} since ${new Date(c.since).toLocaleTimeString()}`);
  console.log(`paired (${s.paired.length}):`);
  for (const p of s.paired) console.log(`  ${p.id}  ${p.name} (${p.model}) last ${p.lastAddress || "-"} ${p.lastSeen ? new Date(p.lastSeen).toLocaleString() : ""}`);
  console.log(`apps (${s.apps.length}) from ${s.appsDirs.join(", ")}:`);
  for (const a of s.apps) console.log(`  ${a.id}  ${a.title} ${a.version} ${a.bytes}B`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "serve":
      return serve(args);
    case "pair":
      return pair(args);
    case "status":
      return status(args);
    case "forget": {
      const id = args.positional[0];
      if (!id) throw new Error("forget needs a console id");
      const result = await controlRequest<{ removed: boolean }>(requireDaemon(storeDir(args)), "DELETE", `/consoles/${id}`).catch((e) => {
        console.error(`forget ${id}: ${(e as Error).message}`);
        process.exit(1);
      });
      console.log(result.removed ? `forgot ${id}` : `${id} was not paired`);
      return;
    }
    case "apps-dir": {
      const path = args.positional[0];
      if (!path) throw new Error("apps-dir needs a path");
      const result = await controlRequest<{ appsDir: string; apps: unknown[] }>(requireDaemon(storeDir(args)), "POST", "/apps-dir", { path: resolve(path) });
      console.log(`apps dir ${result.appsDir}: ${result.apps.length} apps`);
      return;
    }
    default:
      console.log(USAGE);
      process.exit(args.command && args.command !== "help" && args.command !== "--help" ? 1 : 0);
  }
}

main().catch((error) => {
  console.error(`companion: ${(error as Error).message}`);
  process.exit(1);
});
