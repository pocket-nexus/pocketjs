import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encodeIdentity, encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { encodePNG } from "./png.ts";
import { prepareVitaUsb } from "./vita-usb.ts";
import { atomicWrite, VitaUsbClient } from "./vita-dev-client.ts";

const ROOT = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const command = args[0];
function value(flag: string): string | undefined {
  const inline = args.find(a => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}
const app = value("--app") ?? "hero";
const output = app.endsWith("-main") ? app : `${app}-main`;
const metadataPath = resolve(value("--runtime") ?? join(ROOT, "dist/vita", `${output}.runtime.json`));
function metadata(): any { return JSON.parse(readFileSync(metadataPath, "utf8")); }
const share = resolve(value("--dir") ?? join(ROOT, ".pocket-build/vita-usb/share"));

async function run(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`command failed: ${argv.join(" ")}`);
}

function capture(client: VitaUsbClient, receipt: any, stem = receipt.requestId): string {
  if (receipt.source !== "GXM" || receipt.width !== 960 || receipt.height !== 544 || receipt.stride !== 960) throw new Error("unexpected capture geometry/source");
  const pixels = Buffer.from(readFileSync(join(client.directory, `${receipt.requestId}.rgba`)));
  if (pixels.length !== 960 * 544 * 4) throw new Error("incomplete GXM capture");
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const out = resolve(value("--out") ?? join(ROOT, ".pocket-build/validation/vita-usb", stem, "frame.png"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePNG(pixels, 960, 544));
  writeFileSync(`${out}.json`, JSON.stringify(receipt, null, 2) + "\n");
  return out;
}

async function main(): Promise<void> {
  if (!command || args.includes("--help")) {
    console.log(`Vita wired debugging (no Wi-Fi fallback)
  bun run vita:dev build   --app hero
  bun run vita:dev install --app hero --mount /Volumes/PSV
  bun run vita:dev serve   --app hero
  bun run vita:dev status  --app hero
  bun run vita:dev push    --app hero [--package file.pocket]
  bun run vita:dev native  --app hero [--runtime file.runtime.json]
  bun run vita:dev capture --app hero [--out frame.png]
  bun run vita:dev reload|reset|menu --app hero
  bun run vita:dev watch   --app hero
Use --title TITLEID to address a runtime and --dir to select the USB share.
Install stages a VPK over USB mass storage; install/open it once in VitaShell.
serve then owns the USB host. push rebuilds JS/PAK; native sends the SELF and
requires a receipt from the replacement process. L+R+SELECT opens the menu.`);
    return;
  }
  if (command === "build") { await run(["bun", "tools/vita.ts", app, "--release"]); return; }
  const info = existsSync(metadataPath) ? metadata() : undefined;
  const title = value("--title") ?? info?.titleId;
  if (!title) throw new Error("build the Vita app first, or supply --title");
  const client = new VitaUsbClient(share, title, 60_000);
  if (command === "install") {
    if (!info?.output) throw new Error("install needs the runtime metadata from a Vita build");
    const mount = value("--mount");
    if (!mount || !existsSync(join(mount, "VitaShell"))) throw new Error("--mount must identify the VitaShell USB volume");
    const source = join(dirname(metadataPath), `${info.output}.vpk`);
    const dest = join(mount, "data/pocketjs-dev", `${info.output}.vpk`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    if (hash(source) !== hash(dest)) throw new Error("USB storage readback differs");
    console.log(`Staged and read back ${dest}\nSHA-256 ${hash(dest)}\nEject USB storage, install this VPK in VitaShell, then open its LiveArea bubble.`);
    return;
  }
  if (command === "serve") {
    const tools = await prepareVitaUsb({ host: true });
    mkdirSync(share, { recursive: true });
    const lock = join(share, "serve.lock");
    try { mkdirSync(lock); } catch { throw new Error(`USB host already owns ${share}; stop it before starting another`); }
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let captures: ReturnType<typeof setInterval> | undefined;
    try {
      client.startSession();
      child = Bun.spawn([tools.host, "-t", "2000", share], { cwd: share, stdin: "pipe", stdout: "inherit", stderr: "inherit" });
      const stop = () => child?.kill();
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      console.log(`USB host serving ${title} from ${share}; waiting for Pocket Runtime`);
      let lastCapture = "";
      captures = setInterval(() => {
        try {
          const receipt = JSON.parse(readFileSync(join(client.directory, "menu-capture.json"), "utf8"));
          const key = `${receipt.nativeBuild}:${receipt.generation}:${receipt.frame}`;
          if (key !== lastCapture) {
            console.log(capture(client, { ...receipt, requestId: "menu-capture" }, `menu-${Date.now()}`));
            lastCapture = key;
          }
        } catch { /* No completed menu capture yet. */ }
      }, 250);
      await child.exited;
    } finally { if (captures) clearInterval(captures); rmSync(lock, { recursive: true, force: true }); }
    return;
  }
  if (command === "status") { console.log(JSON.stringify(await client.command("status"), null, 2)); return; }
  if (command === "capture") { console.log(capture(client, await client.command("capture"))); return; }
  if (command === "reload" || command === "reset" || command === "menu") { console.log(JSON.stringify(await client.command(command), null, 2)); return; }
  if (command === "native") {
    if (!info?.usbDebug || info.titleId !== title) throw new Error("replacement must enable USB debugging and match the installed title");
    if (!/^[0-9a-f]{32}$/.test(info.nativeBuild) || !/^[\w.-]+\.self$/.test(info.self)) throw new Error("invalid native build metadata");
    const payload = readFileSync(join(dirname(metadataPath), info.self));
    if (createHash("sha256").update(payload).digest("hex") !== info.selfSha256) throw new Error("SELF does not match its build metadata");
    const result = await client.command("native", { payload, build: info.nativeBuild });
    console.log(JSON.stringify(result, null, 2)); return;
  }
  async function push() {
    let payload: Uint8Array;
    const packagePath = value("--package");
    if (packagePath) payload = readFileSync(packagePath);
    else {
      if (!info?.plan) throw new Error("push needs a build plan or --package");
      mkdirSync(client.directory, { recursive: true });
      const planPath = join(client.directory, "build.plan.json");
      atomicWrite(planPath, JSON.stringify(info.plan));
      await run(["bun", "tools/build.ts", `--plan=${planPath}`, `--project-root=${value("--project-root") ?? ROOT}`]);
      const dist = join(ROOT, "dist");
      payload = encodePocketPackage({ manifest: Buffer.from(JSON.stringify({ id: info.applicationId })), variants: [{ target: "vita", hostAbi: 2,
        sections: [
          { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: info.output, id: info.applicationId, title: info.plan.app.title }) },
          { kind: POCKET_SECTION.plan, bytes: Buffer.from(JSON.stringify(info.plan)) },
          { kind: POCKET_SECTION.js, bytes: Buffer.concat([readFileSync(join(dist, `${info.output}.js`)), Buffer.from([0])]) },
          { kind: POCKET_SECTION.pak, bytes: readFileSync(join(dist, `${info.output}.pak`)) },
        ] }] });
    }
    console.log(JSON.stringify(await client.command("push", { payload }), null, 2));
  }
  if (command === "push") { await push(); return; }
  if (command === "watch") {
    const directory = resolve(value("--watch-dir") ?? join(ROOT, "apps", app.replace(/-main$/, "")));
    function stamp(path: string): string {
      return readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))
        .map(e => e.isDirectory() ? stamp(join(path, e.name)) : `${e.name}:${statSync(join(path, e.name)).mtimeMs}`).join("|");
    }
    let previous = "";
    console.log(`Watching ${directory}; JS/resources reload after each successful build`);
    for (;;) {
      const next = stamp(directory);
      if (next !== previous) {
        try { await push(); previous = next; }
        catch (e) { console.error(String(e)); await Bun.sleep(2000); }
      }
      await Bun.sleep(500);
    }
  }
  throw new Error(`unknown Vita debug command: ${command}`);
}

if (import.meta.main) await main().catch(error => { console.error(`vita:dev: ${error.message}`); process.exitCode = 1; });
