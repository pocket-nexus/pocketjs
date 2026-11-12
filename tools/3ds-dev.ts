#!/usr/bin/env bun

// Nintendo 3DS development loop over Pocket Link 2 (docs/POCKET-LINK.md).
//
//   bun tools/3ds-dev.ts setup   --host 192.168.8.102     while ftpd runs on the 3DS, once
//   bun tools/3ds-dev.ts devices
//   bun tools/3ds-dev.ts push    --app 3ds-demo
//   bun tools/3ds-dev.ts install --app 3ds-demo
//   bun tools/3ds-dev.ts launch  pocket3ds-demo-main.3dsx
//   bun tools/3ds-dev.ts probe
//   bun tools/3ds-dev.ts dev     --app 3ds-demo
//
// This is the reference Hub's command line (tools/pocket-link/v2/cli.ts, also
// `bun run link2`) with what a 3DS checkout adds: `--app <name>` builds the
// guest or the .3dsx first, `probe` is a status and a screenshot, and `dev`
// stays linked with the Pocket DevTools panel and one key per step. Every
// other command and option goes to that command line unchanged.
//
// The 3DS dials this computer: `setup` writes this computer's pairing onto the
// card over ftpd (or `--card <dir>` onto the mounted card), and the program
// links by itself from then on. The spellings of the tool that spoke the
// development connection are accepted: `pair` is `setup`, `discover` is
// `devices`, `--package` and `--file` name the file to send.

import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXIT, main as link } from "./pocket-link/v2/cli.ts";
import { linkHome } from "./pocket-link/v2/store.ts";

const ROOT = new URL("..", import.meta.url).pathname;

const USAGE = `Nintendo 3DS development over Pocket Link 2

  setup --host <3ds-ip> [--ftp-port 5000]   pair, once, while ftpd runs on the 3DS (was: pair)
  setup --card <dir>                        the same onto the mounted SD card
  devices                                   the paired consoles (was: discover)
  push    [--app 3ds-demo | --package file.pocket]
  install [--app 3ds-demo | --file app.3dsx] [--name app.3dsx] [--no-launch]
  launch  <app.3dsx | applet id>
  probe   [--out screenshot.png]            runtime.status and one screenshot
  dev     [--app 3ds-demo] [--no-push] [--panel-port 8130]
                                            stay linked with the Pocket DevTools panel;
                                            keys: r rebuild+push, i install .3dsx+restart,
                                            s screenshot, o open the panel, q quit
  status · apps · remove · shot · eval · logs · serve · forget
                                            as \`bun run link2\` takes them

  --host <3ds-ip> on any command but setup adds that address as a beacon target
  (the console finds this computer by broadcast otherwise).

A console whose program was built before Pocket Link 2 does not link: it
listened on port 8131 for the development connection, which is gone. Put a
current .3dsx on its card (the Homebrew Launcher's folder is sdmc:/3ds/, by
ftpd or a card reader), run \`setup --host <3ds-ip>\`, then start that program.

Everything else: bun run link2 --help`;

/** Option values and flags of this tool's own, taken out of the arguments; the rest goes to the link's command line. */
function take(argv: string[], flag: string, hasValue: boolean): string | boolean | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return hasValue ? undefined : false;
  const taken = argv.splice(index, hasValue ? 2 : 1);
  if (hasValue && taken[1] === undefined) fail(`${flag} takes a value`);
  return hasValue ? taken[1] : true;
}

function fail(message: string): never {
  console.error(`3ds-dev: ${message}`);
  process.exit(EXIT.usage);
}

async function buildPackage(app: string): Promise<string> {
  const result = await $`bun tools/3ds.ts ${app} --pocket-only`.cwd(ROOT).quiet().nothrow();
  if (result.exitCode !== 0) throw new Error(`3DS guest build failed\n${result.stdout}${result.stderr}`);
  const path = [...`${result.stdout}\n${result.stderr}`.matchAll(/^output: (.+\.pocket) \(/gm)].at(-1)?.[1];
  if (!path || !existsSync(path)) throw new Error("3DS guest build did not report a .pocket output");
  return path;
}

async function buildNative(app: string): Promise<string> {
  const result = await $`bun tools/3ds.ts ${app}`.cwd(ROOT).quiet().nothrow();
  if (result.exitCode !== 0) throw new Error(`3DS build failed\n${result.stdout}${result.stderr}`);
  const path = [...`${result.stdout}\n${result.stderr}`.matchAll(/^output: (.+\.3dsx)$/gm)].at(-1)?.[1];
  if (!path || !existsSync(path)) throw new Error("3DS build did not report a .3dsx output");
  return path;
}

function existing(path: string, what: string): string {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`${what} does not exist: ${full}`);
  return full;
}

/** A console that never links is most often one whose program predates the link. */
function explain(code: number): number {
  if (code === EXIT.noDevice) {
    console.error(
      "3ds-dev: a program built before Pocket Link 2 never links (it waited on port 8131 for the development connection): " +
        "put a current .3dsx on the card, run `bun run 3ds:dev setup --host <3ds-ip>` while ftpd runs, then start it.",
    );
  }
  return code;
}

async function run(argv: string[]): Promise<number> {
  const command = argv.find((word) => !word.startsWith("--")) ?? "";
  const rest = argv.slice();
  if (command !== "") rest.splice(rest.indexOf(command), 1);
  if (command === "" || command === "help" || rest.includes("--help")) {
    console.log(USAGE);
    return command === "" && !rest.includes("--help") ? EXIT.usage : EXIT.ok;
  }

  // `--host` named the console for every command of the earlier tool. The
  // setup still takes it; elsewhere it is one more place to send beacons.
  if (command !== "setup" && command !== "pair") {
    const host = take(rest, "--host", true);
    if (typeof host === "string") rest.push("--unicast", host);
  }

  if (command === "pair" || command === "setup") {
    if (take(rest, "--rotate", false)) console.error("3ds-dev: --rotate is gone: a setup writes a new key only when the card holds none of this computer's (forget the console first to replace one)");
    return await link(["setup", ...rest]);
  }
  if (command === "discover") return await link(["devices", ...rest]);

  if (command === "push") {
    const explicit = take(rest, "--package", true);
    const app = take(rest, "--app", true);
    const file = typeof explicit === "string" ? existing(explicit, "package") : rest.find((word) => word.endsWith(".pocket")) ? null : await buildPackage(typeof app === "string" ? app : "3ds-demo");
    return explain(await link(["push", ...(file === null ? [] : [file]), ...rest]));
  }
  if (command === "install") {
    if (take(rest, "--ftp", false)) fail("install --ftp is gone: copy the .3dsx to sdmc:/3ds/ with any FTP client while ftpd runs, or install over the link");
    const explicit = take(rest, "--file", true);
    const app = take(rest, "--app", true);
    const file = typeof explicit === "string" ? existing(explicit, ".3dsx") : rest.find((word) => word.endsWith(".3dsx")) ? null : await buildNative(typeof app === "string" ? app : "3ds-demo");
    return explain(await link(["install", ...(file === null ? [] : [file]), ...rest]));
  }
  if (command === "probe") {
    const out = take(rest, "--out", true);
    const status = explain(await link(["status", ...rest]));
    if (status !== EXIT.ok) return status;
    return await link(["shot", ...(typeof out === "string" ? ["--out", out] : []), ...rest]);
  }
  if (command === "dev") return await dev(rest);
  return explain(await link([command, ...rest]));
}

/** Stay linked with the DevTools panel: `serve --panel` in this process, and the build steps on keys. */
async function dev(rest: string[]): Promise<number> {
  const explicit = take(rest, "--package", true);
  const file = take(rest, "--file", true);
  const app = take(rest, "--app", true);
  const noPush = take(rest, "--no-push", false) === true;
  const name = typeof app === "string" ? app : "3ds-demo";
  const home = (() => {
    const at = rest.indexOf("--home");
    return at >= 0 && rest[at + 1] !== undefined ? rest[at + 1]! : linkHome();
  })();
  let panelUrl = "";
  const serving = link(["serve", "--panel", ...rest], {
    out: (line) => {
      const found = /panel: (\S+)/.exec(line);
      if (found) panelUrl = found[1]!;
      console.log(line);
    },
    err: (line) => console.error(line),
  });
  // The other commands reach the serve through its socket (cli.ts delegate).
  const socket = join(home, "serve.sock");
  for (const end = Date.now() + 10_000; !existsSync(socket) && Date.now() < end; ) await Bun.sleep(50);
  if (!existsSync(socket)) return await serving;

  const step = (label: string, work: () => Promise<number>) => {
    void work().then(
      (code) => {
        if (code !== EXIT.ok) console.error(`3ds-dev: ${label} ended with exit code ${explain(code)}`);
      },
      (error) => console.error(`3ds-dev: ${label}: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  const rebuild = async () => link(["push", typeof explicit === "string" ? existing(explicit, "package") : await buildPackage(name), "--wait", "120"]);
  const reinstall = async () => link(["install", typeof file === "string" ? existing(file, ".3dsx") : await buildNative(name), "--wait", "120"]);
  const screenshot = async () => {
    const out = join(ROOT, ".pocket-build/3ds", `screenshot-${Date.now()}.png`);
    mkdirSync(dirname(out), { recursive: true });
    return link(["shot", "--out", out]);
  };
  if (!noPush) step("push", rebuild);

  console.log("keys: r rebuild+push · i install .3dsx+restart · s screenshot · o open panel · q quit");
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "q" || key === "\x03") process.kill(process.pid, "SIGINT");
      if (key === "r") step("push", rebuild);
      if (key === "i") step("install", reinstall);
      if (key === "s") step("screenshot", screenshot);
      if (key === "o" && panelUrl !== "") void $`open ${panelUrl}`.nothrow().quiet();
    });
  }
  const code = await serving;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  return code;
}

if (import.meta.main) {
  try {
    process.exit(await run(Bun.argv.slice(2)));
  } catch (error) {
    console.error(`3ds-dev: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT.failed);
  }
}
