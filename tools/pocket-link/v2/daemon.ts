// Daemon modules for the reference Hub's `serve` (docs/POCKET-LINK.md §7.7):
// the computer side of one applet, loaded from a file named on the command
// line as `--daemon <applet id>=<module.ts>`.
//
// A module's default export is a daemon, or a function that makes one:
//
//   import type { DaemonFactory } from "…/tools/pocket-link/v2/daemon.ts";
//   const daemon: DaemonFactory = ({ log }) => ({
//     attach(channel, info) {
//       channel.on("echo", (args) => ({ echo: args }));
//       channel.onClose((reason) => log(`generation ${info.generation} closed: ${reason}`));
//     },
//   });
//   export default daemon;
//
// `attach` runs once per accepted channel, with the channel's end of §7.3
// (`request`, `on`, `emit`, `emitStream`, `onEvent`, stream handles,
// `state()`, `onClose`) and the device id, applet id, package hash and
// generation Hub vouches for. `ready`, when a daemon has one, holds the
// `channel.open` REPLY until it resolves; `stop` is called when an open was
// cancelled or timed out while the daemon was starting.

import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LINK2_APP_ID_BYTES } from "../../../contracts/spec/link2.ts";
import type { DaemonInfo, Daemon as LinkDaemon } from "./hub.ts";
import type { AppletChannel } from "./peer.ts";

export type { AppletChannel, DaemonInfo, LinkDaemon };

export interface DaemonContext {
  /** The applet id the module was named for. */
  app: string;
  /** One line to the command's output, under the applet id. */
  log(line: string): void;
  /** A folder for the daemon's own files, mode 0700: `<store>/daemons/<applet id>/`. */
  data: string;
}
export type DaemonFactory = (context: DaemonContext) => LinkDaemon | Promise<LinkDaemon>;
export interface DaemonModule {
  default: DaemonFactory | LinkDaemon;
}

const APP_ID = /^[A-Za-z0-9._-]+$/;

/** `<applet id>=<module path>` as the command line gives it. */
export function parseDaemonSpec(spec: string): { app: string; path: string } | null {
  const at = spec.indexOf("=");
  if (at <= 0 || at === spec.length - 1) return null;
  const app = spec.slice(0, at);
  if (!APP_ID.test(app) || app.length > LINK2_APP_ID_BYTES) return null;
  return { app, path: spec.slice(at + 1) };
}

/** Loads one daemon module and makes its daemon. Throws with the module's path when it exports none. */
export async function loadDaemon(app: string, path: string, options: { cwd: string; home: string; log: (line: string) => void }): Promise<LinkDaemon> {
  const file = resolve(options.cwd, path);
  const loaded = (await import(pathToFileURL(file).href)) as Partial<DaemonModule>;
  const exported = loaded.default;
  const data = join(options.home, "daemons", app);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  chmodSync(data, 0o700);
  const daemon = typeof exported === "function" ? await exported({ app, log: options.log, data }) : exported;
  if (daemon === undefined || daemon === null || typeof daemon.attach !== "function") {
    throw new Error(`${file} exports no daemon: its default export is a daemon with attach(), or a function that returns one`);
  }
  return daemon;
}
