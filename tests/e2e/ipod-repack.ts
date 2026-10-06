// A game repacked onto the generic iPod touch 4 runtime, installed, started
// and captured.
//
//   bun tests/e2e/ipod-repack.ts --manifest <pocket.json> --id <id> --title <title>
//     --author <author> --version <version> [--icon <png>] [--out <dir>] [--device]
//
// Builds the game's ipodtouch4-dev variant into a `.pocket` (the manifest's
// project is its directory), repacks it onto dist/runtime/ipod (built by
// `bun tools/runtime.ts ipod`) and, with --device, installs the .ipa through
// `tools/ipodtouch4.ts deploy --ipa` (AppSync Unified, byte-exact readback of
// every bundle file), launches it, waits for a running status record from the
// runtime's build and captures the presented frame. The iPod is the one
// POCKETJS_IPODTOUCH4_UDID names; its keys come from
// ~/.cache/pocket-nexus/ipodtouch4/ssh/<udid>/ unless POCKETJS_IPODTOUCH4_KEY
// says otherwise. Run it under the device lease.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { encodePocketPackage } from "../../contracts/spec/pocket-package.ts";
import { canonicalJson } from "../../framework/src/manifest/plan.ts";
import { resolveIPodTouch4BuildPlan } from "../../tools/ipodtouch4-profile.ts";
import { makeVariant } from "../../tools/pocket-pack.ts";
import { readRuntimeDirectory } from "../../tools/repack.ts";
import { repackIPod } from "../../tools/repack/ipod.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const argv = Bun.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const manifestPath = option("manifest");
const identity = { id: option("id") ?? "", title: option("title") ?? "", author: option("author") ?? "", version: option("version") ?? "" };
if (!manifestPath || Object.values(identity).some((value) => !value)) {
  throw new Error("usage: bun tests/e2e/ipod-repack.ts --manifest <pocket.json> --id … --title … --author … --version … [--icon png] [--out dir] [--device]");
}
const run = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(option("out") ?? join(ROOT, ".pocket-build/validation/runtime-ipod", run));
mkdirSync(OUT, { recursive: true });
const transcript: string[] = [];
const log = (line: string) => {
  console.log(line);
  transcript.push(line);
};

async function command(args: string[], env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(args, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}\n${stdout}${stderr}`);
  return stdout.trim();
}

try {
  // The game's ipodtouch4-dev variant, built from its own project.
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const plan = resolveIPodTouch4BuildPlan(manifest);
  const planFile = join(OUT, "plan.json");
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const guest = join(OUT, "guest");
  await command(["bun", "tools/build.ts", `--plan=${planFile}`, `--project-root=${dirname(resolve(manifestPath))}`, `--outdir=${guest}`]);
  const pocket = encodePocketPackage({
    manifest: new Uint8Array(readFileSync(manifestPath)),
    variants: [
      makeVariant({
        target: plan.target.id,
        hostAbi: plan.target.hostAbi,
        planJson: canonicalJson(plan),
        identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
        js: new Uint8Array(readFileSync(join(guest, `${plan.app.output}.js`))),
        pak: new Uint8Array(readFileSync(join(guest, `${plan.app.output}.pak`))),
      }),
    ],
  });
  writeFileSync(join(OUT, "game.pocket"), pocket);
  log(`pocket ${pocket.length} bytes, ${plan.viewport.logical.join("x")} at density ${plan.viewport.rasterDensity}`);

  const icon = option("icon");
  const runtime = readRuntimeDirectory(join(ROOT, "dist/runtime/ipod"));
  const started = performance.now();
  const ipa = await repackIPod({ runtime, pocket, identity: { ...identity, ...(icon ? { icon: new Uint8Array(readFileSync(icon)) } : {}) } });
  log(`repacked ${ipa.length} bytes in ${(performance.now() - started).toFixed(0)} ms`);
  const ipaPath = join(OUT, "game.ipa");
  writeFileSync(ipaPath, ipa);

  if (argv.includes("--device")) {
    const udid = process.env.POCKETJS_IPODTOUCH4_UDID ?? "";
    if (!/^[0-9a-f]{40}$/.test(udid)) throw new Error("set POCKETJS_IPODTOUCH4_UDID to the iPod's UDID");
    const keys = join(homedir(), ".cache/pocket-nexus/ipodtouch4/ssh", udid);
    const env = {
      POCKETJS_IPODTOUCH4_KEY: process.env.POCKETJS_IPODTOUCH4_KEY ?? join(keys, "id_rsa"),
      POCKETJS_IPODTOUCH4_KNOWN_HOSTS: process.env.POCKETJS_IPODTOUCH4_KNOWN_HOSTS ?? join(keys, "known_hosts"),
    };
    log((await command(["bun", "tools/ipodtouch4.ts", "deploy", "--ipa", ipaPath], env)).split("\n").at(-1)!);
    const status = await command(["bun", "tools/ipodtouch4.ts", "launch", "--ipa", ipaPath], env);
    writeFileSync(join(OUT, "status.json"), `${status}\n`);
    const parsed = JSON.parse(status.slice(status.indexOf("{"))) as Record<string, unknown>;
    log(`status state=${parsed.state} renderer=${parsed.renderer} ${parsed.drawable_width}x${parsed.drawable_height}@${parsed.raster_density} frames=${parsed.guest_frames} build=${parsed.build_id}`);
    await command(["bun", "tools/ipodtouch4.ts", "capture", "--ipa", ipaPath], env);
    copyFileSync(join(ROOT, "dist/ipodtouch4/device-frame.png"), join(OUT, "device-frame.png"));
    log(`frame ${join(OUT, "device-frame.png")}`);
  }
  log("PASS");
} catch (error) {
  log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, "transcript.txt"), `${transcript.join("\n")}\n`);
}
