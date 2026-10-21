// tools/devtools-psp.ts — standalone CLI for the PSPLINK mailbox bridge
// (docs/DEVTOOLS.md §3). Prefer `bun run devtools` (tools/devtools.ts), which
// embeds this bridge AND the panel server in one process; this wrapper
// exists for running the bridge against a hub you started elsewhere.
//
//   --dir <path>   usbhostfs root the PSP mounts as host0:
//                  (default: dist/psplink — the `bun psplink` share;
//                   for `bun run hw` pass programs/psp/target/mipsel-sony-psp/release)
//   --port <n>     dev-server port (default 8130 / PORT env)

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startBridge } from "./devtools-bridge.ts";

const ROOT = new URL("..", import.meta.url).pathname;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = resolve(argValue("--dir") ?? join(ROOT, "dist", "psplink"));
const port = Number(argValue("--port") ?? process.env.PORT ?? 8130);

if (!existsSync(dir)) {
  console.error(
    `devtools-psp: ${dir} does not exist — start usbhostfs first (bun psplink / bun run hw), or pass --dir`,
  );
  process.exit(1);
}

const bridge = startBridge({
  dir,
  port,
  onEvent(e) {
    if (e.type === "hub-connected") console.log(`devtools-psp: connected to hub ws://127.0.0.1:${port}/ws`);
    if (e.type === "device-talking")
      console.log(`devtools-psp: device is talking — open the panel at http://127.0.0.1:${port}/devtools`);
    if (e.type === "hello") console.log(`devtools-psp: app "${e.detail}" said hello`);
    if (e.type === "screenshot") console.log(`devtools-psp: screenshot served (${e.detail})`);
    if (e.type === "bundle-ok") console.log(`devtools-psp: bundle verified — ${e.detail}`);
    if (e.type === "bundle-silent") console.error(`devtools-psp: *** BUNDLE UNVERIFIED *** ${e.detail}`);
    if (e.type === "bundle-mismatch")
      console.error(
        `devtools-psp: *** STALE EMBED *** ${e.detail}\n` +
          "devtools-psp: the device is NOT running the code in dist/ — rebuild the EBOOT and reload before trusting anything you observe.",
      );
  },
});

console.log(`devtools-psp: mailbox ready at ${bridge.boxDir}`);
console.log("devtools-psp: (re)launch the app now — it probes host0:/pocketjs-dbg/enable at boot");

function cleanup() {
  bridge.stop();
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
