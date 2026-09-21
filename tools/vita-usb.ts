import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const VITA_USB_REVISION = "074283858c15ae2ffbac79807d7b06680ce3f9bd";
export const VITA_USB_PID = 0x0f01;
const root = resolve(import.meta.dir, "..");

async function run(argv: string[], cwd = root, env = process.env): Promise<void> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Vita USB build failed: ${argv.join(" ")}`);
}

/** Build the pinned USB driver and its matching host, without a boot plugin install. */
export async function prepareVitaUsb(options: { host?: boolean } = {}) {
  const cache = join(root, ".pocket-build/toolchains/vita-usb");
  const source = join(cache, "source");
  const patch = join(root, "tools/vita-usb/usbhostfs.patch");
  const fingerprint = createHash("sha256").update(VITA_USB_REVISION).update(readFileSync(patch)).digest("hex");
  mkdirSync(cache, { recursive: true });
  if (!existsSync(join(source, ".git"))) {
    await run(["git", "clone", "https://github.com/Cpasjuste/usbhostfs.git", source]);
  }
  const stamp = join(cache, "source.sha256");
  if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== fingerprint) {
    // This checkout is an owned build cache, never the developer's checkout.
    await run(["git", "checkout", "--force", VITA_USB_REVISION], source);
    await run(["git", "apply", patch], source);
    writeFileSync(stamp, fingerprint);
  }
  const sdk = process.env.VITASDK ?? join(process.env.HOME!, "vitasdk");
  const build = join(cache, "build");
  await run(["cmake", "-S", join(source, "usbhostfs"), "-B", build, "-DCMAKE_POLICY_VERSION_MINIMUM=3.5"], root, { ...process.env, VITASDK: sdk });
  await run(["cmake", "--build", build, "-j4"]);
  // Kernel-private library NIDs vary by firmware. Keep them out of the SELF's
  // static dependencies: hooks_io resolves the supported exports at startup.
  const imports = Bun.spawnSync([join(sdk, "bin/arm-vita-eabi-readelf"), "-SW", join(build, "usbhostfs")],
    { stdout: "pipe", stderr: "pipe" });
  if (imports.exitCode !== 0) throw new Error("cannot inspect Vita USB driver imports");
  if (/\.vitalink\.fstubs\.SceSysmemForKernel\b/.test(imports.stdout.toString())) {
    throw new Error("Vita USB driver statically imports firmware-specific SceSysmemForKernel");
  }
  const host = join(cache, "pocket-vita-usbhostfs");
  if (options.host) {
    const pkg = Bun.spawnSync(["pkg-config", "--cflags", "--libs", "libusb"], { stdout: "pipe", stderr: "pipe" });
    if (pkg.exitCode !== 0) throw new Error("Vita USB host needs libusb-compat and pkg-config (macOS: brew install libusb-compat pkgconf)");
    await run([process.env.CC ?? "cc", "-O2", "-DPC_SIDE", "-D_FILE_OFFSET_BITS=64", "-include", "dirent.h", "-include", "limits.h",
      `-I${join(source, "usbhostfs")}`, join(source, "usbhostfs_pc/main.c"), join(source, "usbhostfs_pc/hostfs.c"),
      ...pkg.stdout.toString().trim().split(/\s+/), "-lpthread", "-o", host]);
  }
  return { driver: join(build, "usbhostfs.skprx"), host, fingerprint };
}

if (import.meta.main) console.log(JSON.stringify(await prepareVitaUsb({ host: true }), null, 2));
